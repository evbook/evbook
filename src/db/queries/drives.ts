import type { DriveDetailDto, DriveDto, DriveListDto, DrivesRouteDto, PreferredRange } from "@shared/api-types";
import { consumptionPer100km, consumptionSql, METERED_DISTANCE } from "../../core/derive/consumption";
import { placeRegion, placeSpot } from "./address";
import { uncertainty, uncertaintyColumns, type UncertaintyRow } from "./uncertainty";
import type { SqlDatabase } from "../../platform/ports";

/** Read queries for drives. Distances are km, energies kWh. */

type DriveSort = "date" | "distance" | "duration" | "speed" | "consumption" | "energy" | "battery";

export interface DriveFilters {
  carId?: number;
  from?: number;
  to?: number;
  minDistanceKm?: number;
  maxDistanceKm?: number;
  minDurationMin?: number;
  maxDurationMin?: number;
  minConsumption?: number;
  maxConsumption?: number;
  /** Only drives that started inside this geofence. */
  startGeofenceId?: number;
  /** Only drives that ended inside this geofence. */
  endGeofenceId?: number;
  search?: string;
  sort: DriveSort;
  dir: "asc" | "desc";
  limit: number;
  offset: number;
  preferredRange: PreferredRange;
}

interface DriveRow extends UncertaintyRow {
  id: number;
  origin_reconstructed: number;
  car_id: number;
  start_date_at: number;
  end_date_at: number | null;
  distance: number | null;
  duration_min: number | null;
  speed_max: number | null;
  power_max: number | null;
  start_km: number | null;
  end_km: number | null;
  outside_temp_avg: number | null;
  inside_temp_avg: number | null;
  start_range_km: number | null;
  end_range_km: number | null;
  start_battery_level: number | null;
  end_battery_level: number | null;
  efficiency: number | null;
  start_label: string | null;
  end_label: string | null;
  start_region: string | null;
  end_region: string | null;
}

/** Exported for the timeline log, which shows drives beside the other event kinds. */
export const JOINS = `
  LEFT JOIN cars c ON c.id = d.car_id
  LEFT JOIN geofences sg ON sg.id = d.start_geofence_id
  LEFT JOIN geofences eg ON eg.id = d.end_geofence_id
  LEFT JOIN addresses sa ON sa.id = d.start_address_id
  LEFT JOIN addresses ea ON ea.id = d.end_address_id`;

/**
 * The state of charge the drive began with. A reconstructed origin is a place,
 * not a reading, so for those it is the first sample that has one.
 */
const START_BATTERY = `COALESCE(sp.battery_level, CASE WHEN d.origin_reconstructed = 1 THEN
  (SELECT fp.battery_level FROM positions fp
   WHERE fp.drive_id = d.id AND fp.battery_level IS NOT NULL ORDER BY fp.date_at LIMIT 1) END)`;

/** Prefer a geofence name, then the address, then nothing. */
export const START_LABEL = `COALESCE(sg.name, ${placeSpot("sa")})`;
export const END_LABEL = `COALESCE(eg.name, ${placeSpot("ea")})`;

/**
 * The town each end sits in, shown dimmed after the label. A geofence carries
 * none: it is what the owner called the place, and "Home" is the whole answer.
 */
export const START_REGION = `CASE WHEN sg.name IS NULL THEN ${placeRegion("sa")} END`;
export const END_REGION = `CASE WHEN eg.name IS NULL THEN ${placeRegion("ea")} END`;

/**
 * What free-text search matches, which is deliberately wider than what is
 * displayed: the whole address, so "Berlin" finds a drive whose label is the road
 * it ended on. Shared with the timeline log so searching means one thing.
 */
export const SEARCH_START = "COALESCE(sg.name, sa.display_name, '')";
export const SEARCH_END = "COALESCE(eg.name, ea.display_name, '')";

function rangeColumns(preferred: PreferredRange): { start: string; end: string } {
  return preferred === "ideal"
    ? { start: "d.start_ideal_range_km", end: "d.end_ideal_range_km" }
    : { start: "d.start_rated_range_km", end: "d.end_rated_range_km" };
}

/** Energy used, derived from range delta times the car's measured efficiency. */
export function energyExpr(preferred: PreferredRange): string {
  const { start, end } = rangeColumns(preferred);
  return `((${start} - ${end}) * c.efficiency)`;
}

function consumptionExpr(preferred: PreferredRange): string {
  return consumptionSql(energyExpr(preferred), "d.distance");
}

/** Allowlisted sort expressions — never interpolate user input into SQL. */
function orderBy(sort: DriveSort, dir: "asc" | "desc", preferred: PreferredRange): string {
  const direction = dir === "asc" ? "ASC" : "DESC";
  const columns: Record<DriveSort, string> = {
    date: "d.start_date_at",
    distance: "d.distance",
    duration: "d.duration_min",
    speed: "d.speed_max",
    energy: energyExpr(preferred),
    consumption: consumptionExpr(preferred),
    battery: "d.start_battery_level",
  };
  // Nulls last regardless of direction, then a stable tiebreak on id.
  return `${columns[sort]} IS NULL, ${columns[sort]} ${direction}, d.id ${direction}`;
}

function buildWhere(filters: DriveFilters): { sql: string; params: (string | number)[] } {
  const clauses = ["d.end_date_at IS NOT NULL"];
  const params: (string | number)[] = [];
  const consumption = consumptionExpr(filters.preferredRange);

  const add = (sql: string, value: number | string | undefined) => {
    if (value === undefined) return;
    clauses.push(sql);
    params.push(value);
  };

  add("d.car_id = ?", filters.carId);
  add("d.start_date_at >= ?", filters.from);
  // Half-open, like the bucketed queries in stats.ts: the picker resolves a preset
  // to one calendar period, so adjacent windows share a boundary instant. An
  // inclusive end would put a drive that started exactly at midnight in both the
  // month before and the month after, and the months would not sum to the total.
  add("d.start_date_at < ?", filters.to);
  add("d.distance >= ?", filters.minDistanceKm);
  add("d.distance <= ?", filters.maxDistanceKm);
  add("d.duration_min >= ?", filters.minDurationMin);
  add("d.duration_min <= ?", filters.maxDurationMin);
  add(`${consumption} >= ?`, filters.minConsumption);
  add(`${consumption} <= ?`, filters.maxConsumption);
  // The geofence the endpoint was matched to, which is what the picker offers —
  // an address the car happens to have stopped at is not a place the owner named.
  add("d.start_geofence_id = ?", filters.startGeofenceId);
  add("d.end_geofence_id = ?", filters.endGeofenceId);

  if (filters.search) {
    clauses.push(`(${SEARCH_START} LIKE ? OR ${SEARCH_END} LIKE ?)`);
    const like = `%${filters.search}%`;
    params.push(like, like);
  }
  return { sql: clauses.join(" AND "), params };
}

function toDto(row: DriveRow): DriveDto {
  const rangeUsed =
    row.start_range_km != null && row.end_range_km != null ? row.start_range_km - row.end_range_km : null;
  const energyUsedKwh = rangeUsed != null && row.efficiency != null ? rangeUsed * row.efficiency : null;
  const consumptionKwhPer100km = consumptionPer100km(energyUsedKwh, row.distance);

  return {
    id: row.id,
    carId: row.car_id,
    startAt: row.start_date_at,
    endAt: row.end_date_at,
    distanceKm: row.distance,
    durationMin: row.duration_min,
    speedMaxKmh: row.speed_max,
    powerMaxKw: row.power_max,
    startKm: row.start_km,
    endKm: row.end_km,
    outsideTempAvg: row.outside_temp_avg,
    insideTempAvg: row.inside_temp_avg,
    startRangeKm: row.start_range_km,
    endRangeKm: row.end_range_km,
    startBatteryLevel: row.start_battery_level,
    endBatteryLevel: row.end_battery_level,
    energyUsedKwh,
    consumptionKwhPer100km,
    startLabel: row.start_label,
    endLabel: row.end_label,
    startRegion: row.start_region,
    endRegion: row.end_region,
    ...uncertainty(row),
    originReconstructed: row.origin_reconstructed === 1,
  };
}

export async function listDrives(db: SqlDatabase, filters: DriveFilters): Promise<DriveListDto> {
  const { start, end } = rangeColumns(filters.preferredRange);
  const where = buildWhere(filters);

  const rows = await db
    .prepare(
      `SELECT d.id, d.car_id, d.start_date_at, d.end_date_at, d.distance, d.duration_min,
              d.speed_max, d.power_max, d.start_km, d.end_km, d.outside_temp_avg, d.inside_temp_avg,
              ${start} AS start_range_km, ${end} AS end_range_km,
              ${START_BATTERY} AS start_battery_level, ep.battery_level AS end_battery_level,
              ${uncertaintyColumns("d")}, d.origin_reconstructed,
              c.efficiency AS efficiency,
              ${START_LABEL} AS start_label, ${END_LABEL} AS end_label,
              ${START_REGION} AS start_region, ${END_REGION} AS end_region
       FROM drives d ${JOINS}
       LEFT JOIN positions sp ON sp.id = d.start_position_id
       LEFT JOIN positions ep ON ep.id = d.end_position_id
       WHERE ${where.sql}
       ORDER BY ${orderBy(filters.sort, filters.dir, filters.preferredRange)}
       LIMIT ? OFFSET ?`,
    )
    .bind(...where.params, filters.limit, filters.offset)
    .all<DriveRow>();

  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS count, SUM(d.distance) AS distance, SUM(d.duration_min) AS duration_min,
              SUM(${energyExpr(filters.preferredRange)}) AS energy_kwh,
              ${METERED_DISTANCE(energyExpr(filters.preferredRange))} AS metered_distance
       FROM drives d ${JOINS}
       WHERE ${where.sql}`,
    )
    .bind(...where.params)
    .first<{
      count: number;
      distance: number | null;
      duration_min: number | null;
      energy_kwh: number | null;
      metered_distance: number | null;
    }>();

  // Bounds drive the range sliders, and are computed over everything logged for
  // the selected car rather than the current filter, so the handles stay put
  // while the user drags them.
  const boundsWhere = filters.carId === undefined ? "" : " AND d.car_id = ?";
  const boundsParams = filters.carId === undefined ? [] : [filters.carId];
  const bounds = await db
    .prepare(
      `SELECT MIN(d.distance) AS min_distance, MAX(d.distance) AS max_distance,
              MIN(d.duration_min) AS min_duration, MAX(d.duration_min) AS max_duration,
              MIN(${consumptionExpr(filters.preferredRange)}) AS min_consumption,
              MAX(${consumptionExpr(filters.preferredRange)}) AS max_consumption
       FROM drives d LEFT JOIN cars c ON c.id = d.car_id
       WHERE d.end_date_at IS NOT NULL${boundsWhere}`,
    )
    .bind(...boundsParams)
    .first<{
      min_distance: number | null;
      max_distance: number | null;
      min_duration: number | null;
      max_duration: number | null;
      min_consumption: number | null;
      max_consumption: number | null;
    }>();

  const distanceKm = totals?.distance ?? null;
  const energyKwh = totals?.energy_kwh ?? null;

  return {
    drives: rows.results.map(toDto),
    totals: {
      count: totals?.count ?? 0,
      distanceKm,
      durationMin: totals?.duration_min ?? null,
      energyKwh,
      consumptionKwhPer100km: consumptionPer100km(energyKwh, totals?.metered_distance ?? null),
    },
    bounds: {
      distanceKm: { min: bounds?.min_distance ?? 0, max: bounds?.max_distance ?? 0 },
      durationMin: { min: bounds?.min_duration ?? 0, max: bounds?.max_duration ?? 0 },
      consumption: { min: bounds?.min_consumption ?? 0, max: bounds?.max_consumption ?? 0 },
    },
  };
}

/**
 * Combined route across the filtered drives, plus what charging happened in the
 * same window. This is what replaced the separate trip-report page.
 */
export async function drivesRoute(db: SqlDatabase, filters: DriveFilters): Promise<DrivesRouteDto> {
  const where = buildWhere(filters);

  const span = await db
    .prepare(
      `SELECT MIN(d.start_date_at) AS from_at, MAX(COALESCE(d.end_date_at, d.start_date_at)) AS to_at
       FROM drives d ${JOINS} WHERE ${where.sql}`,
    )
    .bind(...where.params)
    .first<{ from_at: number | null; to_at: number | null }>();

  // Thin the track so a long window still renders quickly — in SQL, not after
  // the fact. A year of drives is two hundred thousand positions, and reading
  // them all into the Worker to keep one in every hundred and forty costs far
  // more than the count that decides the stride. Sampling on `id` rather than
  // on row order keeps it to one pass: ids are handed out in time order, so
  // every Nth id is an even sample of the track.
  const positionsIn = `p.drive_id IN (SELECT d.id FROM drives d ${JOINS} WHERE ${where.sql})
         AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL`;

  const counted = await db
    .prepare(`SELECT COUNT(*) AS n FROM positions p WHERE ${positionsIn}`)
    .bind(...where.params)
    .first<{ n: number }>();
  const stride = Math.max(1, Math.ceil((counted?.n ?? 0) / 1500));

  // Elevation comes off the thinned sample, not off every position: it costs
  // nothing here, and the highest point of a journey is not going to hide between
  // two samples a few seconds apart.
  const points = await db
    .prepare(
      `SELECT p.latitude, p.longitude, p.elevation FROM positions p
       WHERE ${positionsIn} AND p.id % ? = 0
       ORDER BY p.date_at`,
    )
    .bind(...where.params, stride)
    .all<{ latitude: number; longitude: number; elevation: number | null }>();
  const path = points.results.map((p) => ({ latitude: p.latitude, longitude: p.longitude }));
  const elevations = points.results.map((p) => p.elevation).filter((value): value is number => value != null);

  let charging = {
    count: 0,
    energyKwh: null as number | null,
    durationMin: null as number | null,
    costCents: null as number | null,
  };
  if (span?.from_at != null && span.to_at != null) {
    const carClause = filters.carId === undefined ? "" : " AND car_id = ?";
    const carParams = filters.carId === undefined ? [] : [filters.carId];
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS count, SUM(charge_energy_added) AS energy, SUM(duration_min) AS duration_min,
                SUM(cost_cents) AS cost_cents
         FROM charging_processes
         WHERE end_date_at IS NOT NULL AND start_date_at >= ? AND start_date_at <= ?${carClause}`,
      )
      .bind(span.from_at, span.to_at, ...carParams)
      .first<{ count: number; energy: number | null; duration_min: number | null; cost_cents: number | null }>();
    charging = {
      count: row?.count ?? 0,
      energyKwh: row?.energy ?? null,
      durationMin: row?.duration_min ?? null,
      costCents: row?.cost_cents ?? null,
    };
  }

  return {
    fromAt: span?.from_at ?? null,
    toAt: span?.to_at ?? null,
    path,
    charging,
    minElevationM: elevations.length > 0 ? Math.min(...elevations) : null,
    maxElevationM: elevations.length > 0 ? Math.max(...elevations) : null,
  };
}

export async function getDrive(
  db: SqlDatabase,
  id: number,
  preferredRange: PreferredRange,
  maxPoints = 500,
): Promise<DriveDetailDto | null> {
  const { start, end } = rangeColumns(preferredRange);

  const row = await db
    .prepare(
      `SELECT d.id, d.car_id, d.start_date_at, d.end_date_at, d.distance, d.duration_min,
              d.speed_max, d.power_max, d.start_km, d.end_km, d.outside_temp_avg, d.inside_temp_avg,
              ${start} AS start_range_km, ${end} AS end_range_km,
              ${START_BATTERY} AS start_battery_level, ep.battery_level AS end_battery_level,
              ${uncertaintyColumns("d")}, d.origin_reconstructed,
              sp.latitude AS start_latitude, sp.longitude AS start_longitude,
              ep.latitude AS end_latitude, ep.longitude AS end_longitude,
              d.start_geofence_id, d.end_geofence_id,
              c.efficiency AS efficiency,
              ${START_LABEL} AS start_label, ${END_LABEL} AS end_label,
              ${START_REGION} AS start_region, ${END_REGION} AS end_region
       FROM drives d ${JOINS}
       LEFT JOIN positions sp ON sp.id = d.start_position_id
       LEFT JOIN positions ep ON ep.id = d.end_position_id
       WHERE d.id = ?`,
    )
    .bind(id)
    .first<
      DriveRow & {
        start_latitude: number | null;
        start_longitude: number | null;
        end_latitude: number | null;
        end_longitude: number | null;
        start_geofence_id: number | null;
        end_geofence_id: number | null;
      }
    >();
  if (!row) return null;

  const total = await db
    .prepare("SELECT COUNT(*) AS count FROM positions WHERE drive_id = ?")
    .bind(id)
    .first<{ count: number }>();

  // Downsample by taking every Nth row so long drives stay cheap to chart.
  const stride = Math.max(1, Math.ceil((total?.count ?? 0) / maxPoints));
  const points = await db
    .prepare(
      `SELECT date_at, latitude, longitude, speed, power, battery_level, usable_battery_level,
              odometer, outside_temp, inside_temp, elevation,
              ideal_battery_range_km, rated_battery_range_km
       FROM (
         SELECT *, ROW_NUMBER() OVER (ORDER BY date_at) AS rn FROM positions WHERE drive_id = ?
       )
       WHERE (rn - 1) % ? = 0 OR rn = ?
       ORDER BY date_at`,
    )
    .bind(id, stride, total?.count ?? 1)
    .all<{
      date_at: number;
      latitude: number | null;
      longitude: number | null;
      speed: number | null;
      power: number | null;
      battery_level: number | null;
      usable_battery_level: number | null;
      odometer: number | null;
      outside_temp: number | null;
      inside_temp: number | null;
      elevation: number | null;
      ideal_battery_range_km: number | null;
      rated_battery_range_km: number | null;
    }>();

  return {
    ...toDto(row),
    startLatitude: row.start_latitude,
    startLongitude: row.start_longitude,
    endLatitude: row.end_latitude,
    endLongitude: row.end_longitude,
    startGeofenceId: row.start_geofence_id,
    endGeofenceId: row.end_geofence_id,
    positionCount: total?.count ?? 0,
    positions: points.results.map((p) => ({
      at: p.date_at,
      latitude: p.latitude,
      longitude: p.longitude,
      speedKmh: p.speed,
      powerKw: p.power,
      batteryLevel: p.battery_level,
      usableBatteryLevel: p.usable_battery_level,
      odometerKm: p.odometer,
      outsideTemp: p.outside_temp,
      insideTemp: p.inside_temp,
      elevation: p.elevation,
      rangeKm: preferredRange === "ideal" ? p.ideal_battery_range_km : p.rated_battery_range_km,
    })),
  };
}

/** Ordered positions for a GPX export. */
export async function getDriveTrack(
  db: SqlDatabase,
  id: number,
): Promise<{ startAt: number; points: { at: number; lat: number; lon: number; elevation: number | null }[] } | null> {
  const drive = await db
    .prepare("SELECT start_date_at FROM drives WHERE id = ?")
    .bind(id)
    .first<{ start_date_at: number }>();
  if (!drive) return null;

  const rows = await db
    .prepare(
      "SELECT date_at, latitude, longitude, elevation FROM positions " +
        "WHERE drive_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY date_at",
    )
    .bind(id)
    .all<{ date_at: number; latitude: number; longitude: number; elevation: number | null }>();

  return {
    startAt: drive.start_date_at,
    points: rows.results.map((r) => ({ at: r.date_at, lat: r.latitude, lon: r.longitude, elevation: r.elevation })),
  };
}
