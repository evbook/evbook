import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "./repo";
import { createCharge, createPosition } from "../core/tesla/payload";
import { charging, driving, parked } from "../../test/fixtures";

/**
 * Exercises the D1 write layer against a real (local) SQLite database so the
 * aggregation SQL for drive close and charge completion is covered.
 */

const T0 = 1_700_000_000_000;
const CAR_ID = 1;

async function reset() {
  for (const table of [
    "charges",
    "charging_processes",
    "positions",
    "drives",
    "states",
    "updates",
    "geofences",
    "cars",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, 10, 20, 'VIN1', 'Bro', ?, ?)",
  )
    .bind(CAR_ID, T0, T0)
    .run();
  await env.DB.prepare("INSERT INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
}

function repo() {
  return new Repo(env.DB, CAR_ID);
}

describe("state timeline", () => {
  beforeEach(reset);

  it("keeps exactly one open state row per car", async () => {
    const r = repo();
    await r.startState("online", T0);
    await r.startState("asleep", T0 + 60_000);

    const rows = await env.DB.prepare(
      "SELECT state, start_date_at, end_date_at FROM states ORDER BY start_date_at",
    ).all<{
      state: string;
      start_date_at: number;
      end_date_at: number | null;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ state: "online", end_date_at: T0 + 60_000 });
    expect(rows.results[1]).toMatchObject({ state: "asleep", end_date_at: null });
  });

  it("is a no-op when the state has not changed", async () => {
    const r = repo();
    await r.startState("online", T0);
    await r.startState("online", T0 + 60_000);
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM states").first<{ count: number }>())!;
    expect(count).toBe(1);
  });

  it("never writes an end before the start", async () => {
    const r = repo();
    await r.startState("online", T0);
    // A car can report a timestamp older than when we opened the state row.
    await r.startState("asleep", T0 - 60_000);
    const row = (await env.DB.prepare("SELECT end_date_at FROM states WHERE state = 'online'").first<{
      end_date_at: number;
    }>())!;
    expect(row.end_date_at).toBe(T0);
  });
});

describe("drive aggregation", () => {
  beforeEach(reset);

  async function recordDrive(samples: { at: number; odometer: number; speed?: number; idealRange?: number }[]) {
    const r = repo();
    const driveId = await r.openDrive(samples[0]!.at);
    await r.insertPositions(
      samples.map((s) => ({
        driveId,
        attrs: createPosition(
          driving({ at: s.at, odometer: s.odometer, speed: s.speed ?? 30, idealRange: s.idealRange ?? 200 }),
        ),
      })),
    );
    return { r, driveId };
  }

  it("computes distance, duration and extremes from the positions", async () => {
    const { r, driveId } = await recordDrive([
      { at: T0, odometer: 1000, speed: 10, idealRange: 200 },
      { at: T0 + 5 * 60_000, odometer: 1010, speed: 75, idealRange: 195 },
      { at: T0 + 10 * 60_000, odometer: 1020, speed: 40, idealRange: 190 },
    ]);

    const result = await r.closeDrive(driveId);
    expect(result.deleted).toBe(false);
    expect(result.durationMin).toBe(10);

    const drive = (await env.DB.prepare("SELECT * FROM drives WHERE id = ?")
      .bind(driveId)
      .first<Record<string, number>>())!;
    // 20 miles of odometer travel, stored as km.
    expect(drive.distance).toBeCloseTo(32.19, 1);
    expect(drive.start_km).toBeCloseTo(1609.34, 1);
    expect(drive.end_km).toBeCloseTo(1641.53, 1);
    expect(drive.speed_max).toBe(121); // 75 mph
    expect(drive.start_ideal_range_km).toBeCloseTo(321.87, 1);
    expect(drive.end_ideal_range_km).toBeCloseTo(305.78, 1);
    expect(drive.outside_temp_avg).toBeCloseTo(12.5, 5);
  });

  it("takes first and last by time, not by value", async () => {
    // Deliberately insert out of chronological order.
    const { r, driveId } = await recordDrive([
      { at: T0 + 10 * 60_000, odometer: 1020 },
      { at: T0, odometer: 1000 },
      { at: T0 + 5 * 60_000, odometer: 1010 },
    ]);
    await r.closeDrive(driveId);
    const drive = (await env.DB.prepare("SELECT start_km, end_km FROM drives WHERE id = ?")
      .bind(driveId)
      .first<{ start_km: number; end_km: number }>())!;
    expect(drive.start_km).toBeLessThan(drive.end_km);
  });

  it("discards a drive that never moved", async () => {
    const { r, driveId } = await recordDrive([
      { at: T0, odometer: 1000 },
      { at: T0 + 60_000, odometer: 1000 },
    ]);
    const result = await r.closeDrive(driveId);
    expect(result.deleted).toBe(true);
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM drives").first<{ count: number }>())!;
    expect(count).toBe(0);
  });

  it("discards a drive with a single position", async () => {
    const { r, driveId } = await recordDrive([{ at: T0, odometer: 1000 }]);
    expect((await r.closeDrive(driveId)).deleted).toBe(true);
  });

  it("keeps the positions of a discarded drive", async () => {
    const { r, driveId } = await recordDrive([
      { at: T0, odometer: 1000 },
      { at: T0 + 60_000, odometer: 1000 },
    ]);
    await r.closeDrive(driveId);
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM positions").first<{ count: number }>())!;
    expect(count).toBe(2);
  });

  it("links start and end geofences", async () => {
    await env.DB.prepare(
      "INSERT INTO geofences (id, name, latitude, longitude, radius, inserted_at, updated_at) VALUES (1, 'Home', 52.52, 13.405, 200, ?, ?)",
    )
      .bind(T0, T0)
      .run();

    const r = repo();
    const driveId = await r.openDrive(T0);
    await r.insertPositions([
      { driveId, attrs: createPosition(driving({ at: T0, odometer: 1000, latitude: 52.52, longitude: 13.405 })) },
      {
        driveId,
        attrs: createPosition(driving({ at: T0 + 60_000, odometer: 1010, latitude: 48.85, longitude: 2.35 })),
      },
    ]);
    await r.closeDrive(driveId);

    const drive = (await env.DB.prepare("SELECT start_geofence_id, end_geofence_id FROM drives WHERE id = ?")
      .bind(driveId)
      .first<{ start_geofence_id: number | null; end_geofence_id: number | null }>())!;
    expect(drive.start_geofence_id).toBe(1);
    expect(drive.end_geofence_id).toBeNull();
  });
});

describe("drive origin reconstruction", () => {
  beforeEach(reset);

  // The car parked here an hour before the drive; positions store km.
  const PARKED_AT = T0;
  const FIRST_AT = T0 + 3_600_000;

  async function parkThenDrive(o: { parkedMiles?: number; firstMiles?: number } = {}) {
    const r = repo();
    const parkedAttrs = createPosition(
      parked({ at: PARKED_AT, odometer: o.parkedMiles ?? 10_000, latitude: 52.52, longitude: 13.405 }),
    );
    await r.insertPositions([{ driveId: null, attrs: parkedAttrs }]);
    const first = createPosition(
      driving({ at: FIRST_AT, odometer: o.firstMiles ?? 10_000.3, latitude: 52.53, longitude: 13.42 }),
    );
    const driveId = await r.openDrive(first.date_at, first);
    return { r, driveId, parkedAttrs, first };
  }

  it("prepends the parked point, backdated, when the odometer shows an unseen stretch", async () => {
    const { driveId, parkedAttrs, first } = await parkThenDrive();

    const origin = (await env.DB.prepare(
      "SELECT date_at, latitude, longitude, odometer, speed, battery_level FROM positions WHERE drive_id = ? ORDER BY date_at",
    )
      .bind(driveId)
      .first<Record<string, number | null>>())!;
    expect(origin.latitude).toBe(52.52);
    expect(origin.longitude).toBe(13.405);
    expect(origin.odometer).toBe(parkedAttrs.odometer);
    // Between the parked row and the first sample, never touching either.
    expect(origin.date_at!).toBeGreaterThan(PARKED_AT);
    expect(origin.date_at!).toBeLessThan(first.date_at);
    // Telemetry stays unknown — the row is a location, not a reading.
    expect(origin.speed).toBeNull();
    expect(origin.battery_level).toBeNull();

    const drive = (await env.DB.prepare("SELECT start_date_at FROM drives WHERE id = ?")
      .bind(driveId)
      .first<{ start_date_at: number }>())!;
    expect(drive.start_date_at).toBe(origin.date_at);
  });

  it("feeds the origin into the close aggregation", async () => {
    const { r, driveId, parkedAttrs, first } = await parkThenDrive();
    const second = createPosition(
      driving({ at: FIRST_AT + 60_000, odometer: 10_001, latitude: 52.54, longitude: 13.44 }),
    );
    await r.insertPositions([
      { driveId, attrs: first },
      { driveId, attrs: second },
    ]);
    await r.closeDrive(driveId);

    const drive = (await env.DB.prepare(
      "SELECT start_km, distance, start_position_id, start_date_at FROM drives WHERE id = ?",
    )
      .bind(driveId)
      .first<Record<string, number>>())!;
    // The unseen stretch counts: distance runs from the parked odometer.
    expect(drive.start_km).toBeCloseTo(parkedAttrs.odometer!, 3);
    expect(drive.distance).toBeCloseTo(second.odometer! - parkedAttrs.odometer!, 3);
    expect(drive.start_date_at).toBeLessThan(first.date_at);
    const startPos = (await env.DB.prepare("SELECT latitude FROM positions WHERE id = ?")
      .bind(drive.start_position_id)
      .first<{ latitude: number }>())!;
    expect(startPos.latitude).toBe(52.52);
  });

  it("does not invent an origin without evidence", async () => {
    const r = repo();
    // No prior position at all.
    const first = createPosition(driving({ at: FIRST_AT, odometer: 10_000.3 }));
    const bare = await r.openDrive(first.date_at, first);
    let { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM positions WHERE drive_id = ?")
      .bind(bare)
      .first<{ count: number }>())!;
    expect(count).toBe(0);

    // Parked next door on the odometer: nothing meaningful was missed.
    const close = await parkThenDrive({ parkedMiles: 10_000, firstMiles: 10_000.01 });
    ({ count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM positions WHERE drive_id = ?")
      .bind(close.driveId)
      .first<{ count: number }>())!);
    expect(count).toBe(0);

    // The import path passes no sample and never reconstructs.
    const importStyle = await r.openDrive(FIRST_AT);
    ({ count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM positions WHERE drive_id = ?")
      .bind(importStyle)
      .first<{ count: number }>())!);
    expect(count).toBe(0);
  });
});

describe("charge session aggregation", () => {
  beforeEach(reset);

  async function recordSession(count: number, energyPerStep = 0.5) {
    const r = repo();
    const cprocId = await r.openChargingProcess(T0, createPosition(charging({ at: T0 })));
    const rows = Array.from({ length: count }, (_, i) =>
      createCharge(
        charging({
          at: T0 + i * 60_000,
          chargeEnergyAdded: i * energyPerStep,
          batteryLevel: 50 + i,
          idealRange: 150 + i * 2,
        }),
      ),
    );
    await r.insertCharges(cprocId, rows);
    return { r, cprocId };
  }

  it("computes energy, duration and battery levels", async () => {
    const { r, cprocId } = await recordSession(21);
    const result = await r.completeChargingProcess(cprocId);
    expect(result.durationMin).toBe(20);
    expect(result.energyAdded).toBeCloseTo(10, 2);

    const cproc = (await env.DB.prepare("SELECT * FROM charging_processes WHERE id = ?")
      .bind(cprocId)
      .first<Record<string, number | null>>())!;
    expect(cproc.start_battery_level).toBe(50);
    expect(cproc.end_battery_level).toBe(70);
    expect(cproc.charge_energy_used).toBeGreaterThan(0);
    expect(cproc.outside_temp_avg).toBeCloseTo(12.5, 5);
    expect(cproc.end_date_at).toBe(T0 + 20 * 60_000);
  });

  it("stores a location snapshot for the session", async () => {
    const { cprocId } = await recordSession(3);
    const cproc = (await env.DB.prepare("SELECT position_id FROM charging_processes WHERE id = ?")
      .bind(cprocId)
      .first<{ position_id: number | null }>())!;
    expect(cproc.position_id).not.toBeNull();
  });

  it("applies a per-kWh geofence cost", async () => {
    await env.DB.prepare(
      "INSERT INTO geofences (id, name, latitude, longitude, radius, billing_type, cost_per_unit, session_fee_cents, inserted_at, updated_at) " +
        "VALUES (1, 'Home', 52.52, 13.405, 200, 'per_kwh', 0.3, 100, ?, ?)",
    )
      .bind(T0, T0)
      .run();

    const { r, cprocId } = await recordSession(21);
    await r.completeChargingProcess(cprocId);

    const cproc = (await env.DB.prepare(
      "SELECT geofence_id, cost_cents, charge_energy_used FROM charging_processes WHERE id = ?",
    )
      .bind(cprocId)
      .first<{ geofence_id: number | null; cost_cents: number | null; charge_energy_used: number }>())!;
    expect(cproc.geofence_id).toBe(1);
    // Cost is billed on the greater of energy added and energy used.
    const expected = Math.round(Math.max(10, cproc.charge_energy_used) * 0.3 * 100) + 100;
    expect(cproc.cost_cents).toBe(expected);
  });

  it("handles a session with no samples", async () => {
    const r = repo();
    const cprocId = await r.openChargingProcess(T0, createPosition(charging({ at: T0 })));
    const result = await r.completeChargingProcess(cprocId);
    expect(result.energyAdded).toBeNull();
    const cproc = (await env.DB.prepare("SELECT end_date_at FROM charging_processes WHERE id = ?")
      .bind(cprocId)
      .first<{ end_date_at: number | null }>())!;
    expect(cproc.end_date_at).not.toBeNull();
  });

  it("cascades charge rows when a session is deleted", async () => {
    const { cprocId } = await recordSession(4);
    await env.DB.prepare("DELETE FROM charging_processes WHERE id = ?").bind(cprocId).run();
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM charges").first<{ count: number }>())!;
    expect(count).toBe(0);
  });
});

describe("efficiency", () => {
  beforeEach(reset);

  it("derives kWh per km once enough comparable sessions exist", async () => {
    // Eight sessions all implying 0.15 kWh/km against the rated range.
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare(
        "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, duration_min, " +
          "end_battery_level, start_rated_range_km, end_rated_range_km) VALUES (?, ?, ?, 15, 60, 80, 100, 200)",
      )
        .bind(CAR_ID, T0 + i * 86_400_000, T0 + i * 86_400_000 + 3_600_000)
        .run();
    }
    await repo().recalculateEfficiency();
    const car = (await env.DB.prepare("SELECT efficiency FROM cars WHERE id = ?").bind(CAR_ID).first<{
      efficiency: number | null;
    }>())!;
    expect(car.efficiency).toBeCloseTo(0.15, 5);
  });

  it("stays unset while there is too little data", async () => {
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, charge_energy_added, duration_min, end_battery_level, " +
        "start_rated_range_km, end_rated_range_km) VALUES (?, ?, 15, 60, 80, 100, 200)",
    )
      .bind(CAR_ID, T0)
      .run();
    await repo().recalculateEfficiency();
    const car = (await env.DB.prepare("SELECT efficiency FROM cars WHERE id = ?").bind(CAR_ID).first<{
      efficiency: number | null;
    }>())!;
    expect(car.efficiency).toBeNull();
  });

  it("ignores short sessions and near-full batteries", async () => {
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare(
        "INSERT INTO charging_processes (car_id, start_date_at, charge_energy_added, duration_min, end_battery_level, " +
          "start_rated_range_km, end_rated_range_km) VALUES (?, ?, 15, 5, 99, 100, 200)",
      )
        .bind(CAR_ID, T0 + i * 86_400_000)
        .run();
    }
    await repo().recalculateEfficiency();
    const car = (await env.DB.prepare("SELECT efficiency FROM cars WHERE id = ?").bind(CAR_ID).first<{
      efficiency: number | null;
    }>())!;
    expect(car.efficiency).toBeNull();
  });
});

describe("software updates", () => {
  beforeEach(reset);

  it("records an installed version", async () => {
    const r = repo();
    const id = await r.openUpdate(T0);
    await r.finishUpdate(id, "2024.20.1", T0 + 30 * 60_000);
    const row = (await env.DB.prepare("SELECT version, end_date_at FROM updates WHERE id = ?").bind(id).first<{
      version: string;
      end_date_at: number;
    }>())!;
    expect(row.version).toBe("2024.20.1");
    expect(row.end_date_at).toBe(T0 + 30 * 60_000);
  });

  it("removes a canceled update", async () => {
    const r = repo();
    const id = await r.openUpdate(T0);
    await r.cancelUpdate(id);
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM updates").first<{ count: number }>())!;
    expect(count).toBe(0);
  });
});

describe("positions", () => {
  beforeEach(reset);

  it("writes a batch and returns the last id", async () => {
    const r = repo();
    const rows = [T0, T0 + 1000, T0 + 2000].map((at) => ({
      driveId: null,
      attrs: createPosition(parked({ at })),
    }));
    const lastId = await r.insertPositions(rows);
    expect(lastId).not.toBeNull();
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM positions").first<{ count: number }>())!;
    expect(count).toBe(3);
  });

  it("stores booleans as integers", async () => {
    const r = repo();
    await r.insertPositions([{ driveId: null, attrs: createPosition(parked()) }]);
    const row = (await env.DB.prepare("SELECT is_climate_on, battery_heater FROM positions LIMIT 1").first<{
      is_climate_on: number;
      battery_heater: number;
    }>())!;
    expect(row.is_climate_on).toBe(0);
    expect(row.battery_heater).toBe(0);
  });

  it("does nothing for an empty batch", async () => {
    expect(await repo().insertPositions([])).toBeNull();
  });
});
