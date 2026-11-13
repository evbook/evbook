import type {
  ChargeDetailDto,
  ChargeDto,
  ChargeListDto,
  ChargeMapDto,
  ChargeMapPointDto,
  CostDetailDto,
  CostSource,
  PreferredRange,
} from "@shared/api-types";
import { oneLine, placeRegion, placeSpot } from "./address";
import { uncertainty, uncertaintyColumns, type UncertaintyRow } from "./uncertainty";
import type { SqlDatabase } from "../../platform/ports";

/** Read queries for charging sessions. */

type ChargeSort = "date" | "energy" | "duration" | "cost" | "power" | "battery";

/** What narrows the set of sessions — shared by the list and the map. */
export interface ChargeQuery {
  carId?: number;
  from?: number;
  to?: number;
  /** "ac" | "dc" — DC means the car reported a fast charger present; see DC_SESSION. */
  currentType?: "ac" | "dc";
  /** Only sessions that happened inside this geofence. */
  geofenceId?: number;
  search?: string;
  /** Only sessions the car was seen charging, or only the ones reconstructed after the fact. */
  recorded?: "live" | "reconstructed";
  minEnergyKwh?: number;
  maxEnergyKwh?: number;
  minDurationMin?: number;
  maxDurationMin?: number;
  minCostCents?: number;
  maxCostCents?: number;
}

export interface ChargeFilters extends ChargeQuery {
  sort: ChargeSort;
  dir: "asc" | "desc";
  limit: number;
  offset: number;
  preferredRange: PreferredRange;
}

/** First reported phase count, for display. NULL is common on AC too — see DC_SESSION. */
const PHASES_SUBQUERY =
  "(SELECT charger_phases FROM charges WHERE charging_process_id = cp.id AND charger_power > 0 ORDER BY date_at LIMIT 1)";

/**
 * Whether a session was DC, which needs *positive* evidence: the car said a fast
 * charger was on the other end.
 *
 * This used to be "no phase count was reported", following TeslaMate, and it was
 * wrong twice over. A session where the car was plugged in and never drew power has
 * no powered sample at all, so the phase lookup returned NULL and a 0 kWh evening on
 * a home AC charger was labelled DC. And absence of phases is not evidence anyway:
 * real AC sessions routinely report no phase count — on the author's own car, 264 of
 * them, peaking at 19 kW, against a single genuine DC session at 50 kW.
 *
 * `fast_charger_present` is the field that actually answers the question, and the car
 * sets it. Where it is missing the session is treated as AC, which is the common case
 * by three orders of magnitude.
 */
export const DC_SESSION =
  "EXISTS (SELECT 1 FROM charges WHERE charging_process_id = cp.id AND fast_charger_present = 1)";

/**
 * A session that moved no energy is not a charge. The car was plugged in and nothing
 * happened — a scheduled charge that never started, a plug that did not seat — and it
 * has nothing to show in any column the list or the roll-ups have. Excluded from both.
 *
 * They stay visible on the History timeline, which lists sessions as events rather
 * than as charges, so nothing becomes unfindable.
 *
 * A reconstructed session is the exception that has no energy figure and is still
 * a charge: the state of charge rose while nobody could read the car, so energy
 * moved — how much is what is unknown, and it stays null rather than becoming 0.
 */
export const HAS_ENERGY =
  "(COALESCE(cp.charge_energy_added, 0) > 0 OR COALESCE(cp.charge_energy_used, 0) > 0 OR cp.reconstructed = 1)";

/**
 * A session's energy in kWh: whichever of the two figures the car reported, taken
 * per session. Some cars log energy added at the wall, some log energy drawn into
 * the pack, some log both and some neither is the larger — so the list, the detail
 * page and every roll-up take the max of the two, and this is that rule as SQL.
 *
 * It must be summed per session, never as `max(SUM(added), SUM(used))`: the max of
 * two totals depends on how the sessions were grouped, so a page that sliced the
 * same sessions by month and by year read back two different totals for one number.
 * Requires the table aliased `cp`, like HAS_ENERGY above.
 */
export const SESSION_ENERGY_KWH =
  // Unknown when the car reported neither (a reconstructed session): null, so a
  // sum skips it and an average does not count it as a session that took 0 kWh.
  "CASE WHEN cp.charge_energy_added IS NULL AND cp.charge_energy_used IS NULL THEN NULL " +
  "ELSE max(COALESCE(cp.charge_energy_added, 0), COALESCE(cp.charge_energy_used, 0)) END";

const MAX_POWER_SUBQUERY = "(SELECT MAX(charger_power) FROM charges WHERE charging_process_id = cp.id)";

/** Allowlisted sort expressions — never interpolate user input into SQL. */
function orderBy(sort: ChargeSort, dir: "asc" | "desc"): string {
  const direction = dir === "asc" ? "ASC" : "DESC";
  const columns: Record<ChargeSort, string> = {
    date: "cp.start_date_at",
    energy: "cp.charge_energy_added",
    duration: "cp.duration_min",
    cost: "cp.cost_cents",
    power: MAX_POWER_SUBQUERY,
    battery: "cp.start_battery_level",
  };
  return `${columns[sort]} IS NULL, ${columns[sort]} ${direction}, cp.id ${direction}`;
}

interface ChargeRow extends UncertaintyRow {
  id: number;
  car_id: number;
  start_date_at: number;
  end_date_at: number | null;
  charge_energy_added: number | null;
  charge_energy_used: number | null;
  duration_min: number | null;
  start_battery_level: number | null;
  end_battery_level: number | null;
  start_range_km: number | null;
  end_range_km: number | null;
  outside_temp_avg: number | null;
  cost_cents: number | null;
  cost_max_cents: number | null;
  cost_source: CostSource | null;
  label: string | null;
  region: string | null;
  max_power: number | null;
  phases: number | null;
  is_dc: number;
  charger_type: string | null;
}

/** Exported for the timeline log, which shows charges beside the other event kinds. */
export const JOINS = `
  LEFT JOIN geofences g ON g.id = cp.geofence_id
  LEFT JOIN addresses a ON a.id = cp.address_id`;

/** A geofence the owner named, else the address — as on drives. */
export const LABEL = `COALESCE(g.name, ${placeSpot("a")})`;

/** The town it sits in, shown dimmed after the label; never beside a geofence. */
export const REGION = `CASE WHEN g.name IS NULL THEN ${placeRegion("a")} END`;

/** Wider than the label, for the same reason as on drives. */
export const SEARCH_LABEL = "COALESCE(g.name, a.display_name, '')";

/** Per-session aggregates over the raw samples. */
const AGGREGATES = `
  ${MAX_POWER_SUBQUERY} AS max_power,
  ${PHASES_SUBQUERY} AS phases,
  CASE WHEN ${DC_SESSION} THEN 1 ELSE 0 END AS is_dc,
  (SELECT fast_charger_type FROM charges WHERE charging_process_id = cp.id AND charger_power > 0
     GROUP BY fast_charger_type ORDER BY COUNT(*) DESC LIMIT 1) AS charger_type`;

function buildWhere(filters: ChargeQuery): { sql: string; params: (string | number)[] } {
  const clauses = ["cp.end_date_at IS NOT NULL", HAS_ENERGY];
  const params: (string | number)[] = [];

  const add = (sql: string, value: number | string | undefined) => {
    if (value === undefined) return;
    clauses.push(sql);
    params.push(value);
  };

  add("cp.car_id = ?", filters.carId);
  add("cp.start_date_at >= ?", filters.from);
  // Exclusive end, matching drives and the bucketed queries in stats.ts.
  add("cp.start_date_at < ?", filters.to);
  // An energy nobody measured is not 0 kWh: it matches no energy range at all.
  add("cp.charge_energy_added >= ?", filters.minEnergyKwh);
  add("cp.charge_energy_added <= ?", filters.maxEnergyKwh);
  add("cp.duration_min >= ?", filters.minDurationMin);
  add("cp.duration_min <= ?", filters.maxDurationMin);
  add("cp.cost_cents >= ?", filters.minCostCents);
  add("cp.cost_cents <= ?", filters.maxCostCents);
  // The geofence the session was matched to, as on drives: the picker offers the
  // places the owner named, not every address a charger was ever found at.
  add("cp.geofence_id = ?", filters.geofenceId);

  if (filters.search) {
    clauses.push(`${SEARCH_LABEL} LIKE ?`);
    params.push(`%${filters.search}%`);
  }
  if (filters.currentType === "dc") clauses.push(DC_SESSION);
  if (filters.currentType === "ac") clauses.push(`NOT ${DC_SESSION}`);
  if (filters.recorded === "live") clauses.push("cp.reconstructed = 0");
  if (filters.recorded === "reconstructed") clauses.push("cp.reconstructed = 1");

  return { sql: clauses.join(" AND "), params };
}

function rangeColumns(preferred: PreferredRange): { start: string; end: string } {
  return preferred === "ideal"
    ? { start: "cp.start_ideal_range_km", end: "cp.end_ideal_range_km" }
    : { start: "cp.start_rated_range_km", end: "cp.end_rated_range_km" };
}

function toDto(row: ChargeRow): ChargeDto {
  const energy = Math.max(row.charge_energy_added ?? 0, row.charge_energy_used ?? 0) || null;
  const costCents = row.cost_cents;
  return {
    id: row.id,
    carId: row.car_id,
    startAt: row.start_date_at,
    endAt: row.end_date_at,
    energyAddedKwh: row.charge_energy_added,
    energyUsedKwh: row.charge_energy_used,
    durationMin: row.duration_min,
    startBatteryLevel: row.start_battery_level,
    endBatteryLevel: row.end_battery_level,
    startRangeKm: row.start_range_km,
    endRangeKm: row.end_range_km,
    rangeAddedKm: row.start_range_km != null && row.end_range_km != null ? row.end_range_km - row.start_range_km : null,
    outsideTempAvg: row.outside_temp_avg,
    costCents,
    costPerKwhCents: costCents != null && energy ? costCents / energy : null,
    maxPowerKw: row.max_power,
    currentType: row.is_dc ? "dc" : "ac",
    chargerType: row.charger_type,
    label: row.label,
    region: row.region,
    ...uncertainty(row),
    costMaxCents: row.cost_max_cents,
    costSource: row.cost_source,
  };
}

export async function listCharges(db: SqlDatabase, filters: ChargeFilters): Promise<ChargeListDto> {
  const { start, end } = rangeColumns(filters.preferredRange);
  const where = buildWhere(filters);

  // The page's ids are chosen first, and only then are the per-session
  // aggregates computed. Selecting them alongside the sort makes SQLite
  // evaluate all three subqueries for every matching session on the way into
  // the sorter — the whole `charges` table, three times over, to render fifty
  // rows. Picking the page first keeps the aggregates to the rows on screen.
  const ordering = orderBy(filters.sort, filters.dir);
  const rows = await db
    .prepare(
      `WITH page AS (
         SELECT cp.id AS id FROM charging_processes cp ${JOINS}
         WHERE ${where.sql}
         ORDER BY ${ordering}
         LIMIT ? OFFSET ?
       )
       SELECT cp.id, cp.car_id, cp.start_date_at, cp.end_date_at, cp.charge_energy_added, cp.charge_energy_used,
              cp.duration_min, cp.start_battery_level, cp.end_battery_level, cp.outside_temp_avg, cp.cost_cents,
              cp.cost_max_cents, cp.cost_source, ${uncertaintyColumns("cp")},
              ${start} AS start_range_km, ${end} AS end_range_km,
              ${LABEL} AS label, ${REGION} AS region, ${AGGREGATES}
       FROM charging_processes cp ${JOINS}
       JOIN page ON page.id = cp.id
       ORDER BY ${ordering}`,
    )
    .bind(...where.params, filters.limit, filters.offset)
    .all<ChargeRow>();

  const totals = await db
    .prepare(
      // COUNT over a column counts the rows where it is not null, which is what a
      // per-session average has to divide its sum by — see the DTO for why cost is
      // so often missing.
      `SELECT COUNT(*) AS count, SUM(cp.charge_energy_added) AS added, SUM(cp.charge_energy_used) AS used,
              SUM(cp.duration_min) AS duration_min, SUM(cp.cost_cents) AS cost_cents,
              SUM(cp.cost_max_cents IS NOT NULL) AS ranged,
              SUM(COALESCE(cp.cost_max_cents, cp.cost_cents)) AS cost_max_cents,
              COUNT(cp.charge_energy_added) AS added_count, COUNT(cp.cost_cents) AS cost_count
       FROM charging_processes cp ${JOINS}
       WHERE ${where.sql}`,
    )
    .bind(...where.params)
    .first<{
      count: number;
      added: number | null;
      used: number | null;
      duration_min: number | null;
      cost_cents: number | null;
      ranged: number | null;
      cost_max_cents: number | null;
      added_count: number;
      cost_count: number;
    }>();

  // Bounds drive the range sliders, over everything logged for the selected car
  // rather than the current filter, so the handles stay put while dragging.
  const boundsWhere = filters.carId === undefined ? "" : " AND cp.car_id = ?";
  const boundsParams = filters.carId === undefined ? [] : [filters.carId];
  const bounds = await db
    .prepare(
      `SELECT MIN(cp.charge_energy_added) AS min_energy, MAX(cp.charge_energy_added) AS max_energy,
              MIN(cp.duration_min) AS min_duration, MAX(cp.duration_min) AS max_duration,
              MIN(cp.cost_cents) AS min_cost, MAX(cp.cost_cents) AS max_cost
       FROM charging_processes cp WHERE cp.end_date_at IS NOT NULL AND ${HAS_ENERGY}${boundsWhere}`,
    )
    .bind(...boundsParams)
    .first<{
      min_energy: number | null;
      max_energy: number | null;
      min_duration: number | null;
      max_duration: number | null;
      min_cost: number | null;
      max_cost: number | null;
    }>();

  return {
    charges: rows.results.map(toDto),
    totals: {
      count: totals?.count ?? 0,
      energyAddedKwh: totals?.added ?? null,
      energyUsedKwh: totals?.used ?? null,
      durationMin: totals?.duration_min ?? null,
      costCents: totals?.cost_cents ?? null,
      costMaxCents: (totals?.ranged ?? 0) > 0 ? (totals?.cost_max_cents ?? null) : null,
      energyAddedCount: totals?.added_count ?? 0,
      costCount: totals?.cost_count ?? 0,
    },
    bounds: {
      energyKwh: { min: bounds?.min_energy ?? 0, max: bounds?.max_energy ?? 0 },
      durationMin: { min: bounds?.min_duration ?? 0, max: bounds?.max_duration ?? 0 },
      costCents: { min: bounds?.min_cost ?? 0, max: bounds?.max_cost ?? 0 },
    },
  };
}

/**
 * At most this many places are drawn. Ordered by session count, so what falls
 * off the end is the long tail of one-off stops rather than anywhere regular.
 */
const MAX_MAP_POINTS = 500;

/**
 * Where a session happened, and how sessions collapse into one place: a
 * geofence covers every stop inside it, an address covers a charger the car
 * returns to, and everything else rounds the parked coordinate to three
 * decimals — about a hundred metres, enough to absorb GPS drift on a driveway
 * without merging two chargers on the same street.
 */
const PLACE_KEY = `CASE
    WHEN cp.geofence_id IS NOT NULL THEN 'g' || cp.geofence_id
    WHEN cp.address_id IS NOT NULL THEN 'a' || cp.address_id
    ELSE 'p' || ROUND(p.latitude, 3) || ',' || ROUND(p.longitude, 3)
  END`;

interface MapRow {
  place: string | null;
  label: string | null;
  lat: number | null;
  lng: number | null;
  count: number;
  energy: number | null;
  cost: number | null;
  last_at: number;
}

/** The same sessions the list shows, rolled up by place for the map. */
export async function listChargeMapPoints(db: SqlDatabase, filters: ChargeQuery): Promise<ChargeMapDto> {
  const where = buildWhere(filters);

  // Sessions with no coordinates group under a NULL place and are reported as a
  // count rather than drawn. They sort first so the row cannot be pushed out by
  // the limit, which only ever truncates the tail of drawable places.
  const rows = await db
    .prepare(
      `WITH located AS (
         SELECT ${PLACE_KEY} AS place,
                COALESCE(g.latitude, p.latitude, a.latitude) AS lat,
                COALESCE(g.longitude, p.longitude, a.longitude) AS lng,
                ${oneLine(LABEL, REGION)} AS label,
                cp.charge_energy_added AS energy, cp.cost_cents AS cost, cp.start_date_at AS at
         FROM charging_processes cp ${JOINS}
         LEFT JOIN positions p ON p.id = cp.position_id
         WHERE ${where.sql}
       )
       SELECT CASE WHEN lat IS NULL OR lng IS NULL THEN NULL ELSE place END AS place,
              MIN(label) AS label, AVG(lat) AS lat, AVG(lng) AS lng, COUNT(*) AS count,
              SUM(energy) AS energy, SUM(cost) AS cost, MAX(at) AS last_at
       FROM located
       GROUP BY 1
       ORDER BY place IS NULL DESC, count DESC, last_at DESC
       LIMIT ${MAX_MAP_POINTS + 2}`,
    )
    .bind(...where.params)
    .all<MapRow>();

  let unlocated = 0;
  const points: ChargeMapPointDto[] = [];
  for (const row of rows.results) {
    if (row.place === null || row.lat === null || row.lng === null) {
      unlocated += row.count;
      continue;
    }
    points.push({
      key: row.place,
      label: row.label,
      latitude: row.lat,
      longitude: row.lng,
      count: row.count,
      energyKwh: row.energy,
      costCents: row.cost,
      lastAt: row.last_at,
    });
  }

  return {
    points: points.slice(0, MAX_MAP_POINTS),
    unlocated,
    truncated: points.length > MAX_MAP_POINTS,
  };
}

/**
 * Every per-sample column the car reported, straight off the table, for the CSV
 * download on the detail page. Raw and unconverted like the table exports on
 * the settings page: an export is for other tools, and they want SI units and
 * the database's own column names.
 */
export async function getChargeSamplesForExport(
  db: SqlDatabase,
  id: number,
): Promise<{ startAt: number; samples: Record<string, unknown>[] } | null> {
  const session = await db
    .prepare("SELECT start_date_at FROM charging_processes WHERE id = ?")
    .bind(id)
    .first<{ start_date_at: number }>();
  if (!session) return null;

  const rows = await db
    .prepare(
      "SELECT date_at, battery_level, usable_battery_level, charge_energy_added, charger_power, " +
        "charger_voltage, charger_actual_current, charger_phases, charger_pilot_current, conn_charge_cable, " +
        "fast_charger_present, fast_charger_brand, fast_charger_type, ideal_battery_range_km, " +
        "rated_battery_range_km, battery_temp_min, battery_temp_max, outside_temp, battery_heater, " +
        "battery_heater_on, battery_heater_no_power, not_enough_power_to_heat " +
        "FROM charges WHERE charging_process_id = ? ORDER BY date_at",
    )
    .bind(id)
    .all<Record<string, unknown>>();

  return { startAt: session.start_date_at, samples: rows.results };
}

export async function getCharge(
  db: SqlDatabase,
  id: number,
  preferredRange: PreferredRange,
): Promise<ChargeDetailDto | null> {
  const { start, end } = rangeColumns(preferredRange);

  const row = await db
    .prepare(
      `SELECT cp.id, cp.car_id, cp.start_date_at, cp.end_date_at, cp.charge_energy_added, cp.charge_energy_used,
              cp.duration_min, cp.start_battery_level, cp.end_battery_level, cp.outside_temp_avg, cp.cost_cents,
              cp.cost_max_cents, cp.cost_source, ${uncertaintyColumns("cp")},
              cp.cost_detail, cp.cost_billed_kwh, cp.cost_note,
              ${start} AS start_range_km, ${end} AS end_range_km,
              ${LABEL} AS label, ${REGION} AS region, ${AGGREGATES}
       FROM charging_processes cp ${JOINS}
       WHERE cp.id = ?`,
    )
    .bind(id)
    .first<ChargeRow & { cost_detail: string | null; cost_billed_kwh: number | null; cost_note: string | null }>();
  if (!row) return null;

  const location = await db
    .prepare(
      "SELECT p.latitude, p.longitude, a.display_name FROM charging_processes cp " +
        "LEFT JOIN positions p ON p.id = cp.position_id LEFT JOIN addresses a ON a.id = cp.address_id " +
        "WHERE cp.id = ?",
    )
    .bind(id)
    .first<{ latitude: number | null; longitude: number | null; display_name: string | null }>();

  const samples = await db
    .prepare(
      "SELECT date_at, battery_level, usable_battery_level, charge_energy_added, charger_power, " +
        "charger_voltage, charger_actual_current, ideal_battery_range_km, rated_battery_range_km, outside_temp, " +
        "battery_temp_min, battery_temp_max " +
        "FROM charges WHERE charging_process_id = ? ORDER BY date_at",
    )
    .bind(id)
    .all<{
      date_at: number;
      battery_level: number | null;
      usable_battery_level: number | null;
      charge_energy_added: number;
      charger_power: number;
      charger_voltage: number | null;
      charger_actual_current: number | null;
      ideal_battery_range_km: number;
      rated_battery_range_km: number | null;
      outside_temp: number | null;
      battery_temp_min: number | null;
      battery_temp_max: number | null;
    }>();

  /*
    The edges of a session are often the plug's readings, not the charge's: a
    row at 0 kW / ~2 V before the ramp or after completion. Left in, that row
    drags every supply axis down to zero — a 230 V line becomes a cliff and its
    real variation flattens into a hairline. Trimmed here, at the edges only:
    a zero in the middle is a genuine interruption and stays. A session that
    never drew a watt keeps its rows, so its chart is honestly flat.
  */
  const rows = samples.results;
  let first = 0;
  while (first < rows.length && rows[first]!.charger_power <= 0) first++;
  let last = rows.length - 1;
  while (last > first && rows[last]!.charger_power <= 0) last--;
  const trimmed = first < rows.length ? rows.slice(first, last + 1) : rows;

  const dto = toDto(row);
  return {
    ...dto,
    // The bill's own kWh is the better divisor for "per kWh" when the owner gave one.
    costPerKwhCents:
      row.cost_source === "manual" && row.cost_billed_kwh && dto.costCents != null
        ? dto.costCents / row.cost_billed_kwh
        : dto.costPerKwhCents,
    costDetail: row.cost_source === "tariff" && row.cost_detail ? (JSON.parse(row.cost_detail) as CostDetailDto) : null,
    costBilledKwh: row.cost_billed_kwh,
    costNote: row.cost_note,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    addressDisplayName: location?.display_name ?? null,
    samples: trimmed.map((s) => ({
      at: s.date_at,
      batteryLevel: s.battery_level,
      usableBatteryLevel: s.usable_battery_level,
      energyAddedKwh: s.charge_energy_added,
      powerKw: s.charger_power,
      voltage: s.charger_voltage,
      current: s.charger_actual_current,
      rangeKm: preferredRange === "ideal" ? s.ideal_battery_range_km : s.rated_battery_range_km,
      outsideTemp: s.outside_temp,
      batteryTempMin: s.battery_temp_min,
      batteryTempMax: s.battery_temp_max,
    })),
  };
}
