import type { CostDetailDto, CostSource, TariffPriceDto } from "@shared/api-types";
import { priceCharge, type ChargeForPricing, type PlacePricing } from "../core/derive/cost";
import { modalFastChargerType } from "../core/derive/energy";
import { changedDays, dayStart, sortPrices, type DateRange } from "../core/tariff";
import { isValidTimeZone, localDate } from "../core/zone";
import type { SqlDatabase } from "../platform/ports";

/**
 * Charging costs in the database: reading a place's tariff, pricing a session
 * with it (core/derive/cost.ts), and keeping every session's cost in step with
 * the tariff as it changes.
 *
 * A cost is recomputed only when it is stale (`cost_stale = 1`): a price it
 * fell under changed, the session moved to another place, or it was recorded
 * before tariffs. Marking is one UPDATE; the pricing itself — a sample read and
 * a few hundred wall-clock lookups per session — is worked off in batches:
 * BUDGET_ON_EDIT inline with the edit that caused it, newest first so the
 * sessions the owner is about to look at are done, and BUDGET_PER_SWEEP on each
 * ten-minute cron run for the rest. Neither ever holds a request for a whole
 * history, which a Worker's CPU limit would not allow.
 *
 * A manual cost is never marked and never written; a legacy one is replaced
 * only by the identical figure (see migration 0008).
 */

export const BUDGET_ON_EDIT = 60;
export const BUDGET_PER_SWEEP = 200;

/**
 * Energy put into the pack is the state-of-charge span times the capacity,
 * each end read to the nearest percent; how much the grid supplied on top is
 * the efficiency's to say.
 */
const SOC_READING_SLACK = 1;

/** The account's time zone, which a place without its own uses. */
export async function accountTimeZone(db: SqlDatabase): Promise<string> {
  const row = await db.prepare("SELECT timezone FROM settings WHERE id = 1").first<{ timezone: string | null }>();
  const zone = row?.timezone ?? "UTC";
  return isValidTimeZone(zone) ? zone : "UTC";
}

export interface PlaceRow {
  id: number;
  tariff: string | null;
  timezone: string | null;
  charger_power_kw: number | null;
  ac_efficiency: number | null;
  dc_efficiency: number | null;
  billing_type: "per_kwh" | "per_minute";
  cost_per_unit: number | null;
  session_fee_cents: number | null;
  updated_at: number;
}

export const PLACE_COLUMNS =
  "id, tariff, timezone, charger_power_kw, ac_efficiency, dc_efficiency, billing_type, cost_per_unit, " +
  "session_fee_cents, updated_at";

/**
 * A place's tariff, converting the flat price it had before tariffs into the
 * first dated price the first time it is read (migration 0008 says why that
 * is not in SQL). The price starts on the local day of the place's first
 * priced session — so every cost it produced is in its validity — else on the
 * day the place was last edited, which is when the price was last set.
 */
export async function tariffOf(db: SqlDatabase, row: PlaceRow, timeZone: string): Promise<TariffPriceDto[]> {
  if (row.tariff != null) return JSON.parse(row.tariff) as TariffPriceDto[];
  let tariff: TariffPriceDto[] = [];
  if (row.cost_per_unit != null || row.session_fee_cents != null) {
    const first = await db
      .prepare(
        "SELECT MIN(start_date_at) AS at FROM charging_processes WHERE geofence_id = ? AND cost_cents IS NOT NULL",
      )
      .bind(row.id)
      .first<{ at: number | null }>();
    tariff = [
      {
        validFrom: localDate(first?.at ?? row.updated_at, timeZone),
        billingType: row.billing_type,
        rate: row.cost_per_unit ?? 0,
        sessionFeeCents: row.session_fee_cents,
        windows: [],
      },
    ];
  }
  await db
    .prepare("UPDATE geofences SET tariff = ? WHERE id = ? AND tariff IS NULL")
    .bind(JSON.stringify(tariff), row.id)
    .run();
  return tariff;
}

export async function placePricing(db: SqlDatabase, geofenceId: number): Promise<PlacePricing | null> {
  const row = await db
    .prepare(`SELECT ${PLACE_COLUMNS} FROM geofences WHERE id = ?`)
    .bind(geofenceId)
    .first<PlaceRow>();
  if (!row) return null;
  const timeZone = row.timezone ?? (await accountTimeZone(db));
  return {
    tariff: sortPrices(await tariffOf(db, row, timeZone)),
    timeZone,
    chargerPowerKw: row.charger_power_kw,
    acEfficiency: row.ac_efficiency,
    dcEfficiency: row.dc_efficiency,
  };
}

/**
 * What the car's onboard charger can take from AC, kW — an upper bound, so a
 * range built on it stays honest. Model 3, Y and Cybertruck: 11.5 kW (48 A at
 * 240 V; 11 kW on European three-phase). S, X and anything unknown: 22 kW, the
 * old dual-charger S and X on European three-phase.
 */
export function onboardAcLimitKw(model: string | null): number {
  return model === "3" || model === "Y" || model === "C" ? 11.5 : 22;
}

interface ChargeRow {
  id: number;
  car_id: number;
  start_date_at: number;
  end_date_at: number | null;
  start_after_at: number | null;
  start_before_at: number | null;
  end_after_at: number | null;
  end_before_at: number | null;
  charge_energy_added: number | null;
  charge_energy_used: number | null;
  start_battery_level: number | null;
  end_battery_level: number | null;
  reconstructed: number;
  geofence_id: number | null;
  cost_cents: number | null;
  cost_max_cents: number | null;
  cost_source: CostSource | null;
  free_supercharging: number | null;
  model: string | null;
}

/** Places read once per batch, not once per session. */
export type PlaceCache = Map<number, PlacePricing | null>;

/**
 * Prices one session and stores the result — unless its cost is manual, or
 * legacy and not reproduced. Returns what is now stored.
 */
export async function repriceCharge(
  db: SqlDatabase,
  id: number,
  cache: PlaceCache = new Map(),
): Promise<{ min: number; max: number } | null> {
  const row = await db
    .prepare(
      `SELECT cp.id, cp.car_id, cp.start_date_at, cp.end_date_at, cp.start_after_at, cp.start_before_at,
              cp.end_after_at, cp.end_before_at, cp.charge_energy_added, cp.charge_energy_used,
              cp.start_battery_level, cp.end_battery_level, cp.reconstructed, cp.geofence_id, cp.cost_cents,
              cp.cost_max_cents, cp.cost_source, s.free_supercharging, c.model
       FROM charging_processes cp
       LEFT JOIN car_settings s ON s.car_id = cp.car_id
       LEFT JOIN cars c ON c.id = cp.car_id
       WHERE cp.id = ?`,
    )
    .bind(id)
    .first<ChargeRow>();
  if (!row) return null;
  const stored = () =>
    row.cost_cents == null ? null : { min: row.cost_cents, max: row.cost_max_cents ?? row.cost_cents };
  if (row.cost_source === "manual" || row.end_date_at == null) {
    await db.prepare("UPDATE charging_processes SET cost_stale = 0 WHERE id = ?").bind(id).run();
    return stored();
  }

  let place: PlacePricing | null = null;
  if (row.geofence_id != null) {
    if (!cache.has(row.geofence_id)) cache.set(row.geofence_id, await placePricing(db, row.geofence_id));
    place = cache.get(row.geofence_id) ?? null;
  }

  const samples = await db
    .prepare(
      "SELECT date_at, charger_power, fast_charger_present, fast_charger_type FROM charges " +
        "WHERE charging_process_id = ? ORDER BY date_at",
    )
    .bind(id)
    .all<{
      date_at: number;
      charger_power: number | null;
      fast_charger_present: number | null;
      fast_charger_type: string | null;
    }>();
  const rows = samples.results;

  const charge: ChargeForPricing = {
    startAt: row.start_date_at,
    endAt: row.end_date_at,
    startAfter: row.start_after_at,
    startBefore: row.start_before_at,
    endAfter: row.end_after_at,
    endBefore: row.end_before_at,
    energyAdded: row.charge_energy_added,
    energyUsed: row.charge_energy_used,
    energyRange:
      row.reconstructed === 1 && row.charge_energy_added == null && place != null
        ? await reconstructedEnergy(db, row)
        : null,
    reconstructed: row.reconstructed === 1,
    // The same rule as the list's DC_SESSION: a fast charger reported present.
    dc: rows.length === 0 ? null : rows.some((r) => r.fast_charger_present === 1),
    samples: rows.map((r) => ({ at: r.date_at, powerKw: r.charger_power })),
    fastChargerType: modalFastChargerType(
      rows.map((r) => ({
        date_at: r.date_at,
        charger_power: r.charger_power,
        charger_voltage: null,
        charger_actual_current: null,
        charger_phases: null,
        charge_energy_added: null,
        fast_charger_type: r.fast_charger_type,
      })),
    ),
    freeSupercharging: row.free_supercharging === 1,
    carAcLimitKw: onboardAcLimitKw(row.model),
  };
  const priced = priceCharge(charge, place);

  if (row.cost_source === "legacy") {
    const old = stored();
    const same = priced != null && old != null && priced.min === old.min && priced.max === old.max;
    if (same) {
      await db
        .prepare(
          "UPDATE charging_processes SET cost_source = 'tariff', cost_detail = ?, cost_stale = 0 " +
            "WHERE id = ? AND cost_source = 'legacy'",
        )
        .bind(JSON.stringify(priced.detail), id)
        .run();
    } else {
      await db.prepare("UPDATE charging_processes SET cost_stale = 0 WHERE id = ?").bind(id).run();
    }
    return old;
  }

  await writeCost(db, id, priced);
  return priced ? { min: priced.min, max: priced.max } : null;
}

async function writeCost(
  db: SqlDatabase,
  id: number,
  priced: { min: number; max: number; detail: CostDetailDto } | null,
): Promise<void> {
  // The guard repeats the manual check in the statement itself, so an owner's
  // figure saved between the read above and this write still wins.
  await db
    .prepare(
      "UPDATE charging_processes SET cost_cents = ?, cost_max_cents = ?, cost_source = ?, cost_detail = ?, " +
        "cost_billed_kwh = NULL, cost_note = NULL, cost_stale = 0 " +
        "WHERE id = ? AND (cost_source IS NULL OR cost_source = 'tariff')",
    )
    .bind(
      priced?.min ?? null,
      priced != null && priced.max !== priced.min ? priced.max : null,
      priced ? "tariff" : null,
      priced ? JSON.stringify(priced.detail) : null,
      id,
    )
    .run();
}

/**
 * What a charge nobody saw put into the pack, from its state-of-charge rise:
 * the span, give or take a percent at each end, times the capacity the car's
 * own measured sessions show per percent (the median of the last 25 that
 * moved at least 20%). Null with none to go by — a per-kWh price then says
 * nothing.
 */
async function reconstructedEnergy(db: SqlDatabase, row: ChargeRow): Promise<{ min: number; max: number } | null> {
  if (row.start_battery_level == null || row.end_battery_level == null) return null;
  const span = row.end_battery_level - row.start_battery_level;
  if (span <= 0) return null;
  const sessions = await db
    .prepare(
      `SELECT charge_energy_added * 100.0 / (end_battery_level - start_battery_level) AS kwh
       FROM charging_processes
       WHERE car_id = ? AND reconstructed = 0 AND charge_energy_added > 0
         AND end_battery_level - start_battery_level >= 20
       ORDER BY start_date_at DESC LIMIT 25`,
    )
    .bind(row.car_id)
    .all<{ kwh: number }>();
  const sorted = sessions.results.map((r) => r.kwh).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const capacity = sorted[Math.floor(sorted.length / 2)]!;
  return {
    min: (Math.max(0, span - SOC_READING_SLACK) / 100) * capacity,
    max: ((span + SOC_READING_SLACK) / 100) * capacity,
  };
}

/**
 * Works off up to `limit` stale sessions, newest first. `remaining` is how
 * many are still waiting.
 */
export async function repriceStale(
  db: SqlDatabase,
  limit: number,
  geofenceId: number | null = null,
): Promise<{ repriced: number; remaining: number }> {
  const rows = await db
    .prepare(
      "SELECT id FROM charging_processes WHERE cost_stale = 1 AND (?1 IS NULL OR geofence_id = ?1) " +
        "ORDER BY start_date_at DESC LIMIT ?2",
    )
    .bind(geofenceId, limit)
    .all<{ id: number }>();
  const cache: PlaceCache = new Map();
  for (const row of rows.results) await repriceCharge(db, row.id, cache);
  return { repriced: rows.results.length, remaining: await staleCount(db, geofenceId) };
}

export async function staleCount(db: SqlDatabase, geofenceId: number | null = null): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM charging_processes WHERE cost_stale = 1 AND (?1 IS NULL OR geofence_id = ?1)")
    .bind(geofenceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Queues a place's sessions for repricing: all of them, or those that began on
 * the local days given (a tariff edit's `changedDays`).
 */
export async function markPlaceStale(
  db: SqlDatabase,
  geofenceId: number,
  days: DateRange[] | "all",
  timeZone: string,
): Promise<void> {
  const base =
    "UPDATE charging_processes SET cost_stale = 1 WHERE geofence_id = ? AND end_date_at IS NOT NULL " +
    "AND (cost_source IS NULL OR cost_source <> 'manual')";
  if (days === "all") {
    await db.prepare(base).bind(geofenceId).run();
    return;
  }
  for (const range of days) {
    await db
      .prepare(`${base} AND start_date_at >= ? AND (? IS NULL OR start_date_at < ?)`)
      .bind(
        geofenceId,
        dayStart(range.from, timeZone),
        range.until,
        range.until == null ? null : dayStart(range.until, timeZone),
      )
      .run();
  }
}

/** What an edit to a place's pricing has to reprice. */
export function repriceScope(
  before: {
    tariff: TariffPriceDto[];
    timeZone: string;
    chargerPowerKw: number | null;
    ac: number | null;
    dc: number | null;
  },
  after: {
    tariff: TariffPriceDto[];
    timeZone: string;
    chargerPowerKw: number | null;
    ac: number | null;
    dc: number | null;
  },
): DateRange[] | "all" {
  // Anything that is not a price — the zone the days are read in, the
  // efficiency, the charger's power — reaches every session there.
  if (
    before.timeZone !== after.timeZone ||
    before.chargerPowerKw !== after.chargerPowerKw ||
    before.ac !== after.ac ||
    before.dc !== after.dc
  ) {
    return "all";
  }
  return changedDays(before.tariff, after.tariff);
}
