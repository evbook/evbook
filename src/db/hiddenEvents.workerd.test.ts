import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { reconstructHiddenEvents } from "./hiddenEvents";

/**
 * The sweep that records what happened while nobody could read the car. The
 * history here is written row by row, the way the logger leaves it: drives with
 * their samples, parked rows between them, and the gaps an outage leaves.
 */

const CAR_ID = 41;
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const T0 = NOW - 10 * 24 * HOUR;

async function reset(): Promise<void> {
  for (const table of ["charges", "charging_processes", "positions", "drives", "states", "geofences", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, 11, 21, 'VIN41', 'Gap', ?, ?)",
  )
    .bind(CAR_ID, NOW, NOW)
    .run();
  await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
  // The origin sweep is done; this one has not started.
  await env.DB.prepare("UPDATE settings SET drive_origin_swept_before = 0, gaps_swept_until = NULL WHERE id = 1").run();
}

async function position(
  at: number,
  km: number,
  soc: number,
  driveId: number | null = null,
  lat = 52.5,
): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude, odometer, battery_level) " +
      "VALUES (?, ?, ?, ?, 13.4, ?, ?) RETURNING id",
  )
    .bind(CAR_ID, driveId, at, lat, km, soc)
    .first<{ id: number }>();
  return row!.id;
}

/** A settled drive from `at`, `km` long, one sample a minute. */
async function drive(at: number, startKm: number, km: number, soc: number): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?) RETURNING id")
    .bind(CAR_ID, at)
    .first<{ id: number }>();
  const first = await position(at, startKm, soc, row!.id);
  const last = await position(at + 10 * 60_000, startKm + km, soc - 2, row!.id, 52.6);
  await env.DB.prepare(
    "UPDATE drives SET end_date_at = ?, start_km = ?, end_km = ?, distance = ?, duration_min = 10, " +
      "start_position_id = ?, end_position_id = ? WHERE id = ?",
  )
    .bind(at + 10 * 60_000, startKm, startKm + km, km, first, last, row!.id)
    .run();
  return row!.id;
}

async function reconstructed(table: "drives" | "charging_processes") {
  return (
    await env.DB.prepare(`SELECT * FROM ${table} WHERE reconstructed = 1 ORDER BY start_date_at`).all<
      Record<string, number | null>
    >()
  ).results;
}

/** Runs the sweep until it has caught up with `NOW`. */
async function sweep(): Promise<number> {
  let recorded = 0;
  for (let i = 0; i < 10; i++) recorded += (await reconstructHiddenEvents(env.DB, NOW)).recorded;
  return recorded;
}

describe("hidden-event sweep", () => {
  beforeEach(reset);

  it("records a drive the odometer shows between two readings, with no duration", async () => {
    await drive(T0, 1000, 10, 80);
    // Parked at 1010 km; next seen the morning after at 1043 km, parked elsewhere.
    const before = await position(T0 + 2 * HOUR, 1010, 78);
    const after = await position(T0 + 14 * HOUR, 1043, 70, null, 52.9);
    await drive(T0 + 15 * HOUR, 1043, 5, 70);

    expect(await sweep()).toBe(1);
    const [row] = await reconstructed("drives");
    expect(row).toMatchObject({
      distance: 33,
      duration_min: null,
      start_km: 1010,
      end_km: 1043,
      start_position_id: before,
      end_position_id: after,
      start_after_at: T0 + 2 * HOUR,
      start_before_at: T0 + 14 * HOUR,
      end_after_at: T0 + 2 * HOUR,
      end_before_at: T0 + 14 * HOUR,
    });
    // Energy is unknown, not zero: nobody read the battery meanwhile.
    expect(row!.start_rated_range_km).toBeNull();
  });

  it("records a charge the state of charge shows, priced as a range", async () => {
    await env.DB.prepare(
      "INSERT INTO geofences (id, name, latitude, longitude, radius, billing_type, cost_per_unit, inserted_at, updated_at) " +
        "VALUES (5, 'Home', 52.5, 13.4, 100, 'per_kwh', 0.30, ?, ?)",
    )
      .bind(NOW, NOW)
      .run();
    // A measured session to learn the capacity from: 50 kWh over 70 points.
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, " +
        "start_battery_level, end_battery_level) VALUES (?, ?, ?, 50, 10, 80)",
    )
      .bind(CAR_ID, T0 - 48 * HOUR, T0 - 40 * HOUR)
      .run();
    await position(T0, 1000, 40);
    await position(T0 + 9 * HOUR, 1000, 80);

    expect(await sweep()).toBe(1);
    const [row] = await reconstructed("charging_processes");
    expect(row).toMatchObject({
      start_battery_level: 40,
      end_battery_level: 80,
      charge_energy_added: null,
      duration_min: null,
      geofence_id: 5,
    });
    // 39–41 points of a ~71.4 kWh pack at €0.30, losses allowed for on top.
    expect(row!.cost_cents).toBeGreaterThan(800);
    expect(row!.cost_max_cents).toBeGreaterThan(row!.cost_cents!);
  });

  it("adds nothing twice when rewound, and nothing for what was seen", async () => {
    await drive(T0, 1000, 10, 80);
    await position(T0 + 2 * HOUR, 1010, 78);
    await position(T0 + 14 * HOUR, 1043, 70);
    // A parked row inside a recorded drive's span, out of step with it.
    const seen = await drive(T0 + 20 * HOUR, 1043, 8, 70);
    await position(T0 + 20 * HOUR + 60_000, 1045, 69);

    expect(await sweep()).toBe(1);
    await env.DB.prepare("UPDATE settings SET gaps_swept_until = NULL WHERE id = 1").run();
    expect(await sweep()).toBe(0);
    expect(await reconstructed("drives")).toHaveLength(1);
    expect((await reconstructed("drives"))[0]!.id).not.toBe(seen);
  });

  it("waits for the origin sweep, which may extend a drive over the same gap", async () => {
    await position(T0, 1000, 80);
    await position(T0 + 5 * HOUR, 1040, 72);
    await env.DB.prepare("UPDATE settings SET drive_origin_swept_before = NULL WHERE id = 1").run();
    expect(await sweep()).toBe(0);
    await env.DB.prepare("UPDATE settings SET drive_origin_swept_before = 0 WHERE id = 1").run();
    expect(await sweep()).toBe(1);
  });

  it("leaves the newest gap to the live logger, and a hiatus alone", async () => {
    // Weeks apart: a logging hiatus, not an event.
    await position(T0 - 30 * 24 * HOUR, 500, 80);
    await position(T0, 1000, 80);
    // An hour ago: the poller may still be closing it.
    await position(NOW - HOUR, 1020, 75);
    expect(await sweep()).toBe(0);
  });
});
