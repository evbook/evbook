import type { CarAttrs, ChargeAttrs, PositionAttrs, TyreAttrs } from "../core/tesla/payload";
import { estimateDriveOrigin, type ParkedPoint } from "../core/driveOrigin";
import {
  calculateEnergyAdded,
  calculateEnergyUsed,
  modalFastChargerType,
  type ChargeSample,
} from "../core/derive/energy";
import { calculateCostRange, type GeofenceCostRule } from "../core/derive/cost";
import { findGeofence, type GeofenceLike } from "../core/geo/geofence";
import {
  POI_RADIUS_M,
  ownPoiCategory,
  poiLookup,
  reverseLookup,
  type AddressAttrs,
  type PoiResult,
} from "../core/geo/nominatim";
import {
  MAX_BATCH,
  keyOf,
  keyToCoordinate,
  lookupElevations,
  terrainKey,
  type TerrainKey,
} from "../core/geo/elevation";
import type { SqlDatabase, SqlStatement } from "../platform/ports";

/**
 * D1 write layer. Multi-statement writes use `batch()` (atomic in D1) since
 * there are no interactive transactions.
 */

const POSITION_COLUMNS = [
  "date_at",
  "latitude",
  "longitude",
  "speed",
  "power",
  "odometer",
  "elevation",
  "ideal_battery_range_km",
  "rated_battery_range_km",
  "est_battery_range_km",
  "battery_level",
  "usable_battery_level",
  "outside_temp",
  "inside_temp",
  "fan_status",
  "driver_temp_setting",
  "passenger_temp_setting",
  "is_climate_on",
  "is_rear_defroster_on",
  "is_front_defroster_on",
  "battery_heater",
  "battery_heater_on",
  "battery_heater_no_power",
  "tpms_pressure_fl",
  "tpms_pressure_fr",
  "tpms_pressure_rl",
  "tpms_pressure_rr",
] as const satisfies readonly (keyof PositionAttrs)[];

const TYRE_COLUMNS = [
  "date_at",
  "pressure_fl",
  "pressure_fr",
  "pressure_rl",
  "pressure_rr",
  "recommended_front",
  "recommended_rear",
  "soft_warning_fl",
  "soft_warning_fr",
  "soft_warning_rl",
  "soft_warning_rr",
  "hard_warning_fl",
  "hard_warning_fr",
  "hard_warning_rl",
  "hard_warning_rr",
] as const satisfies readonly (keyof TyreAttrs)[];

const CHARGE_COLUMNS = [
  "date_at",
  "battery_heater",
  "battery_heater_on",
  "battery_heater_no_power",
  "battery_level",
  "usable_battery_level",
  "charge_energy_added",
  "charger_actual_current",
  "charger_phases",
  "charger_pilot_current",
  "charger_power",
  "charger_voltage",
  "conn_charge_cable",
  "fast_charger_present",
  "fast_charger_brand",
  "fast_charger_type",
  "ideal_battery_range_km",
  "rated_battery_range_km",
  "not_enough_power_to_heat",
  "outside_temp",
  "battery_temp_min",
  "battery_temp_max",
] as const satisfies readonly (keyof ChargeAttrs)[];

/**
 * Rows per D1 statement or batch. The terrain lookup binds two parameters per
 * row, so this keeps the widest of these queries inside D1's bound-parameter
 * ceiling with room to spare.
 */
const D1_BATCH = 50;

/**
 * What one drive close may spend on terrain lookups. Driving is polled every
 * 2.5 s, so a day's road trip is thousands of distinct coordinates, and the
 * lookups run inside the Durable Object that is closing the drive — where a
 * terrain service that has stopped answering would otherwise hold the close open
 * for its timeout, once per batch, for as long as the coordinates last.
 *
 * Hitting either bound leaves the rest of the drive without elevation rather
 * than delaying the close. The coordinates that did resolve are still written and
 * still cached, so driving the same road again picks up where this left off.
 */
const ELEVATION_MAX_REQUESTS = 40;
const ELEVATION_BUDGET_MS = 20_000;

/** D1 rejects booleans; store them as 0/1. */
function bind(value: unknown): string | number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value as string | number | null;
}

/** Energy a session's first sample must already show for its start to have gone unseen. */
const MIN_UNSEEN_KWH = 0.1;

export class Repo {
  constructor(
    /** Protected so the import's subclass can reuse the same connection. */
    protected db: SqlDatabase,
    private carId: number,
    /** Fixture geocoder for local runs; empty or omitted means real Nominatim. */
    private geocoderBaseUrl?: string,
    /** Fixture terrain service for local runs; empty or omitted means real Open-Meteo. */
    private elevationBaseUrl?: string,
  ) {}

  // ---- states ----

  /** Close any open state row and open a new one unless it is already current. */
  async startState(state: "online" | "asleep" | "offline", at: number): Promise<void> {
    const open = await this.db
      .prepare("SELECT id, state, start_date_at FROM states WHERE car_id = ? AND end_date_at IS NULL")
      .bind(this.carId)
      .first<{ id: number; state: string; start_date_at: number }>();

    if (open?.state === state) return;

    const statements: SqlStatement[] = [];
    if (open) {
      // Clamp to start_date_at so the CHECK(end >= start) constraint holds even
      // if the car reports a timestamp older than the state's start.
      statements.push(
        this.db.prepare("UPDATE states SET end_date_at = MAX(?, start_date_at) WHERE id = ?").bind(at, open.id),
      );
    }
    statements.push(
      this.db.prepare("INSERT INTO states (car_id, state, start_date_at) VALUES (?, ?, ?)").bind(this.carId, state, at),
    );
    await this.db.batch(statements);
  }

  // ---- car ----

  async updateCar(attrs: CarAttrs): Promise<void> {
    await this.db
      .prepare(
        "UPDATE cars SET model = COALESCE(?, model), trim_badging = COALESCE(?, trim_badging), " +
          "exterior_color = COALESCE(?, exterior_color), wheel_type = COALESCE(?, wheel_type), " +
          "spoiler_type = COALESCE(?, spoiler_type), name = COALESCE(?, name), updated_at = ? WHERE id = ?",
      )
      .bind(
        attrs.model,
        attrs.trim_badging,
        attrs.exterior_color,
        attrs.wheel_type,
        attrs.spoiler_type,
        attrs.name,
        Date.now(),
        this.carId,
      )
      .run();
  }

  async getCarSettings(): Promise<{
    suspend_min: number;
    suspend_after_idle_min: number;
    req_not_unlocked: boolean;
    free_supercharging: boolean;
    enabled: boolean;
  }> {
    const row = await this.db
      .prepare(
        "SELECT suspend_min, suspend_after_idle_min, req_not_unlocked, free_supercharging, enabled " +
          "FROM car_settings WHERE car_id = ?",
      )
      .bind(this.carId)
      .first<{
        suspend_min: number;
        suspend_after_idle_min: number;
        req_not_unlocked: number;
        free_supercharging: number;
        enabled: number;
      }>();
    return {
      suspend_min: row?.suspend_min ?? 21,
      suspend_after_idle_min: row?.suspend_after_idle_min ?? 15,
      req_not_unlocked: (row?.req_not_unlocked ?? 0) === 1,
      free_supercharging: (row?.free_supercharging ?? 0) === 1,
      enabled: (row?.enabled ?? 1) === 1,
    };
  }

  private async preferredRange(): Promise<"ideal" | "rated"> {
    const row = await this.db
      .prepare("SELECT preferred_range FROM settings WHERE id = 1")
      .first<{ preferred_range: string }>();
    return row?.preferred_range === "ideal" ? "ideal" : "rated";
  }

  // ---- positions ----

  /** Insert one or many positions. Returns the last inserted row id. */
  async insertPositions(rows: { driveId: number | null; attrs: PositionAttrs }[]): Promise<number | null> {
    if (rows.length === 0) return null;
    const columns = ["car_id", "drive_id", ...POSITION_COLUMNS];
    const placeholders = columns.map(() => "?").join(", ");
    const sql = `INSERT INTO positions (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`;

    const statements = rows.map((row) =>
      this.db.prepare(sql).bind(this.carId, row.driveId, ...POSITION_COLUMNS.map((c) => bind(row.attrs[c]))),
    );
    const results = await this.db.batch<{ id: number }>(statements);
    const last = results[results.length - 1]?.results?.[0];
    return last?.id ?? null;
  }

  // ---- tyres ----

  /**
   * One tyre reading. `OR IGNORE`: two snapshots carrying the same car timestamp
   * are the same reading, and the first one written stands.
   */
  async insertTyreReading(attrs: TyreAttrs): Promise<void> {
    const columns = ["car_id", ...TYRE_COLUMNS];
    const sql = `INSERT OR IGNORE INTO tyre_readings (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    await this.db
      .prepare(sql)
      .bind(this.carId, ...TYRE_COLUMNS.map((c) => bind(attrs[c])))
      .run();
  }

  // ---- drives ----

  /**
   * `firstSample` is the position that triggered the drive: when its odometer
   * shows the car already drove an unseen stretch (the poller was on the slow
   * clock when the drive began), the drive opens backdated at the car's last
   * recorded position instead — see core/driveOrigin.ts. The import replays
   * dense history and passes nothing, so it never reconstructs.
   */
  async openDrive(at: number, firstSample?: PositionAttrs, quietAt: number | null = null): Promise<number> {
    const origin = firstSample
      ? estimateDriveOrigin(await this.latestPositionBefore(firstSample.date_at), firstSample, quietAt)
      : null;
    // A span only when something went unseen: the odometer had moved by the
    // first sample, so the drive began somewhere between the last quiet reading
    // and it. A car that had not moved yet began moving at the first sample,
    // and the start stands as seen.
    const startAfter = origin?.startAfter ?? null;
    const row = await this.db
      .prepare(
        "INSERT INTO drives (car_id, start_date_at, start_after_at, start_before_at, origin_reconstructed) " +
          "VALUES (?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(this.carId, origin?.position.date_at ?? at, startAfter, startAfter != null ? at : null, origin ? 1 : 0)
      .first<{ id: number }>();
    if (!row) throw new Error("failed to open drive");
    if (origin) await this.insertPositions([{ driveId: row.id, attrs: origin.position }]);
    return row.id;
  }

  /**
   * Where the car last was before `at` — any position, a previous drive's end
   * included.
   *
   * Strictly before: a car found already driving when it wakes passes through
   * the state machine's `start` first, which records that same snapshot as a
   * parked row a moment before the drive opens. Taking "the latest row" read
   * that row back — the first sample itself, zero seconds old — and every drive
   * that began from sleep kept its mid-road start. The origin sweep has always
   * asked for the row before the first sample; this is the same question.
   */
  private async latestPositionBefore(at: number): Promise<ParkedPoint | null> {
    return await this.db
      .prepare(
        "SELECT date_at, latitude, longitude, odometer, elevation FROM positions " +
          "WHERE car_id = ? AND date_at < ? ORDER BY date_at DESC LIMIT 1",
      )
      .bind(this.carId, at)
      .first<ParkedPoint>();
  }

  /**
   * Aggregate the drive's positions and either update the drive row or delete it
   * (fewer than 2 positions, or under 10 m travelled) — TeslaMate's rule.
   */
  async closeDrive(
    driveId: number,
    seenAt?: number,
  ): Promise<{ deleted: boolean; distance: number | null; durationMin: number | null }> {
    const stats = await this.db
      .prepare(
        `WITH d AS (
           SELECT
             COUNT(*) OVER w AS cnt,
             FIRST_VALUE(id) OVER w AS start_position_id,
             LAST_VALUE(id) OVER w AS end_position_id,
             AVG(outside_temp) OVER w AS outside_temp_avg,
             AVG(inside_temp) OVER w AS inside_temp_avg,
             MAX(speed) OVER w AS speed_max,
             MAX(power) OVER w AS power_max,
             MIN(power) OVER w AS power_min,
             FIRST_VALUE(date_at) OVER w AS start_date_at,
             LAST_VALUE(date_at) OVER w AS end_date_at,
             FIRST_VALUE(odometer) OVER w AS start_km,
             LAST_VALUE(odometer) OVER w AS end_km
           FROM positions WHERE drive_id = ?1
           WINDOW w AS (ORDER BY date_at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
           LIMIT 1
         ),
         r AS (
           SELECT
             FIRST_VALUE(ideal_battery_range_km) OVER w AS start_ideal_range_km,
             LAST_VALUE(ideal_battery_range_km) OVER w AS end_ideal_range_km,
             FIRST_VALUE(rated_battery_range_km) OVER w AS start_rated_range_km,
             LAST_VALUE(rated_battery_range_km) OVER w AS end_rated_range_km
           FROM positions
           WHERE drive_id = ?1 AND ideal_battery_range_km IS NOT NULL AND odometer IS NOT NULL
           WINDOW w AS (ORDER BY date_at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
           LIMIT 1
         )
         SELECT d.*, r.start_ideal_range_km, r.end_ideal_range_km,
                r.start_rated_range_km, r.end_rated_range_km
         FROM d LEFT JOIN r ON 1 = 1`,
      )
      .bind(driveId)
      .first<{
        cnt: number;
        start_position_id: number | null;
        end_position_id: number | null;
        outside_temp_avg: number | null;
        inside_temp_avg: number | null;
        speed_max: number | null;
        power_max: number | null;
        power_min: number | null;
        start_date_at: number | null;
        end_date_at: number | null;
        start_km: number | null;
        end_km: number | null;
        start_ideal_range_km: number | null;
        end_ideal_range_km: number | null;
        start_rated_range_km: number | null;
        end_rated_range_km: number | null;
      }>();

    const distance = stats?.end_km != null && stats.start_km != null ? stats.end_km - stats.start_km : null;

    if (!stats || stats.cnt < 2 || distance == null || distance < 0.01) {
      // Detach positions first so the FK does not null out a row we keep.
      await this.db.batch([
        this.db.prepare("UPDATE positions SET drive_id = NULL WHERE drive_id = ?").bind(driveId),
        this.db.prepare("DELETE FROM drives WHERE id = ?").bind(driveId),
      ]);
      return { deleted: true, distance: null, durationMin: null };
    }

    const durationMin =
      stats.end_date_at != null && stats.start_date_at != null
        ? Math.round((stats.end_date_at - stats.start_date_at) / 60_000)
        : null;

    const [startGeofence, endGeofence] = await Promise.all([
      this.geofenceForPosition(stats.start_position_id),
      this.geofenceForPosition(stats.end_position_id),
    ]);
    // Geocoding is best-effort; nulls are retried by the cron repair pass.
    const [startAddress, endAddress] = await Promise.all([
      this.addressForPosition(stats.start_position_id),
      this.addressForPosition(stats.end_position_id),
    ]);

    await this.db
      .prepare(
        "UPDATE drives SET start_date_at = COALESCE(?, start_date_at), end_date_at = ?, distance = ?, duration_min = ?, " +
          "speed_max = ?, power_max = ?, power_min = ?, start_km = ?, end_km = ?, " +
          "outside_temp_avg = ?, inside_temp_avg = ?, start_ideal_range_km = ?, end_ideal_range_km = ?, " +
          "start_rated_range_km = ?, end_rated_range_km = ?, start_position_id = ?, end_position_id = ?, " +
          "start_geofence_id = ?, end_geofence_id = ?, start_address_id = ?, end_address_id = ?, " +
          // A later reading that showed the drive over bounds its end. Kept
          // across a re-close (the origin sweep re-aggregates old drives) — only
          // a new one replaces it.
          "end_before_at = CASE WHEN ? > ? THEN ? ELSE end_before_at END WHERE id = ?",
      )
      .bind(
        stats.start_date_at,
        stats.end_date_at,
        distance,
        durationMin,
        stats.speed_max,
        stats.power_max,
        stats.power_min,
        stats.start_km,
        stats.end_km,
        stats.outside_temp_avg,
        stats.inside_temp_avg,
        stats.start_ideal_range_km,
        stats.end_ideal_range_km,
        stats.start_rated_range_km,
        stats.end_rated_range_km,
        stats.start_position_id,
        stats.end_position_id,
        startGeofence,
        endGeofence,
        startAddress,
        endAddress,
        seenAt ?? null,
        stats.end_date_at,
        seenAt ?? null,
        driveId,
      )
      .run();

    // After the drive row is settled, so a terrain service having a bad day
    // costs the drive its elevation profile and nothing else.
    await this.enrichElevations(driveId);

    return { deleted: false, distance, durationMin };
  }

  // ---- charging ----

  /** `quietAt`: the last reading that showed the car not charging, which bounds the start. */
  async openChargingProcess(at: number, position: PositionAttrs, quietAt: number | null = null): Promise<number> {
    const positionId = await this.insertPositions([{ driveId: null, attrs: position }]);
    const geofenceId = await this.geofenceForPoint(position);
    const addressId = await this.resolveAddress(position.latitude, position.longitude);
    const startAfter = quietAt != null && quietAt < at ? quietAt : null;
    const row = await this.db
      .prepare(
        "INSERT INTO charging_processes (car_id, start_date_at, position_id, geofence_id, address_id, " +
          "start_after_at, start_before_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(this.carId, at, positionId, geofenceId, addressId, startAfter, startAfter != null ? at : null)
      .first<{ id: number }>();
    if (!row) throw new Error("failed to open charging process");
    return row.id;
  }

  async insertCharges(cprocId: number, rows: ChargeAttrs[]): Promise<void> {
    if (rows.length === 0) return;
    const columns = ["charging_process_id", ...CHARGE_COLUMNS];
    const sql = `INSERT INTO charges (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    await this.db.batch(
      rows.map((attrs) => this.db.prepare(sql).bind(cprocId, ...CHARGE_COLUMNS.map((c) => bind(attrs[c])))),
    );
  }

  /** Aggregate a charging session, derive energy and cost, then refresh efficiency. */
  async completeChargingProcess(
    cprocId: number,
    seenAt?: number,
  ): Promise<{ energyAdded: number | null; durationMin: number | null }> {
    const samples = await this.db
      .prepare(
        "SELECT date_at, charger_power, charger_voltage, charger_actual_current, charger_phases, " +
          "charge_energy_added, fast_charger_type, battery_level, ideal_battery_range_km, " +
          "rated_battery_range_km, outside_temp FROM charges WHERE charging_process_id = ? ORDER BY date_at",
      )
      .bind(cprocId)
      .all<
        ChargeSample & {
          battery_level: number | null;
          ideal_battery_range_km: number | null;
          rated_battery_range_km: number | null;
          outside_temp: number | null;
        }
      >();

    const rows = samples.results;
    if (rows.length === 0) {
      await this.db
        .prepare("UPDATE charging_processes SET end_date_at = ? WHERE id = ?")
        .bind(Date.now(), cprocId)
        .run();
      return { energyAdded: null, durationMin: null };
    }

    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const energyAdded = calculateEnergyAdded(rows);
    const energyUsed = calculateEnergyUsed(rows);
    const durationMin = Math.round((last.date_at - first.date_at) / 60_000);
    const temps = rows.map((r) => r.outside_temp).filter((t): t is number => t != null);
    const outsideTempAvg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;

    const cproc = await this.db
      .prepare("SELECT geofence_id, start_after_at, end_before_at FROM charging_processes WHERE id = ?")
      .bind(cprocId)
      .first<{ geofence_id: number | null; start_after_at: number | null; end_before_at: number | null }>();
    const endBefore = seenAt != null && seenAt > last.date_at ? seenAt : (cproc?.end_before_at ?? null);
    // The start is a span only if the session was already under way at the
    // first sample; one that had added nothing yet began then.
    const startedUnseen = (first.charge_energy_added ?? 0) >= MIN_UNSEEN_KWH;
    const startAfter = startedUnseen ? (cproc?.start_after_at ?? null) : null;
    // Minutes a per-minute tariff may have billed: the samples' span at least,
    // the whole of both ends' spans at most.
    const longest = Math.round(
      (Math.max(endBefore ?? 0, last.date_at) - Math.min(startAfter ?? Infinity, first.date_at)) / 60_000,
    );

    let geofenceRule: GeofenceCostRule | null = null;
    if (cproc?.geofence_id != null) {
      geofenceRule = await this.db
        .prepare("SELECT billing_type, cost_per_unit, session_fee_cents FROM geofences WHERE id = ?")
        .bind(cproc.geofence_id)
        .first<GeofenceCostRule>();
    }

    const settings = await this.getCarSettings();
    const cost = calculateCostRange(
      {
        fastChargerType: modalFastChargerType(rows),
        freeSupercharging: settings.free_supercharging,
        energyAdded,
        energyUsed,
        durationMin,
        geofence: geofenceRule,
      },
      { durationMin: longest > durationMin ? { min: durationMin, max: longest } : null },
    );

    await this.db
      .prepare(
        "UPDATE charging_processes SET end_date_at = ?, charge_energy_added = ?, charge_energy_used = ?, " +
          "duration_min = ?, start_battery_level = ?, end_battery_level = ?, start_ideal_range_km = ?, " +
          "end_ideal_range_km = ?, start_rated_range_km = ?, end_rated_range_km = ?, outside_temp_avg = ?, " +
          // The range's top only alongside a derived bottom: a cost the owner
          // typed in is exact, and SET reads the row as it was before.
          "cost_max_cents = CASE WHEN cost_cents IS NULL THEN ? ELSE cost_max_cents END, " +
          "cost_cents = COALESCE(cost_cents, ?), end_before_at = ?, start_after_at = ?, " +
          "start_before_at = CASE WHEN ? IS NULL THEN NULL ELSE start_before_at END WHERE id = ?",
      )
      .bind(
        last.date_at,
        energyAdded,
        energyUsed,
        durationMin,
        first.battery_level,
        last.battery_level,
        first.ideal_battery_range_km,
        last.ideal_battery_range_km,
        first.rated_battery_range_km,
        last.rated_battery_range_km,
        outsideTempAvg,
        cost != null && cost.max !== cost.min ? cost.max : null,
        cost?.min ?? null,
        endBefore,
        startAfter,
        startAfter,
        cprocId,
      )
      .run();

    await this.recalculateEfficiency();
    return { energyAdded, durationMin };
  }

  /**
   * Create and immediately close a session inferred from an offline range gain.
   *
   * Nobody saw it, so it is recorded as reconstructed: it happened somewhere
   * between the last reading before the outage and the first after, and has no
   * duration — the two samples bracket the outage, not the charge.
   */
  async synthesizeChargingProcess(position: PositionAttrs, charges: ChargeAttrs[], at: number): Promise<void> {
    const cprocId = await this.openChargingProcess(at, position);
    await this.insertCharges(cprocId, charges);
    await this.completeChargingProcess(cprocId);
    const times = charges.map((c) => c.date_at);
    const after = Math.min(at, ...times);
    const before = Math.max(at, ...times);
    await this.db
      .prepare(
        "UPDATE charging_processes SET reconstructed = 1, duration_min = NULL, " +
          "start_date_at = ?1, end_date_at = ?2, start_after_at = ?1, start_before_at = ?2, " +
          "end_after_at = ?1, end_before_at = ?2 WHERE id = ?3",
      )
      .bind(after, before, cprocId)
      .run();
  }

  /**
   * Port of recalculate_efficiency/3: bucket completed sessions by
   * kWh-per-range-unit at decreasing precision and take the most common bucket
   * once it has been seen enough times.
   */
  async recalculateEfficiency(): Promise<void> {
    const preferred = await this.preferredRange();
    const startCol = preferred === "ideal" ? "start_ideal_range_km" : "start_rated_range_km";
    const endCol = preferred === "ideal" ? "end_ideal_range_km" : "end_rated_range_km";

    for (const [precision, threshold] of [
      [5, 8],
      [4, 5],
      [3, 3],
      [2, 2],
    ] as const) {
      const row = await this.db
        .prepare(
          `SELECT ROUND(charge_energy_added / NULLIF(${endCol} - ${startCol}, 0), ?) AS efficiency, COUNT(*) AS n
           FROM charging_processes
           WHERE car_id = ? AND duration_min > 10 AND end_battery_level <= 95
             AND ${endCol} IS NOT NULL AND ${startCol} IS NOT NULL AND charge_energy_added > 0
           GROUP BY efficiency ORDER BY n DESC LIMIT 1`,
        )
        .bind(precision, this.carId)
        .first<{ efficiency: number | null; n: number }>();

      if (row?.efficiency != null && row.n >= threshold) {
        await this.db
          .prepare("UPDATE cars SET efficiency = ?, updated_at = ? WHERE id = ?")
          .bind(row.efficiency, Date.now(), this.carId)
          .run();
        return;
      }
    }
  }

  // ---- updates ----

  async openUpdate(at: number): Promise<number> {
    const row = await this.db
      .prepare("INSERT INTO updates (car_id, start_date_at) VALUES (?, ?) RETURNING id")
      .bind(this.carId, at)
      .first<{ id: number }>();
    if (!row) throw new Error("failed to open update");
    return row.id;
  }

  async finishUpdate(updateId: number, version: string | null, at: number): Promise<void> {
    await this.db
      .prepare("UPDATE updates SET end_date_at = MAX(?, start_date_at), version = ? WHERE id = ?")
      .bind(at, version, updateId)
      .run();
  }

  async cancelUpdate(updateId: number): Promise<void> {
    await this.db.prepare("DELETE FROM updates WHERE id = ?").bind(updateId).run();
  }

  // ---- addresses ----

  /**
   * Called immediately before every outbound geocoding request.
   *
   * Nominatim asks for at most one request per second, and resolving one point
   * can now cost two — the address and the POI. Spacing them from here rather
   * than from the caller is what keeps that promise per *request* instead of per
   * point, which is the unit the policy is written in. A no-op for live logging,
   * where polls are minutes apart; the import overrides it.
   */
  protected async beforeGeocodeRequest(): Promise<void> {}

  /**
   * Reverse-geocode a point and return the address row id, reusing an existing
   * row when OSM reports the same place. Returns null if geocoding fails — the
   * cron repair pass retries those later, as TeslaMate's Repair worker does.
   */
  async resolveAddress(latitude: number | null, longitude: number | null): Promise<number | null> {
    if (latitude == null || longitude == null) return null;

    const language = await this.geocodeLanguage();
    await this.beforeGeocodeRequest();
    const address = await reverseLookup(latitude, longitude, language, this.geocoderBaseUrl);
    if (!address) return null;

    // Sometimes the first answer already is the POI: a coordinate inside a
    // footprint gets the thing itself, name, road and classification in one
    // response. Taking it as one means no second request — and no radius test,
    // which the POI layer's answer for something airport-sized can only fail.
    const own = ownPoiCategory(address);
    if (own) return this.storeAddress(address, own, true);

    // What is *there* beats the road it opens onto. A stop is remembered by the
    // petrol station or the supermarket, not by a street that in this case does
    // not even have a name — see POI_RADIUS_M for why the reach is bounded, and
    // why it is shorter when a real street address is the thing being displaced.
    const found = await this.resolvePoi(latitude, longitude, address, language);
    const poi = found.asked ? found.poi : null;
    return this.storeAddress(poi ?? address, poi?.poi_category ?? null, found.asked);
  }

  /**
   * The named thing at a point, if one is near enough to be where the car was.
   *
   * Skipped when the primary answer is already a POI — Nominatim returns one
   * directly whenever the coordinate falls inside its footprint, and asking again
   * would be a second request for an answer already in hand.
   */
  private async resolvePoi(
    latitude: number,
    longitude: number,
    address: AddressAttrs,
    language: string,
  ): Promise<PoiResult> {
    // Already a POI as far as the address layer is concerned; nothing to add.
    if (address.name && !address.road) return { asked: true, poi: null };
    const hasStreet = address.road != null;
    await this.beforeGeocodeRequest();
    return poiLookup(
      latitude,
      longitude,
      hasStreet ? POI_RADIUS_M.tight : POI_RADIUS_M.loose,
      language,
      this.geocoderBaseUrl,
    );
  }

  /**
   * Insert or reuse the row for one OSM object, and return its id.
   *
   * `poiAsked` records whether the POI layer actually answered. A row written
   * while the geocoder was rate-limiting is left unmarked so the sweep can come
   * back to it, rather than being retired on the strength of a 429.
   */
  private async storeAddress(
    address: AddressAttrs,
    poiCategory: string | null,
    poiAsked: boolean,
  ): Promise<number | null> {
    const existing = await this.db
      .prepare("SELECT id FROM addresses WHERE osm_id = ? AND osm_type = ?")
      .bind(address.osm_id, address.osm_type)
      .first<{ id: number }>();
    if (existing) {
      // A row first seen through the address layer and met again as a POI learns
      // what it is; the reverse never happens, so this only ever adds.
      if (poiCategory) {
        await this.db
          .prepare("UPDATE addresses SET poi_category = COALESCE(poi_category, ?) WHERE id = ?")
          .bind(poiCategory, existing.id)
          .run();
      }
      return existing.id;
    }

    const now = Date.now();
    const columns: (keyof AddressAttrs)[] = [
      "osm_id",
      "osm_type",
      "display_name",
      "name",
      "house_number",
      "road",
      "neighbourhood",
      "city",
      "county",
      "postcode",
      "state",
      "state_district",
      "country",
      "latitude",
      "longitude",
      "raw",
    ];
    const inserted = await this.db
      .prepare(
        `INSERT INTO addresses (${columns.join(", ")}, poi_category, poi_checked_at, inserted_at, updated_at) ` +
          `VALUES (${columns.map(() => "?").join(", ")}, ?, ?, ?, ?) ` +
          "ON CONFLICT(osm_id, osm_type) DO UPDATE SET updated_at = excluded.updated_at RETURNING id",
      )
      .bind(...columns.map((c) => bind(address[c])), poiCategory, poiAsked ? now : null, now, now)
      .first<{ id: number }>();
    return inserted?.id ?? null;
  }

  private async geocodeLanguage(): Promise<string> {
    const row = await this.db
      .prepare("SELECT geocode_language FROM settings WHERE id = 1")
      .first<{ geocode_language: string }>();
    return row?.geocode_language ?? "en";
  }

  private async addressForPosition(positionId: number | null): Promise<number | null> {
    if (positionId == null) return null;
    const point = await this.db
      .prepare("SELECT latitude, longitude FROM positions WHERE id = ?")
      .bind(positionId)
      .first<{ latitude: number | null; longitude: number | null }>();
    return point ? this.resolveAddress(point.latitude, point.longitude) : null;
  }

  // ---- elevation ----

  /**
   * Fill in `elevation` for a drive's positions from the terrain cache, asking
   * the elevation service only about coordinates nothing has asked about before.
   *
   * Best-effort, like geocoding: a drive whose lookup fails keeps null
   * elevations and simply has no elevation chart. Overridden to a no-op by the
   * import, which replays history and would otherwise turn one upload into tens
   * of thousands of requests.
   */
  async enrichElevations(driveId: number): Promise<{ filled: number; requests: number; skipped: number }> {
    const points = await this.db
      .prepare(
        "SELECT id, latitude, longitude FROM positions " +
          "WHERE drive_id = ? AND elevation IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL",
      )
      .bind(driveId)
      .all<{ id: number; latitude: number; longitude: number }>();
    if (points.results.length === 0) return { filled: 0, requests: 0, skipped: 0 };

    const wanted = new Map<string, TerrainKey>();
    for (const point of points.results) {
      const key = terrainKey(point.latitude, point.longitude);
      wanted.set(keyOf(key), key);
    }

    const { heights, requests, skipped } = await this.terrainFor([...wanted.values()]);

    // One statement per position rather than a join: the cache is keyed on a
    // rounded coordinate, and doing that rounding in SQL would have to match
    // terrainKey exactly forever.
    const updates = points.results
      .map((point) => ({ point, height: heights.get(keyOf(terrainKey(point.latitude, point.longitude))) }))
      .filter((row): row is { point: typeof row.point; height: number } => typeof row.height === "number");

    for (let i = 0; i < updates.length; i += D1_BATCH) {
      await this.db.batch(
        updates
          .slice(i, i + D1_BATCH)
          .map((row) =>
            this.db.prepare("UPDATE positions SET elevation = ? WHERE id = ?").bind(row.height, row.point.id),
          ),
      );
    }

    return { filled: updates.length, requests, skipped };
  }

  /**
   * Heights for a set of terrain keys, cache first. Keys the cache already holds
   * — including ones it holds as unanswerable — never go out over the network.
   *
   * `skipped` counts coordinates left unasked because this drive ran out of its
   * request or time budget. Cache hits are free and never count against either.
   */
  private async terrainFor(
    keys: readonly TerrainKey[],
  ): Promise<{ heights: Map<string, number | null>; requests: number; skipped: number }> {
    const heights = new Map<string, number | null>();
    const missing: TerrainKey[] = [];

    for (let i = 0; i < keys.length; i += D1_BATCH) {
      const chunk = keys.slice(i, i + D1_BATCH);
      const rows = await this.db
        .prepare(
          "SELECT lat_e4, lon_e4, elevation FROM terrain WHERE (lat_e4, lon_e4) IN " +
            `(VALUES ${chunk.map(() => "(?, ?)").join(", ")})`,
        )
        .bind(...chunk.flatMap((key) => [key.latE4, key.lonE4]))
        .all<{ lat_e4: number; lon_e4: number; elevation: number | null }>();
      for (const row of rows.results) {
        heights.set(keyOf({ latE4: row.lat_e4, lonE4: row.lon_e4 }), row.elevation);
      }
    }

    for (const key of keys) if (!heights.has(keyOf(key))) missing.push(key);

    let requests = 0;
    let skipped = 0;
    const now = Date.now();
    const deadline = now + ELEVATION_BUDGET_MS;
    for (let i = 0; i < missing.length; i += MAX_BATCH) {
      const chunk = missing.slice(i, i + MAX_BATCH);
      if (requests >= ELEVATION_MAX_REQUESTS || Date.now() >= deadline) {
        skipped += missing.length - i;
        break;
      }
      const answers = await lookupElevations(chunk.map(keyToCoordinate), this.elevationBaseUrl);
      requests++;
      // A failed batch is left out of the cache entirely, so the next drive over
      // this road tries again. Only an answer gets remembered.
      if (answers === null) continue;
      await this.db.batch(
        chunk.map((key, index) =>
          this.db
            .prepare("INSERT OR REPLACE INTO terrain (lat_e4, lon_e4, elevation, fetched_at) VALUES (?, ?, ?, ?)")
            .bind(key.latE4, key.lonE4, answers[index] ?? null, now),
        ),
      );
      chunk.forEach((key, index) => heights.set(keyOf(key), answers[index] ?? null));
    }

    return { heights, requests, skipped };
  }

  // ---- geofences ----

  private async geofences(): Promise<GeofenceLike[]> {
    const rows = await this.db.prepare("SELECT id, latitude, longitude, radius FROM geofences").all<GeofenceLike>();
    return rows.results;
  }

  private async geofenceForPoint(point: { latitude: number | null; longitude: number | null }): Promise<number | null> {
    if (point.latitude == null || point.longitude == null) return null;
    const all = await this.geofences();
    if (all.length === 0) return null;
    return findGeofence(point, all)?.id ?? null;
  }

  async geofenceForPosition(positionId: number | null): Promise<number | null> {
    if (positionId == null) return null;
    const point = await this.db
      .prepare("SELECT latitude, longitude FROM positions WHERE id = ?")
      .bind(positionId)
      .first<{ latitude: number | null; longitude: number | null }>();
    return point ? this.geofenceForPoint(point) : null;
  }
}
