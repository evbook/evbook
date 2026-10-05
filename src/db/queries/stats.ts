import type {
  BatteryHealthDto,
  ChargeLevelDto,
  ChargingLocationDto,
  ChargingSideDto,
  ChargingStatsDto,
  DriveStatsDto,
  EfficiencyStatsDto,
  OdometerSeriesDto,
  PeriodStatsDto,
  PlaceStatsDto,
  PreferredRange,
  StateTimelineDto,
  UpdateDto,
  VampireDrainDto,
} from "@shared/api-types";
import { consumptionPer100km } from "../../core/derive/consumption";
import { guessCategory } from "../../core/geo/category";
import { mergeSpans, totalsFor, type Span, type TimelineState } from "../../core/stateTimeline";
import { STALE_MS } from "./dataHealth";
import { buildBuckets, zonedWeekdayHour, type FirstDay, type Period } from "../../../shared/timeBuckets";
import { decodeVin } from "../../../shared/vin";
import {
  END_LABEL as DRIVE_END_LABEL,
  END_REGION as DRIVE_END_REGION,
  JOINS as DRIVE_JOINS,
  energyExpr,
} from "./drives";
import { DC_SESSION, HAS_ENERGY, SESSION_ENERGY_KWH } from "./charges";
import type { SqlDatabase } from "../../platform/ports";

/** Analytics queries — the replacements for TeslaMate's Grafana dashboards. */

function rangeColumns(preferred: PreferredRange, table: string): { start: string; end: string } {
  return preferred === "ideal"
    ? { start: `${table}.start_ideal_range_km`, end: `${table}.end_ideal_range_km` }
    : { start: `${table}.start_rated_range_km`, end: `${table}.end_rated_range_km` };
}

function carClause(carId?: number): { sql: string; params: number[] } {
  return carId === undefined ? { sql: "", params: [] } : { sql: " AND car_id = ?", params: [carId] };
}

/**
 * A CTE naming every bucket's bounds, so one grouped query can do the work of one
 * query per bucket.
 *
 * The bounds arrive as a JSON array of `[from, to)` pairs and `json_each` turns
 * them back into rows — one bind parameter whatever the bucket count, rather than
 * a `VALUES` list stitched together with string concatenation. `key` is the array
 * index, which is also the bucket's position in the caller's own array.
 */
const BUCKET_CTE = `WITH b(idx, lo, hi) AS (
    SELECT je.key, json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]')
    FROM json_each(?1) AS je
  )`;

/**
 * Per-period rollup. Buckets are computed in the user's time zone (see
 * shared/timeBuckets) and each one is aggregated by its exact UTC bounds.
 *
 * Two queries, not two per bucket: grouping the buckets in SQL rather than looping
 * over them in TypeScript is what keeps `period=day` over a year to a pair of round
 * trips instead of seven hundred and thirty.
 */
export async function periodStats(
  db: SqlDatabase,
  opts: {
    from: number;
    to: number;
    period: Period;
    timezone: string;
    carId?: number;
    preferredRange: PreferredRange;
    /**
     * Which day weeks start on, so grouping by week matches the week the viewer's
     * date range picker selected. Monday when the caller does not say.
     */
    firstDay?: FirstDay;
  },
): Promise<PeriodStatsDto> {
  const buckets = buildBuckets(
    opts.from,
    opts.to,
    opts.period,
    opts.timezone,
    undefined,
    opts.firstDay,
  );
  if (buckets.length === 0) return { period: opts.period, timezone: opts.timezone, buckets: [] };

  const range = rangeColumns(opts.preferredRange, "d");
  const bounds = JSON.stringify(buckets.map((b) => [b.from, b.to]));
  // ?1 is the bounds, so a car filter is ?2.
  const forCar = (table: string) => (opts.carId === undefined ? "" : ` AND ${table}.car_id = ?2`);
  const carParams = opts.carId === undefined ? [] : [opts.carId];

  const [drives, charges] = await Promise.all([
    db
      .prepare(
        `${BUCKET_CTE}
         SELECT b.idx AS idx, COUNT(d.id) AS count, SUM(d.distance) AS distance,
                SUM(d.duration_min) AS duration_min,
                SUM((${range.start} - ${range.end}) * c.efficiency) AS energy_kwh
         FROM b
         LEFT JOIN drives d
           ON d.start_date_at >= b.lo AND d.start_date_at < b.hi
              AND d.end_date_at IS NOT NULL${forCar("d")}
         LEFT JOIN cars c ON c.id = d.car_id
         GROUP BY b.idx`,
      )
      .bind(bounds, ...carParams)
      .all<{ idx: number; count: number; distance: number | null; duration_min: number | null; energy_kwh: number | null }>(),
    db
      .prepare(
        `${BUCKET_CTE}
         SELECT b.idx AS idx, COUNT(cp.id) AS count, SUM(${SESSION_ENERGY_KWH}) AS energy,
                SUM(cp.cost_cents) AS cost_cents
         FROM b
         LEFT JOIN charging_processes cp
           ON cp.start_date_at >= b.lo AND cp.start_date_at < b.hi
              AND cp.end_date_at IS NOT NULL AND ${HAS_ENERGY}${forCar("cp")}
         GROUP BY b.idx`,
      )
      .bind(bounds, ...carParams)
      .all<{ idx: number; count: number; energy: number | null; cost_cents: number | null }>(),
  ]);

  const drivesByIdx = new Map(drives.results.map((r) => [r.idx, r]));
  const chargesByIdx = new Map(charges.results.map((r) => [r.idx, r]));

  const rows = buckets.map((bucket, idx) => {
    const driven = drivesByIdx.get(idx);
    const charge = chargesByIdx.get(idx);

    const distanceKm = driven?.distance ?? null;
    const energyKwh = driven?.energy_kwh ?? null;
    // Already the per-session max summed in SQL, so it does not shift when the same
    // sessions are regrouped. Zero means the bucket held no session at all — the
    // LEFT JOIN's phantom row — which is a gap, not a 0 kWh charge.
    const chargedKwh = (charge?.energy ?? 0) || null;
    const costCents = charge?.cost_cents ?? null;

    return {
      key: bucket.key,
      label: bucket.label,
      from: bucket.from,
      driveCount: driven?.count ?? 0,
      distanceKm,
      durationMin: driven?.duration_min ?? null,
      energyUsedKwh: energyKwh,
      consumptionKwhPer100km: consumptionPer100km(energyKwh, distanceKm),
      chargeCount: charge?.count ?? 0,
      energyChargedKwh: chargedKwh,
      costCents,
      // Ratios are always recomputed from the summed numerator and denominator.
      // Averaging per-bucket ratios would be the average-of-averages bug.
      costPerKwhCents: costCents != null && chargedKwh ? costCents / chargedKwh : null,
      costPer100kmCents: costCents != null && distanceKm ? (costCents / distanceKm) * 100 : null,
    };
  });

  return { period: opts.period, timezone: opts.timezone, buckets: rows };
}

/** A session's location label, shared by the two orderings of the roll-up. */
const CHARGE_LOCATION_LABEL = "COALESCE(g.name, a.city, a.display_name, 'Unknown')";
const CHARGE_LOCATION_JOINS = `
  LEFT JOIN geofences g ON g.id = cp.geofence_id
  LEFT JOIN addresses a ON a.id = cp.address_id`;

/**
 * True for a session where any sample named Tesla as the charger brand.
 *
 * Not every car reports a brand — some never populate the field at all — so a zero
 * here can mean "no Supercharging" or "the car does not say". The two are told apart
 * by BRAND_REPORTED below, and the share is returned as null in the second case rather
 * than as a confident nought.
 */
const SUPERCHARGER = `EXISTS (SELECT 1 FROM charges WHERE charging_process_id = cp.id AND fast_charger_brand = 'Tesla')`;

interface LocationRow {
  label: string;
  count: number;
  energy: number | null;
  cost_cents: number | null;
}

function toLocation(row: LocationRow): ChargingLocationDto {
  return { label: row.label, count: row.count, energyKwh: row.energy ?? null, costCents: row.cost_cents ?? null };
}

/**
 * The charging roll-up: the AC/DC split, where the energy and the money went, the
 * SoC bands sessions start from, when charging happens, and the average DC taper.
 *
 * Cost per 100 km is the reason several of these figures exist — it is the only one
 * that compares against a petrol car — so the distance driven over the same window
 * is read here rather than left to the caller to line up separately.
 */
export async function chargingStats(
  db: SqlDatabase,
  opts: { from: number; to: number; carId?: number; timezone: string },
): Promise<ChargingStatsDto> {
  const car = carClause(opts.carId);
  const params = [opts.from, opts.to, ...car.params];
  const cpWhere = `cp.end_date_at IS NOT NULL AND ${HAS_ENERGY}
    AND cp.start_date_at >= ? AND cp.start_date_at < ?${car.sql ? " AND cp.car_id = ?" : ""}`;

  // Grouped by Supercharger as well as by current type, so the Supercharger share
  // of the spend falls out of the same pass rather than costing another query.
  const split = await db
    .prepare(
      `SELECT CASE WHEN ${DC_SESSION} THEN 'dc' ELSE 'ac' END AS kind,
              CASE WHEN ${SUPERCHARGER} THEN 1 ELSE 0 END AS supercharger,
              COUNT(*) AS count, SUM(${SESSION_ENERGY_KWH}) AS energy, SUM(cp.cost_cents) AS cost_cents,
              SUM(cp.duration_min) AS duration_min
       FROM charging_processes cp
       WHERE ${cpWhere}
       GROUP BY kind, supercharger`,
    )
    .bind(...params)
    .all<{
      kind: "ac" | "dc";
      supercharger: number;
      count: number;
      energy: number | null;
      cost_cents: number | null;
      duration_min: number | null;
    }>();

  const locations = await db
    .prepare(
      `SELECT ${CHARGE_LOCATION_LABEL} AS label,
              COUNT(*) AS count, SUM(${SESSION_ENERGY_KWH}) AS energy, SUM(cp.cost_cents) AS cost_cents
       FROM charging_processes cp ${CHARGE_LOCATION_JOINS}
       WHERE ${cpWhere}
       GROUP BY label ORDER BY energy DESC LIMIT 10`,
    )
    .bind(...params)
    .all<LocationRow>();

  // Ordered by spend, which is a different ten places: a cheap home charger tops the
  // energy table and a handful of motorway stops top this one.
  const byCost = await db
    .prepare(
      `SELECT ${CHARGE_LOCATION_LABEL} AS label,
              COUNT(*) AS count, SUM(${SESSION_ENERGY_KWH}) AS energy, SUM(cp.cost_cents) AS cost_cents
       FROM charging_processes cp ${CHARGE_LOCATION_JOINS}
       WHERE ${cpWhere} AND cp.cost_cents IS NOT NULL
       GROUP BY label ORDER BY cost_cents DESC LIMIT 10`,
    )
    .bind(...params)
    .all<LocationRow>();

  // Which 10 % battery bands sessions start from.
  const bands = await db
    .prepare(
      `SELECT (start_battery_level / 10) * 10 AS band, COUNT(*) AS count, SUM(${SESSION_ENERGY_KWH}) AS energy
       FROM charging_processes cp
       WHERE end_date_at IS NOT NULL AND start_battery_level IS NOT NULL
         AND start_date_at >= ? AND start_date_at < ?${car.sql}
       GROUP BY band ORDER BY band`,
    )
    .bind(...params)
    .all<{ band: number; count: number; energy: number | null }>();

  const distance = await db
    .prepare(
      `SELECT SUM(distance) AS distance FROM drives
       WHERE end_date_at IS NOT NULL AND start_date_at >= ? AND start_date_at < ?${car.sql}`,
    )
    .bind(...params)
    .first<{ distance: number | null }>();

  /*
    Session start instants, bucketed into local weekday and hour here rather than in
    SQL. A heatmap cell is not a contiguous range — "every Tuesday at 09:00" is
    fifty-two separate hours — so it cannot be expressed as the bucket bounds the
    rest of this module passes down, and SQLite has no time-zone database to do it
    with. One row per session is a small read: a heavy user charges a few hundred
    times a year, not a few hundred thousand.
  */
  const starts = await db
    .prepare(
      `SELECT cp.start_date_at AS at, ${SESSION_ENERGY_KWH} AS energy
       FROM charging_processes cp WHERE ${cpWhere}`,
    )
    .bind(...params)
    .all<{ at: number; energy: number | null }>();

  // Average DC power at each 10 % of the pack. Restricted to samples that were
  // actually delivering, so the idle minutes at either end of a session do not drag
  // the curve down.
  const curve = await db
    .prepare(
      `SELECT (ch.battery_level / 10) * 10 AS band, AVG(ch.charger_power) AS avg_power, COUNT(*) AS samples
       FROM charges ch
       JOIN charging_processes cp ON cp.id = ch.charging_process_id
       WHERE ${cpWhere} AND ch.battery_level IS NOT NULL AND ch.charger_power > 0
         AND ch.charger_phases IS NULL
       GROUP BY band ORDER BY band`,
    )
    .bind(...params)
    .all<{ band: number; avg_power: number | null; samples: number }>();

  const brandReported = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM charges ch JOIN charging_processes cp ON cp.id = ch.charging_process_id
                      WHERE ${cpWhere} AND ch.fast_charger_brand IS NOT NULL) AS reported`,
    )
    .bind(...params)
    .first<{ reported: number }>();

  const sumOf = (
    rows: typeof split.results,
    field: "count" | "energy" | "cost_cents" | "duration_min",
  ): number | null => {
    const present = rows.filter((row) => row[field] != null);
    if (present.length === 0) return null;
    return present.reduce((total, row) => total + (row[field] as number), 0);
  };

  const toSide = (kind: "ac" | "dc"): ChargingSideDto => {
    const rows = split.results.filter((row) => row.kind === kind);
    return {
      count: rows.reduce((total, row) => total + row.count, 0),
      energyKwh: sumOf(rows, "energy"),
      costCents: sumOf(rows, "cost_cents"),
      durationMin: sumOf(rows, "duration_min"),
    };
  };

  const totalCostCents = sumOf(split.results, "cost_cents");
  // Null, not zero, when the car never names a brand: "none of it" and "cannot say"
  // are different answers and only one of them is ours to give.
  const superchargerCostCents = brandReported?.reported
    ? sumOf(
        split.results.filter((row) => row.supercharger === 1),
        "cost_cents",
      )
    : null;

  const cells = new Map<string, { weekday: number; hour: number; count: number; energyKwh: number | null }>();
  for (const row of starts.results) {
    const { weekday, hour } = zonedWeekdayHour(row.at, opts.timezone);
    const key = `${weekday}-${hour}`;
    const cell = cells.get(key) ?? { weekday, hour, count: 0, energyKwh: null };
    cell.count += 1;
    if (row.energy != null) cell.energyKwh = (cell.energyKwh ?? 0) + row.energy;
    cells.set(key, cell);
  }

  const distanceKm = distance?.distance ?? null;

  return {
    ac: toSide("ac"),
    dc: toSide("dc"),
    topLocations: locations.results.map(toLocation),
    topByCost: byCost.results.map(toLocation),
    startSocBands: bands.results.map((r) => ({ band: r.band, count: r.count, energyKwh: r.energy ?? null })),
    totalCostCents,
    superchargerCostCents,
    distanceKm,
    costPer100kmCents:
      totalCostCents != null && distanceKm != null && distanceKm > 0 ? (totalCostCents / distanceKm) * 100 : null,
    heatmap: [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
    dcCurve: curve.results.map((r) => ({ band: r.band, avgPowerKw: r.avg_power ?? null, samples: r.samples })),
  };
}

/** Width of a temperature band, °C. */
const TEMP_BAND_C = 5;

/**
 * Consumption against outside temperature, plus net versus gross.
 *
 * Net is what the drives took out of the pack, derived the same way the drives list
 * derives it: range delta times the car's measured efficiency. Gross is what the wall
 * delivered over the same window, so charging losses are inside it — which is the
 * honest number for what a kilometre costs, and the one nothing in the app showed.
 */
export async function efficiencyStats(
  db: SqlDatabase,
  opts: { from: number; to: number; carId?: number; preferredRange: PreferredRange },
): Promise<EfficiencyStatsDto> {
  const car = carClause(opts.carId);
  const carSql = car.sql.replace("car_id", "d.car_id");
  const window = `d.end_date_at IS NOT NULL AND d.start_date_at >= ? AND d.start_date_at < ?${carSql}`;
  const params = [opts.from, opts.to, ...car.params];
  const energy = energyExpr(opts.preferredRange);

  const driven = await db
    .prepare(
      `SELECT SUM(d.distance) AS distance, SUM(${energy}) AS energy_kwh
       FROM drives d LEFT JOIN cars c ON c.id = d.car_id
       WHERE ${window}`,
    )
    .bind(...params)
    .first<{ distance: number | null; energy_kwh: number | null }>();

  const charged = await db
    .prepare(
      `SELECT SUM(charge_energy_added) AS added, SUM(charge_energy_used) AS used
       FROM charging_processes
       WHERE end_date_at IS NOT NULL AND start_date_at >= ? AND start_date_at < ?${car.sql}`,
    )
    .bind(...params)
    .first<{ added: number | null; used: number | null }>();

  /*
    Banded with FLOOR rather than integer division, which truncates towards zero: a
    drive at -3 °C would land in the 0 band and be averaged in with a mild day, which
    is exactly the comparison this panel exists to make.
  */
  const bands = await db
    .prepare(
      `SELECT CAST(FLOOR(d.outside_temp_avg / ${TEMP_BAND_C}.0) AS INTEGER) * ${TEMP_BAND_C} AS band,
              COUNT(*) AS drives, SUM(d.distance) AS distance, SUM(${energy}) AS energy_kwh
       FROM drives d LEFT JOIN cars c ON c.id = d.car_id
       WHERE ${window} AND d.outside_temp_avg IS NOT NULL AND d.distance > 0
       GROUP BY band ORDER BY band`,
    )
    .bind(...params)
    .all<{ band: number; drives: number; distance: number | null; energy_kwh: number | null }>();

  const distanceKm = driven?.distance ?? null;
  const per100 = (kwh: number | null) => consumptionPer100km(kwh, distanceKm);

  const added = charged?.added ?? null;
  const used = charged?.used ?? null;

  return {
    from: opts.from,
    to: opts.to,
    distanceKm,
    netKwhPer100km: per100(driven?.energy_kwh ?? null),
    grossKwhPer100km: per100(used),
    chargingLossShare: added != null && used != null && used > 0 ? 1 - added / used : null,
    bands: bands.results.map((row) => ({
      fromCelsius: row.band,
      drives: row.drives,
      distanceKm: row.distance ?? null,
      consumptionKwhPer100km: consumptionPer100km(row.energy_kwh, row.distance),
    })),
  };
}

/**
 * The odometer as a downsampled series. One reading per bucket rather than an
 * average: an odometer only goes up, so the highest reading in a bucket *is* the
 * value at the end of it, and averaging would round off the steps a road trip makes.
 */
export async function odometerSeries(
  db: SqlDatabase,
  opts: { carId: number; from: number; to: number; points: number },
): Promise<OdometerSeriesDto> {
  const bucketMs = bucketWidthFor(opts.from, opts.to, opts.points);

  const rows = await db
    .prepare(
      // CAST, as in chargeLevel: a bound divisor arrives as REAL, so relying on
      // integer division silently divides exactly and every sample becomes its own
      // bucket — downsampling that quietly does nothing.
      `SELECT CAST(date_at / ?4 AS INTEGER) AS bucket, MAX(odometer) AS odometer
       FROM positions
       WHERE car_id = ?1 AND date_at >= ?2 AND date_at < ?3 AND odometer IS NOT NULL
       GROUP BY bucket ORDER BY bucket`,
    )
    .bind(opts.carId, opts.from, opts.to, bucketMs)
    .all<{ bucket: number; odometer: number | null }>();

  return {
    from: opts.from,
    to: opts.to,
    bucketMs,
    points: rows.results.map((row) => ({ at: row.bucket * bucketMs, odometerKm: row.odometer ?? null })),
  };
}

/**
 * The address roll-up behind the Places page. Everything is counted over drive
 * arrivals — `drives.end_address_id` — because that is what a visit is: the car
 * stopped there. Counting every geocoded address instead would make a motorway
 * passed through look like a destination.
 *
 * Not windowed. "How much of the world has this car been to" is a lifetime question,
 * and a city visited twice three years ago is still a city visited.
 */
export async function placeStats(
  db: SqlDatabase,
  carId?: number,
  options?: { topLimit?: number },
): Promise<PlaceStatsDto> {
  const topLimit = options?.topLimit ?? 10;
  const car = carId === undefined ? { sql: "", params: [] as number[] } : { sql: " AND d.car_id = ?", params: [carId] };
  const arrivals = `FROM drives d JOIN addresses a ON a.id = d.end_address_id
                    WHERE d.end_date_at IS NOT NULL${car.sql}`;
  // The same arrivals, each carrying the geo-fence it landed in, if any. Matching
  // through `end_geofence_id` rather than re-testing coordinates keeps this in step
  // with the matcher: saving or deleting a geo-fence re-writes that column.
  const labelledArrivals = `FROM drives d JOIN addresses a ON a.id = d.end_address_id
                    LEFT JOIN geofences g ON g.id = d.end_geofence_id
                    WHERE d.end_date_at IS NOT NULL${car.sql}`;

  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS arrivals, COUNT(DISTINCT a.id) AS addresses, COUNT(DISTINCT a.city) AS cities,
              COUNT(DISTINCT a.state) AS states, COUNT(DISTINCT a.country) AS countries
       ${arrivals}`,
    )
    .bind(...car.params)
    .first<{ arrivals: number; addresses: number; cities: number; states: number; countries: number }>();

  /** Top values of one address column by arrivals. NULLs are not a place. */
  const rankBy = (column: string) =>
    db
      .prepare(
        `SELECT ${column} AS label, COUNT(*) AS visits, MAX(d.end_date_at) AS last_at
         ${arrivals} AND ${column} IS NOT NULL AND ${column} <> ''
         GROUP BY label ORDER BY visits DESC, last_at DESC LIMIT 10`,
      )
      .bind(...car.params)
      .all<{ label: string; visits: number; last_at: number | null }>();

  const [cities, countries] = await Promise.all([rankBy("a.city"), rankBy("a.country")]);

  // Which geo-fences sit in which city, by the arrivals that matched both. Kept as
  // rows rather than GROUP_CONCAT so a comma in a geo-fence name cannot split it.
  const cityFences = await db
    .prepare(
      `SELECT DISTINCT a.city AS label, g.name AS geofence
       ${labelledArrivals} AND a.city IS NOT NULL AND a.city <> '' AND g.name IS NOT NULL`,
    )
    .bind(...car.params)
    .all<{ label: string; geofence: string }>();
  const fencesByCity = new Map<string, string[]>();
  for (const row of cityFences.results) {
    fencesByCity.set(row.label, [...(fencesByCity.get(row.label) ?? []), row.geofence]);
  }

  const addressLabel = `COALESCE(NULLIF(TRIM(COALESCE(a.road,'') || ' ' || COALESCE(a.house_number,'')), ''),
                       a.name, a.display_name, 'Unknown')`;

  const recent = await db
    .prepare(
      `SELECT ${addressLabel} AS label,
              a.name AS name, a.city AS city, a.latitude AS latitude, a.longitude AS longitude,
              COUNT(*) AS visits, MAX(d.end_date_at) AS last_at, MAX(g.name) AS geofence
       ${labelledArrivals}
       GROUP BY a.id ORDER BY last_at DESC LIMIT 20`,
    )
    .bind(...car.params)
    .all<{
      label: string;
      name: string | null;
      city: string | null;
      latitude: number | null;
      longitude: number | null;
      visits: number;
      last_at: number;
      geofence: string | null;
    }>();

  // The candidates for the next geo-fence: the places most arrived at. The raw
  // geocoder response rides along and is parsed here rather than with json_extract,
  // because imported rows may hold anything and ten rows are nothing to parse.
  const top = await db
    .prepare(
      `SELECT ${addressLabel} AS label,
              a.name AS name, a.city AS city, a.latitude AS latitude, a.longitude AS longitude, a.raw AS raw,
              COUNT(*) AS visits, MAX(d.end_date_at) AS last_at, MAX(g.name) AS geofence
       ${labelledArrivals}
       GROUP BY a.id ORDER BY visits DESC, last_at DESC LIMIT ?`,
    )
    .bind(...car.params, topLimit)
    .all<{
      label: string;
      name: string | null;
      city: string | null;
      latitude: number | null;
      longitude: number | null;
      raw: string | null;
      visits: number;
      last_at: number;
      geofence: string | null;
    }>();

  const totalArrivals = counts?.arrivals ?? 0;
  const topPlaces = top.results.map((r, index) => {
    let category = guessCategory(r.raw);
    // Home is the one guess OSM cannot make: the tags say "a residential building",
    // not whose. But a single place holding a fifth of all lifetime arrivals, ahead
    // of every other, is home in all but name. Kept conservative — rank one, an
    // established history, and no tag saying it is something else.
    if (category === null && index === 0 && r.visits >= 5 && r.visits * 5 >= totalArrivals) {
      category = "home";
    }
    return {
      label: r.label,
      name: r.name,
      city: r.city,
      visits: r.visits,
      lastAt: r.last_at,
      latitude: r.latitude,
      longitude: r.longitude,
      geofence: r.geofence,
      category,
    };
  });

  return {
    counts: {
      addresses: counts?.addresses ?? 0,
      cities: counts?.cities ?? 0,
      states: counts?.states ?? 0,
      countries: counts?.countries ?? 0,
    },
    topCities: cities.results.map((r) => ({
      label: r.label,
      visits: r.visits,
      lastAt: r.last_at,
      geofences: fencesByCity.get(r.label) ?? [],
    })),
    topCountries: countries.results.map((r) => ({ label: r.label, visits: r.visits, lastAt: r.last_at })),
    recent: recent.results.map((r) => ({
      label: r.label,
      name: r.name,
      city: r.city,
      visits: r.visits,
      lastAt: r.last_at,
      latitude: r.latitude,
      longitude: r.longitude,
      geofence: r.geofence,
    })),
    topPlaces,
  };
}

/** Width of a speed histogram band, km/h. */
const SPEED_BAND_KMH = 20;

const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365.25;

/**
 * Drive aggregates: the typical drive, how fast the odometer is climbing and where
 * the car keeps going.
 *
 * The extrapolations divide by the span the drives themselves cover, not by the
 * window. Asking for a year when only ten weeks are logged would otherwise report a
 * fifth of the real rate — and this figure exists for lease limits and warranty
 * mileage, where a fifth is not a rounding error.
 */
export async function driveStats(
  db: SqlDatabase,
  opts: { from: number; to: number; carId?: number; preferredRange: PreferredRange },
): Promise<DriveStatsDto> {
  const car = carClause(opts.carId);
  // carClause writes a bare `car_id`, which is ambiguous once drives is aliased.
  const carSql = car.sql.replace("car_id", "d.car_id");
  const window = `d.end_date_at IS NOT NULL AND d.start_date_at >= ? AND d.start_date_at < ?${carSql}`;
  const params = [opts.from, opts.to, ...car.params];

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS count, SUM(d.distance) AS distance, MAX(d.speed_max) AS max_speed,
              SUM(${energyExpr(opts.preferredRange)}) AS energy_kwh,
              MIN(d.start_date_at) AS first_at, MAX(d.end_date_at) AS last_at
       FROM drives d LEFT JOIN cars c ON c.id = d.car_id
       WHERE ${window}`,
    )
    .bind(...params)
    .first<{
      count: number;
      distance: number | null;
      max_speed: number | null;
      energy_kwh: number | null;
      first_at: number | null;
      last_at: number | null;
    }>();

  // The middle drive by distance. SQLite has no median, and one ordered row at an
  // offset is cheaper than reading every distance back to sort in TypeScript.
  const median = await db
    .prepare(
      `SELECT d.distance AS distance FROM drives d
       WHERE ${window} AND d.distance IS NOT NULL
       ORDER BY d.distance
       LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM drives d WHERE ${window} AND d.distance IS NOT NULL)`,
    )
    .bind(...params, ...params)
    .first<{ distance: number | null }>();

  const bands = await db
    .prepare(
      `SELECT (CAST(p.speed AS INTEGER) / ${SPEED_BAND_KMH}) * ${SPEED_BAND_KMH} AS band, COUNT(*) AS count
       FROM positions p
       WHERE p.speed IS NOT NULL AND p.speed > 0 AND p.date_at >= ? AND p.date_at < ?
         ${opts.carId === undefined ? "" : " AND p.car_id = ?"}
       GROUP BY band ORDER BY band`,
    )
    .bind(...params)
    .all<{ band: number; count: number }>();

  const destinations = await db
    .prepare(
      `SELECT ${DRIVE_END_LABEL} AS label, ${DRIVE_END_REGION} AS region,
              COUNT(*) AS count, SUM(d.distance) AS distance
       FROM drives d ${DRIVE_JOINS}
       WHERE ${window} AND ${DRIVE_END_LABEL} IS NOT NULL
       GROUP BY label, region ORDER BY count DESC, distance DESC LIMIT 10`,
    )
    .bind(...params)
    .all<{ label: string; region: string | null; count: number; distance: number | null }>();

  const distanceKm = totals?.distance ?? null;
  const energyKwh = totals?.energy_kwh ?? null;

  // At least a day of span, and at least two distinct days of it, before a rate
  // means anything: one afternoon's driving extrapolates to a nonsense year.
  const span =
    totals?.first_at != null && totals.last_at != null ? (totals.last_at - totals.first_at) / DAY_MS : null;
  const observedDays = span != null && span >= 1 ? span : null;

  const perDay = (value: number | null) => (value != null && observedDays != null ? value / observedDays : null);
  const distancePerDayKm = perDay(distanceKm);

  return {
    from: opts.from,
    to: opts.to,
    count: totals?.count ?? 0,
    distanceKm,
    medianDistanceKm: median?.distance ?? null,
    maxSpeedKmh: totals?.max_speed ?? null,
    observedDays,
    distancePerDayKm,
    energyPerDayKwh: perDay(energyKwh),
    projectedMonthlyKm: distancePerDayKm == null ? null : distancePerDayKm * DAYS_PER_MONTH,
    projectedAnnualKm: distancePerDayKm == null ? null : distancePerDayKm * DAYS_PER_YEAR,
    speedBands: bands.results.map((row) => ({ fromKmh: row.band, count: row.count })),
    topDestinations: destinations.results.map((row) => ({
      label: row.label,
      region: row.region,
      count: row.count,
      distanceKm: row.distance ?? null,
    })),
  };
}

/** How far a health window reaches: recent enough to be current, long enough to span a season's swing. */
const HEALTH_WINDOW_MS = 90 * DAY_MS;
/** Sessions a window must hold before it beats simply taking the nearest few. */
const HEALTH_WINDOW_MIN = 4;
/** Nearest sessions to fall back on when the window is thinner than that. */
const HEALTH_FALLBACK_SESSIONS = 8;
/**
 * Smallest SoC span a tick-measured session may cover, percentage points.
 *
 * Every session carries some energy that never reached the cells, and dividing
 * by the span turns a fixed error into one that scales as `1/span`: the same
 * third of a kilowatt-hour is 1 kWh of capacity across 35 points and 5 kWh
 * across 7. Short sessions are not noisy, they are biased, and no amount of
 * them averages out — so a session has to fill a tenth of the pack to count,
 * which is where the endpoint path has always been.
 */
const MIN_TICK_SPAN = 10;
/** Smallest span when only the whole-percent session endpoints exist. */
const MIN_ENDPOINT_SPAN = 10;

/** Sessions worth measuring at all — completed, real energy, and a span the method can work with. */
const HEALTH_ELIGIBLE =
  `car_id = ?1 AND end_date_at IS NOT NULL AND charge_energy_added > 1
   AND start_battery_level IS NOT NULL AND end_battery_level IS NOT NULL
   AND end_battery_level - start_battery_level >= 5`;

/** A session's capacity measurement: the SoC span it covered and the energy that span took. */
type HealthPoint = {
  at: number;
  odometerKm: number | null;
  capacityKwh: number;
  rangeAt100Km: number | null;
  spanPct: number;
  energyKwh: number;
};

/**
 * One capacity figure for a set of sessions. With enough sessions and enough
 * variety in how much they filled, a least-squares slope of energy against
 * span: the intercept soaks up per-session overhead that a plain ratio would
 * book as capacity. Too few, or spans too alike for the intercept to be
 * identifiable, and it falls back to the median — which unlike a mean shrugs
 * off the odd interrupted session.
 */
function fitCapacityKwh(points: HealthPoint[]): number | null {
  if (points.length === 0) return null;
  const spans = points.map((p) => p.spanPct);
  const spread = Math.max(...spans) - Math.min(...spans);
  if (points.length >= HEALTH_WINDOW_MIN && spread >= 10) {
    const meanSpan = spans.reduce((a, b) => a + b, 0) / points.length;
    const meanEnergy = points.reduce((a, p) => a + p.energyKwh, 0) / points.length;
    let sxx = 0;
    let sxy = 0;
    for (const p of points) {
      const dx = p.spanPct - meanSpan;
      sxx += dx * dx;
      sxy += dx * (p.energyKwh - meanEnergy);
    }
    const fitted = (sxy / sxx) * 100;
    if (fitted > 10 && fitted < 250) return fitted;
  }
  const sorted = points.map((p) => p.capacityKwh).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Battery health. Usable capacity is derived per qualifying session as
 * energy added divided by the share of the pack it filled.
 *
 * The share is the treacherous half: session levels are whole percents, so on
 * a ten-point session the rounding alone is a ±10 % error. Where per-sample
 * charge rows exist the span is measured between level *ticks* — the first
 * sample at each percent — pinning both ends to a real transition and cutting
 * the error to the sampling interval. The first observed level is no tick
 * (the session merely started somewhere inside it), so measuring starts one
 * level up.
 *
 * The last percent is dropped for the opposite reason: it is not a percent. A
 * session that reaches its charge limit keeps drawing at full power while the
 * displayed level sits still, then jumps to the target and stops — so the final
 * percent absorbs half again what a percent costs, every time, and the span it
 * pretends to be is short by that much. Measuring to the second-to-last tick
 * ends the span on a transition the car actually made. Sessions the pack spent
 * being heated, or that began with usable capacity capped below the displayed
 * level, measure the weather rather than the pack and are dropped.
 *
 * Sessions without samples — imported history, mostly — have no ticks to trim
 * and fall back to the rounded endpoints, padded final percent included. They
 * read a little high, which is worth knowing if a car's log begins with an
 * import and ends with live polling: the baseline is the flattered end.
 *
 * The headline figures then come from a window at each end of the record, not
 * the last few sessions: capacity genuinely reads lower in winter, and a
 * five-session mean measures the season more than the pack.
 *
 * Each session also carries the odometer the car was on, read as the last
 * position before it rather than the highest one. The two agree — an odometer
 * only goes up — but `MAX(odometer)` has to visit every position ever logged
 * for the car, once per session, which on a car with a couple of hundred
 * thousand positions is tens of millions of row reads and several seconds. The
 * ordered lookup walks the (car_id, date_at) index backwards and stops at the
 * first row.
 */
export async function batteryHealth(
  db: SqlDatabase,
  opts: { carId: number; preferredRange: PreferredRange },
): Promise<BatteryHealthDto> {
  const range = rangeColumns(opts.preferredRange, "cp");

  const rows = await db
    .prepare(
      `SELECT cp.id AS id, cp.start_date_at AS at, cp.charge_energy_added AS energy,
              cp.start_battery_level AS start_soc, cp.end_battery_level AS end_soc,
              ${range.start} AS start_range, ${range.end} AS end_range,
              (SELECT p.odometer FROM positions p
                WHERE p.car_id = cp.car_id AND p.date_at <= cp.start_date_at AND p.odometer IS NOT NULL
                ORDER BY p.date_at DESC LIMIT 1) AS odometer
       FROM charging_processes cp
       WHERE ${HEALTH_ELIGIBLE}
       ORDER BY cp.start_date_at`,
    )
    .bind(opts.carId)
    .all<{
      id: number;
      at: number;
      energy: number;
      start_soc: number;
      end_soc: number;
      start_range: number | null;
      end_range: number | null;
      odometer: number | null;
    }>();

  // One row per session that has samples: the first tick, the last tick worth
  // trusting, the level the session opened on, and whether the heater ever ran.
  // `MIN(date_at)` is the lone aggregate in the tick CTE, so SQLite's bare
  // columns read from that earliest row — the moment the pack first showed each
  // level.
  const ticks = await db
    .prepare(
      `WITH tick AS (
         SELECT charging_process_id AS pid, battery_level AS level, MIN(date_at) AS at,
                charge_energy_added AS energy, usable_battery_level AS usable,
                battery_heater_on AS heater_on, battery_heater AS heater_alt
         FROM charges
         WHERE charging_process_id IN (SELECT id FROM charging_processes WHERE ${HEALTH_ELIGIBLE})
           AND battery_level IS NOT NULL
         GROUP BY charging_process_id, battery_level
       ),
       marked AS (
         SELECT tick.*,
                ROW_NUMBER() OVER (PARTITION BY pid ORDER BY level) AS rn,
                COUNT(*) OVER (PARTITION BY pid) AS n,
                MAX(MAX(COALESCE(heater_on, 0), COALESCE(heater_alt, 0)))
                  OVER (PARTITION BY pid) AS heated
         FROM tick
       )
       SELECT lo.pid AS pid, head.level AS start_level, head.usable AS start_usable,
              lo.level AS from_level, lo.energy AS from_energy,
              hi.level AS to_level, hi.energy AS to_energy, lo.heated AS heated
       FROM marked lo
       JOIN marked head ON head.pid = lo.pid AND head.rn = 1
       JOIN marked hi ON hi.pid = lo.pid AND hi.rn = hi.n - 1
       WHERE lo.rn = 2`,
    )
    .bind(opts.carId)
    .all<{
      pid: number;
      start_level: number;
      start_usable: number | null;
      from_level: number;
      from_energy: number;
      to_level: number;
      to_energy: number;
      heated: number;
    }>();
  const tickByPid = new Map(ticks.results.map((t) => [t.pid, t]));

  const points: HealthPoint[] = [];
  for (const r of rows.results) {
    const t = tickByPid.get(r.id);
    let spanPct: number;
    let energyKwh: number;
    if (t) {
      // A heated or cold-capped pack is a thermal measurement, however the span is taken.
      if (t.heated) continue;
      if (t.start_usable != null && t.start_usable < t.start_level) continue;
      const tickSpan = t.to_level - t.from_level;
      const tickEnergy = t.to_energy - t.from_energy;
      // Ticks are the better measurement, so a session that has them is measured
      // that way or not at all: the endpoints it would otherwise fall back to
      // are the very numbers the trimmed final percent was taken out of.
      if (!(tickSpan >= MIN_TICK_SPAN && tickEnergy > 0)) continue;
      spanPct = tickSpan;
      energyKwh = tickEnergy;
    } else {
      const socDelta = r.end_soc - r.start_soc;
      if (socDelta < MIN_ENDPOINT_SPAN) continue;
      spanPct = socDelta;
      energyKwh = r.energy;
    }
    const capacityKwh = (energyKwh / spanPct) * 100;
    // Guard against implausible values from partial or interrupted sessions.
    if (!(capacityKwh > 10 && capacityKwh < 250)) continue;
    const rangeAt100 = r.end_range != null && r.end_soc > 0 ? (r.end_range / r.end_soc) * 100 : null;
    points.push({ at: r.at, odometerKm: r.odometer, capacityKwh, rangeAt100Km: rangeAt100, spanPct, energyKwh });
  }

  const lastAt = points[points.length - 1]?.at;
  let recent = lastAt != null ? points.filter((p) => p.at >= lastAt - HEALTH_WINDOW_MS) : [];
  if (recent.length < HEALTH_WINDOW_MIN) recent = points.slice(-HEALTH_FALLBACK_SESSIONS);
  const firstAt = points[0]?.at;
  let earliest = firstAt != null ? points.filter((p) => p.at <= firstAt + HEALTH_WINDOW_MS) : [];
  if (earliest.length < HEALTH_WINDOW_MIN) earliest = points.slice(0, HEALTH_FALLBACK_SESSIONS);

  const currentCapacityKwh = fitCapacityKwh(recent);
  const originalCapacityKwh = fitCapacityKwh(earliest);

  // The first sessions on record are only as old as the data, not the car —
  // logging that starts three years in bakes those years' loss into the
  // baseline. The VIN's as-new figure reaches back to the factory, so where it
  // resolves it carries the honest since-new number. It stays approximate
  // (community data, and the measurement itself scatters), which is the DTO's
  // and the UI's caveat to carry. Where the VIN leaves several packs possible,
  // the owner's pick in the car's settings outranks the blended guess.
  const car = await db
    .prepare(
      "SELECT c.vin, s.usable_when_new_kwh AS chosen FROM cars c " +
        "LEFT JOIN car_settings s ON s.car_id = c.id WHERE c.id = ?",
    )
    .bind(opts.carId)
    .first<{ vin: string; chosen: number | null }>();
  const newCapacityKwh = car ? (car.chosen ?? decodeVin(car.vin).usableWhenNewKwh) : null;

  const currentRange = recent.map((p) => p.rangeAt100Km).filter((v): v is number => v != null);

  return {
    points: points.map(({ at, odometerKm, capacityKwh, rangeAt100Km }) => ({
      at,
      odometerKm,
      capacityKwh,
      rangeAt100Km,
    })),
    currentCapacityKwh,
    originalCapacityKwh,
    degradationPercent:
      currentCapacityKwh != null && originalCapacityKwh != null && originalCapacityKwh > 0
        ? ((originalCapacityKwh - currentCapacityKwh) / originalCapacityKwh) * 100
        : null,
    newCapacityKwh,
    degradationFromNewPercent:
      currentCapacityKwh != null && newCapacityKwh != null
        ? ((newCapacityKwh - currentCapacityKwh) / newCapacityKwh) * 100
        : null,
    currentRangeAt100Km:
      currentRange.length > 0 ? currentRange.reduce((a, b) => a + b, 0) / currentRange.length : null,
  };
}

/**
 * Vampire drain: range lost while the car sat idle between a drive ending and
 * the next drive or charge starting.
 */
export async function vampireDrain(
  db: SqlDatabase,
  opts: { carId: number; minHours: number; preferredRange: PreferredRange },
): Promise<VampireDrainDto> {
  const rangeCol = opts.preferredRange === "ideal" ? "ideal_battery_range_km" : "rated_battery_range_km";

  // Idle stretches are the gaps between consecutive drives, ignoring any gap
  // that contains a charge (which would mask the drain).
  const rows = await db
    .prepare(
      `WITH ends AS (
         SELECT d.id, d.end_date_at AS from_at, d.end_position_id,
                LEAD(d.start_date_at) OVER (ORDER BY d.start_date_at) AS to_at,
                LEAD(d.start_position_id) OVER (ORDER BY d.start_date_at) AS next_position_id
         FROM drives d WHERE d.car_id = ?1 AND d.end_date_at IS NOT NULL
       )
       SELECT e.from_at, e.to_at,
              p1.${rangeCol} AS start_range, p2.${rangeCol} AS end_range,
              p1.battery_level AS start_soc, p2.battery_level AS end_soc,
              p1.latitude, p1.longitude
       FROM ends e
       JOIN positions p1 ON p1.id = e.end_position_id
       JOIN positions p2 ON p2.id = e.next_position_id
       WHERE e.to_at IS NOT NULL
         AND (e.to_at - e.from_at) >= ?2
         AND p1.${rangeCol} IS NOT NULL AND p2.${rangeCol} IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM charging_processes cp
           WHERE cp.car_id = ?1 AND cp.start_date_at BETWEEN e.from_at AND e.to_at
         )
       ORDER BY e.from_at DESC LIMIT 200`,
    )
    .bind(opts.carId, opts.minHours * 3_600_000)
    .all<{
      from_at: number;
      to_at: number;
      start_range: number;
      end_range: number;
      start_soc: number | null;
      end_soc: number | null;
      latitude: number | null;
      longitude: number | null;
    }>();

  const periods = rows.results.map((r) => {
    const hours = (r.to_at - r.from_at) / 3_600_000;
    const rangeLostKm = r.start_range - r.end_range;
    return {
      fromAt: r.from_at,
      toAt: r.to_at,
      hours,
      rangeLostKm,
      rangeLostPerHourKm: hours > 0 ? rangeLostKm / hours : null,
      socLost: r.start_soc != null && r.end_soc != null ? r.start_soc - r.end_soc : null,
      latitude: r.latitude,
      longitude: r.longitude,
    };
  });

  const losses = periods.filter((p) => p.rangeLostPerHourKm != null).map((p) => p.rangeLostPerHourKm!);
  return {
    periods,
    averageLossPerHourKm: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
  };
}

/**
 * What the car was doing over a window: the online/asleep/offline spans from
 * `states`, with driving, charging and updating punched in on top. The
 * precedence rules live in core/stateTimeline; this only fetches the rows.
 */
export async function stateTimeline(
  db: SqlDatabase,
  opts: { carId: number; from: number; to: number; now: number },
): Promise<StateTimelineDto> {
  const { carId, from, to } = opts;
  // An unfinished span runs up to the present, never past it: the car is not
  // driving into the future just because the window ends there.
  const openEnd = Math.min(to, opts.now);

  /** Rows from one table that overlap the window, open-ended ones included. */
  const overlapping = async (
    table: string,
    state: TimelineState | null,
    /**
     * Cap on how long an *unfinished* row may be drawn for. The overlays outrank
     * the base states, so one drive a dying Worker left open would otherwise
     * paint every month since as driving and hide the charges underneath it —
     * which is precisely what it did. Past the cap the row is a fault rather
     * than a span, so the band falls back to what `states` recorded and the
     * Diagnostics card is left to report it. State spans have no cap: being
     * asleep for a fortnight is a fact, not a fault.
     */
    maxOpenMs?: number,
  ): Promise<Span[]> => {
    const rows = await db
      .prepare(
        `SELECT ${state ? "NULL AS state" : "state"}, start_date_at, end_date_at FROM ${table}
         WHERE car_id = ?1 AND start_date_at < ?3 AND COALESCE(end_date_at, ?3) >= ?2`,
      )
      .bind(carId, from, to)
      .all<{ state: string | null; start_date_at: number; end_date_at: number | null }>();

    return rows.results
      .map((r) => ({
        state: (state ?? (r.state as TimelineState)) as TimelineState,
        from: r.start_date_at,
        to:
          r.end_date_at ??
          (maxOpenMs === undefined ? openEnd : Math.min(openEnd, r.start_date_at + maxOpenMs)),
      }))
      .filter((s) => s.to > s.from);
  };

  const [base, drives, charges, updates] = await Promise.all([
    overlapping("states", null),
    overlapping("drives", "driving", STALE_MS),
    overlapping("charging_processes", "charging", STALE_MS),
    overlapping("updates", "updating", STALE_MS),
  ]);

  const spans = mergeSpans([...base, ...drives, ...charges, ...updates], from, to);

  return {
    from,
    to,
    spans,
    totals: totalsFor(spans, from, to),
    current: await currentState(db, carId, opts.now),
  };
}

/**
 * The state the car is in right now. Read from the open-ended rows directly
 * rather than from the band, so it stays correct when the window is historical.
 *
 * Overlays older than `STALE_MS` are not consulted: "driving, for 8 weeks" is not
 * the state the car is in, it is a row that never got an end, and answering with
 * it would go on hiding whatever the car is actually doing.
 */
async function currentState(
  db: SqlDatabase,
  carId: number,
  now: number,
): Promise<StateTimelineDto["current"]> {
  const open = await Promise.all(
    (
      [
        ["updates", "updating"],
        ["drives", "driving"],
        ["charging_processes", "charging"],
      ] as const
    ).map(async ([table, state]) => {
      const row = await db
        .prepare(
          `SELECT start_date_at FROM ${table} WHERE car_id = ? AND end_date_at IS NULL
             AND start_date_at >= ?
           ORDER BY start_date_at DESC LIMIT 1`,
        )
        .bind(carId, now - STALE_MS)
        .first<{ start_date_at: number }>();
      return row ? { state: state as TimelineState, since: row.start_date_at } : null;
    }),
  );

  // In precedence order, so the first open overlay wins.
  const overlay = open.find((o) => o !== null);
  if (overlay) return overlay;

  const row = await db
    .prepare(
      `SELECT state, start_date_at FROM states WHERE car_id = ? AND end_date_at IS NULL
       ORDER BY start_date_at DESC LIMIT 1`,
    )
    .bind(carId)
    .first<{ state: string; start_date_at: number }>();
  return row ? { state: row.state as TimelineState, since: row.start_date_at } : null;
}

/** Bucket widths a time axis reads well at, smallest first. */
const BUCKET_WIDTHS = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
  7 * 86_400_000,
];

/** The narrowest readable bucket that keeps the window under `points` buckets. */
function bucketWidthFor(from: number, to: number, points: number): number {
  const span = Math.max(1, to - from);
  return BUCKET_WIDTHS.find((width) => span / width <= points) ?? BUCKET_WIDTHS[BUCKET_WIDTHS.length - 1]!;
}

/**
 * State of charge over a window. Averaged into fixed buckets so a year of
 * samples is one small response rather than a hundred thousand points.
 *
 * The high-SoC share is over *sampled* buckets, not wall-clock time: a sleeping
 * car reports nothing, so there is no sample to attribute that time to.
 */
export async function chargeLevel(
  db: SqlDatabase,
  opts: { carId: number; from: number; to: number; points: number; highSocThreshold: number },
): Promise<ChargeLevelDto> {
  const bucketMs = bucketWidthFor(opts.from, opts.to, opts.points);

  const rows = await db
    .prepare(
      `SELECT CAST(date_at / ?4 AS INTEGER) AS bucket,
              AVG(battery_level) AS level, AVG(usable_battery_level) AS usable
       FROM positions
       WHERE car_id = ?1 AND date_at >= ?2 AND date_at < ?3 AND battery_level IS NOT NULL
       GROUP BY bucket ORDER BY bucket`,
    )
    .bind(opts.carId, opts.from, opts.to, bucketMs)
    .all<{ bucket: number; level: number | null; usable: number | null }>();

  const extremes = await db
    .prepare(
      `SELECT MIN(battery_level) AS low, MAX(battery_level) AS high, AVG(battery_level) AS mean
       FROM positions
       WHERE car_id = ?1 AND date_at >= ?2 AND date_at < ?3 AND battery_level IS NOT NULL`,
    )
    .bind(opts.carId, opts.from, opts.to)
    .first<{ low: number | null; high: number | null; mean: number | null }>();

  const points = rows.results.map((r) => ({
    at: r.bucket * bucketMs,
    batteryLevel: r.level,
    usableBatteryLevel: r.usable,
  }));
  const high = points.filter((p) => p.batteryLevel != null && p.batteryLevel >= opts.highSocThreshold);

  return {
    from: opts.from,
    to: opts.to,
    bucketMs,
    points,
    minLevel: extremes?.low ?? null,
    maxLevel: extremes?.high ?? null,
    averageLevel: extremes?.mean ?? null,
    highSocShare: points.length > 0 ? high.length / points.length : null,
    highSocThreshold: opts.highSocThreshold,
  };
}

/** Software update history. */
export async function updateHistory(db: SqlDatabase, carId?: number): Promise<UpdateDto[]> {
  const car = carClause(carId);
  const rows = await db
    .prepare(
      `SELECT id, car_id, start_date_at, end_date_at, version FROM updates
       WHERE end_date_at IS NOT NULL${car.sql} ORDER BY end_date_at DESC LIMIT 100`,
    )
    .bind(...car.params)
    .all<{ id: number; car_id: number; start_date_at: number; end_date_at: number; version: string | null }>();

  return rows.results.map((r, index, all) => {
    const previous = all[index + 1];
    return {
      id: r.id,
      carId: r.car_id,
      startAt: r.start_date_at,
      endAt: r.end_date_at,
      version: r.version,
      daysSincePrevious: previous ? (r.end_date_at - previous.end_date_at) / 86_400_000 : null,
    };
  });
}
