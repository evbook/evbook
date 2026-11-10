import { env } from "cloudflare:test";
import { clearTables } from "./db";

/**
 * Row builders for logged drives and charging sessions, shared by the specs that
 * cover the list, detail, filter and costing endpoints. Everything is written
 * straight to D1: these fixtures stand in for what the logger would have
 * recorded, so the specs can assert on reads alone.
 *
 * Each builder takes the car id it belongs to, so suites can keep to their own
 * car and stay independent of each other.
 */

export interface SeedCarOptions {
  eid?: number;
  vid?: number;
  vin?: string;
  name?: string;
  /** kWh per km of rated range; drives the derived consumption figures. */
  efficiency?: number | null;
  timezone?: string;
  insertedAt?: number;
}

/** Empties every logged table and registers one car with default settings. */
export async function resetLoggedCar(carId: number, opts: SeedCarOptions = {}): Promise<void> {
  await clearTables(
    "charges",
    "charging_processes",
    "positions",
    "drives",
    "states",
    "updates",
    "geofences",
    "addresses",
    "cars",
  );
  await env.DB.prepare("UPDATE settings SET preferred_range='rated', unit_of_length='km', timezone=? WHERE id=1")
    .bind(opts.timezone ?? "UTC")
    .run();
  const at = opts.insertedAt ?? 0;
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, efficiency, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      carId,
      opts.eid ?? carId * 10,
      opts.vid ?? carId * 10 + 1,
      opts.vin ?? `VIN${carId}`,
      opts.name ?? `Car ${carId}`,
      opts.efficiency ?? null,
      at,
      at,
    )
    .run();
  await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (?)").bind(carId).run();
}

/**
 * A completed drive with a four-point position track — speeds, power, odometer,
 * ranges and temperatures — for the detail, GPX and geocoding paths.
 */
export async function seedDrive(
  carId: number,
  opts: {
    startAt: number;
    distance?: number;
    startLat?: number;
    /** The named places each end was matched to, as the logger would have set them. */
    startGeofenceId?: number;
    endGeofenceId?: number;
  },
): Promise<number> {
  const startAt = opts.startAt;
  const distance = opts.distance ?? 20;
  const lat = opts.startLat ?? 52.52;

  const drive = await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?) RETURNING id")
    .bind(carId, startAt)
    .first<{ id: number }>();
  const driveId = drive!.id;

  const ids: number[] = [];
  for (const i of [0, 1, 2, 3]) {
    const row = await env.DB.prepare(
      "INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude, speed, power, odometer, " +
        "battery_level, rated_battery_range_km, ideal_battery_range_km, outside_temp, inside_temp) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(
        carId,
        driveId,
        startAt + i * 60_000,
        lat + i * 0.01,
        13.4 + i * 0.01,
        60 + i,
        30,
        1000 + (distance / 3) * i,
        80 - i,
        300 - i * 5,
        320 - i * 5,
        12,
        21,
      )
      .first<{ id: number }>();
    ids.push(row!.id);
  }

  await env.DB.prepare(
    "UPDATE drives SET end_date_at = ?, distance = ?, duration_min = 3, speed_max = 63, power_max = 30, " +
      "start_km = 1000, end_km = ?, start_position_id = ?, end_position_id = ?, " +
      "start_rated_range_km = 300, end_rated_range_km = 285, start_ideal_range_km = 320, end_ideal_range_km = 305, " +
      "outside_temp_avg = 12, inside_temp_avg = 21, start_geofence_id = ?, end_geofence_id = ? WHERE id = ?",
  )
    .bind(
      startAt + 3 * 60_000,
      distance,
      1000 + distance,
      ids[0],
      ids[ids.length - 1],
      opts.startGeofenceId ?? null,
      opts.endGeofenceId ?? null,
      driveId,
    )
    .run();

  return driveId;
}

/** A named place, for the sessions that should be grouped under it. */
export async function seedGeofence(opts: {
  name: string;
  latitude: number;
  longitude: number;
  radius?: number;
}): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO geofences (name, latitude, longitude, radius, inserted_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 0, 0) RETURNING id",
  )
    .bind(opts.name, opts.latitude, opts.longitude, opts.radius ?? 100)
    .first<{ id: number }>();
  return row!.id;
}

/**
 * A charging session with five samples and a position, for the detail view and
 * the costing endpoints. Energy used is always energy added plus one kWh; pass
 * `phases: null` for a session that should be classified as DC, coordinates to
 * put it somewhere other than the default spot, and `located: false` for one
 * logged without a position at all.
 */
export async function seedCharge(
  carId: number,
  opts: {
    startAt: number;
    phases?: number | null;
    /**
     * Whether the car reported a fast charger present. Defaults to what the phase
     * count implies, and is set explicitly for the cases where the two disagree —
     * real AC sessions that report no phase count, which is what made the old
     * "no phases means DC" rule label home charging as DC.
     */
    fastCharger?: boolean;
    /** Zero writes a session that was plugged in and never drew a watt. */
    energy?: number;
    lat?: number;
    lng?: number;
    located?: boolean;
    geofenceId?: number;
  },
): Promise<number> {
  const startAt = opts.startAt;
  const energy = opts.energy ?? 10;
  const phases = opts.phases === undefined ? 3 : opts.phases;
  const fastCharger = opts.fastCharger ?? phases == null;
  // A session that added nothing also drew nothing, or it would have added something.
  const power = energy === 0 ? 0 : 11;

  const position =
    opts.located === false
      ? null
      : await env.DB.prepare(
          "INSERT INTO positions (car_id, date_at, latitude, longitude) VALUES (?, ?, ?, ?) RETURNING id",
        )
          .bind(carId, startAt, opts.lat ?? 52.52, opts.lng ?? 13.405)
          .first<{ id: number }>();

  const cproc = await env.DB.prepare(
    "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, charge_energy_used, " +
      "duration_min, start_battery_level, end_battery_level, start_rated_range_km, end_rated_range_km, position_id, " +
      "geofence_id) VALUES (?, ?, ?, ?, ?, 30, 50, 75, 200, 280, ?, ?) RETURNING id",
  )
    .bind(
      carId,
      startAt,
      startAt + 30 * 60_000,
      energy,
      energy === 0 ? 0 : energy + 1,
      position?.id ?? null,
      opts.geofenceId ?? null,
    )
    .first<{ id: number }>();

  for (let i = 0; i < 5; i++) {
    await env.DB.prepare(
      // fast_charger_present tracks phases, because that is how a real car reports it:
      // a DC stall means no phase count and a fast charger present. The two are not
      // interchangeable, though — see DC_SESSION in db/queries/charges.
      "INSERT INTO charges (charging_process_id, date_at, battery_level, charge_energy_added, charger_power, " +
        "charger_voltage, charger_actual_current, charger_phases, ideal_battery_range_km, fast_charger_type, " +
        "fast_charger_present, battery_temp_min, battery_temp_max) VALUES (?, ?, ?, ?, ?, 230, 16, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        cproc!.id,
        startAt + i * 60_000,
        50 + i * 5,
        (energy / 4) * i,
        power,
        phases,
        200 + i * 20,
        phases == null ? "Combo" : "<invalid>",
        fastCharger ? 1 : 0,
        // Warming as the session runs, the coldest module trailing the warmest.
        18 + i * 0.5,
        19 + i * 0.5,
      )
      .run();
  }
  return cproc!.id;
}

/**
 * A drive whose distance, duration, top speed and range used are all set
 * explicitly, so a set of them differs on every sortable and filterable
 * dimension. Two positions each, which is what the combined route counts.
 */
export async function seedComparableDrive(
  carId: number,
  opts: { at: number; distance: number; durationMin: number; speedMax: number; rangeUsed: number; lat?: number },
): Promise<number> {
  const drive = await env.DB.prepare(
    "INSERT INTO drives (car_id, start_date_at, end_date_at, distance, duration_min, speed_max, " +
      "start_km, end_km, start_rated_range_km, end_rated_range_km) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 300, ?) RETURNING id",
  )
    .bind(
      carId,
      opts.at,
      opts.at + opts.durationMin * 60_000,
      opts.distance,
      opts.durationMin,
      opts.speedMax,
      opts.distance,
      300 - opts.rangeUsed,
    )
    .first<{ id: number }>();

  for (let i = 0; i < 2; i++) {
    await env.DB.prepare(
      "INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude, battery_level) VALUES (?, ?, ?, ?, 13.4, ?)",
    )
      .bind(carId, drive!.id, opts.at + i * 60_000, (opts.lat ?? 52.5) + i * 0.01, 80 - i * 5)
      .run();
  }
  return drive!.id;
}

/** A session whose energy, duration and cost are all set explicitly. */
export async function seedComparableCharge(
  carId: number,
  opts: { at: number; energy: number; durationMin: number; costCents: number | null },
): Promise<number> {
  const cproc = await env.DB.prepare(
    "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, charge_energy_used, " +
      "duration_min, start_battery_level, end_battery_level, cost_cents) VALUES (?, ?, ?, ?, ?, ?, 30, 80, ?) RETURNING id",
  )
    .bind(
      carId,
      opts.at,
      opts.at + opts.durationMin * 60_000,
      opts.energy,
      opts.energy,
      opts.durationMin,
      opts.costCents,
    )
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO charges (charging_process_id, date_at, charge_energy_added, charger_power, charger_phases, ideal_battery_range_km) " +
      "VALUES (?, ?, ?, 11, 3, 200)",
  )
    .bind(cproc!.id, opts.at, opts.energy)
    .run();
  return cproc!.id;
}
