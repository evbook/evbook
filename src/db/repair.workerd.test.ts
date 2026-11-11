import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { closeAbandonedSessions, repairDriveOrigins } from "./repair";

/**
 * The sweep that gives an end to spans nothing else will. What matters is not
 * only that they get closed but *when* they get closed at: an end of `now` would
 * turn last summer's quarter-hour charge into an eleven-month one, which is the
 * same lie the open row was telling.
 */

const CAR_ID = 31;
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const LAST_YEAR = NOW - 300 * 24 * HOUR;

async function reset() {
  for (const table of ["charges", "charging_processes", "positions", "drives", "states", "updates", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, 10, 20, 'VIN31', 'Bro', ?, ?)",
  )
    .bind(CAR_ID, NOW, NOW)
    .run();
  await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
}

/** An open drive with `samples` positions a minute apart, moving 1 km each. */
async function openDrive(at: number, samples: number): Promise<number> {
  const drive = await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?) RETURNING id")
    .bind(CAR_ID, at)
    .first<{ id: number }>();
  for (let i = 0; i < samples; i++) {
    await env.DB.prepare(
      "INSERT INTO positions (car_id, drive_id, date_at, odometer, battery_level, rated_battery_range_km, ideal_battery_range_km) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(CAR_ID, drive!.id, at + i * 60_000, 1000 + i, 80 - i, 300 - i * 5, 320 - i * 5)
      .run();
  }
  return drive!.id;
}

/** An open charging process with `samples` charge rows a minute apart. */
async function openCharge(at: number, samples: number): Promise<number> {
  const cproc = await env.DB.prepare(
    "INSERT INTO charging_processes (car_id, start_date_at) VALUES (?, ?) RETURNING id",
  )
    .bind(CAR_ID, at)
    .first<{ id: number }>();
  for (let i = 0; i < samples; i++) {
    await env.DB.prepare(
      "INSERT INTO charges (charging_process_id, date_at, battery_level, charge_energy_added, charger_power, " +
        "rated_battery_range_km, ideal_battery_range_km) VALUES (?, ?, ?, ?, 11, ?, ?)",
    )
      .bind(cproc!.id, at + i * 60_000, 40 + i, i * 0.2, 200 + i * 2, 220 + i * 2)
      .run();
  }
  return cproc!.id;
}

const drive = (id: number) =>
  env.DB.prepare("SELECT start_date_at, end_date_at, distance FROM drives WHERE id = ?")
    .bind(id)
    .first<{ start_date_at: number; end_date_at: number | null; distance: number | null }>();

const charge = (id: number) =>
  env.DB.prepare("SELECT start_date_at, end_date_at, charge_energy_added FROM charging_processes WHERE id = ?")
    .bind(id)
    .first<{ start_date_at: number; end_date_at: number | null; charge_energy_added: number | null }>();

describe("closing abandoned sessions", () => {
  beforeEach(reset);

  it("ends a drive left open at its last position, not at now", async () => {
    const id = await openDrive(LAST_YEAR, 18);

    expect(await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW)).toEqual({ closed: 1 });

    const row = await drive(id);
    expect(row!.end_date_at).toBe(LAST_YEAR + 17 * 60_000);
    expect(row!.distance).toBeCloseTo(17, 5);
  });

  it("leaves the drive the car is on now alone", async () => {
    const id = await openDrive(NOW - 10 * 60_000, 5);

    expect(await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW)).toEqual({ closed: 0 });
    expect((await drive(id))!.end_date_at).toBeNull();
  });

  it("closes a superseded drive even when it is younger than the cutoff", async () => {
    // A Worker that died between two drives on the same afternoon: the first is
    // not stale by age, but a second one starting means it should have ended.
    const abandoned = await openDrive(NOW - 3 * HOUR, 6);
    const live = await openDrive(NOW - 10 * 60_000, 4);

    expect(await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW)).toEqual({ closed: 1 });
    expect((await drive(abandoned))!.end_date_at).toBe(NOW - 3 * HOUR + 5 * 60_000);
    expect((await drive(live))!.end_date_at).toBeNull();
  });

  it("deletes a drive that never got two positions", async () => {
    const id = await openDrive(LAST_YEAR, 1);

    await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW);
    expect(await drive(id)).toBeNull();
  });

  it("completes a charge left open from its own samples", async () => {
    const id = await openCharge(LAST_YEAR, 21);

    expect(await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW)).toEqual({ closed: 1 });

    const row = await charge(id);
    expect(row!.end_date_at).toBe(LAST_YEAR + 20 * 60_000);
    expect(row!.charge_energy_added).toBeGreaterThan(0);
  });

  it("collapses a charge that logged nothing to the instant it opened", async () => {
    const id = await openCharge(LAST_YEAR, 0);

    await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW);

    const row = await charge(id);
    expect(row!.end_date_at).toBe(LAST_YEAR);
  });

  it("gives an install that never reported finishing its own start", async () => {
    await env.DB.prepare("INSERT INTO updates (car_id, start_date_at, version) VALUES (?, ?, '2026.20.1')")
      .bind(CAR_ID, LAST_YEAR)
      .run();

    await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW);

    const row = await env.DB.prepare("SELECT start_date_at, end_date_at, version FROM updates").first<{
      start_date_at: number;
      end_date_at: number | null;
      version: string | null;
    }>();
    expect(row!.end_date_at).toBe(LAST_YEAR);
    expect(row!.version).toBe("2026.20.1");
  });

  it("does nothing when every span has an end", async () => {
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at, end_date_at) VALUES (?, ?, ?)")
      .bind(CAR_ID, LAST_YEAR, LAST_YEAR + HOUR)
      .run();

    expect(await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST, NOW)).toEqual({ closed: 0 });
  });
});

describe("drive origin sweep", () => {
  beforeEach(async () => {
    await reset();
    await env.DB.prepare("UPDATE settings SET drive_origin_swept_before = NULL WHERE id = 1").run();
  });

  const cursor = async () =>
    (await env.DB.prepare("SELECT drive_origin_swept_before AS wm FROM settings WHERE id = 1").first<{
      wm: number | null;
    }>())!.wm;

  /**
   * A drive the way history holds it: a parked position an hour earlier, then
   * the recorded samples — the first one already `gapKm` down the road — and a
   * settled drive row pointing at them. Elevations are set so re-closing never
   * asks the terrain service.
   */
  async function settledDrive(firstAt: number, parkKm: number, gapKm: number): Promise<number> {
    await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, latitude, longitude, odometer, elevation) VALUES (?, ?, 52.52, 13.405, ?, 30)",
    )
      .bind(CAR_ID, firstAt - HOUR, parkKm)
      .run();
    const drive = (await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?) RETURNING id")
      .bind(CAR_ID, firstAt)
      .first<{ id: number }>())!;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const row = (await env.DB.prepare(
        "INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude, odometer, speed, elevation) " +
          "VALUES (?, ?, ?, ?, 13.42, ?, 50, 30) RETURNING id",
      )
        .bind(CAR_ID, drive.id, firstAt + i * 60_000, 52.53 + i * 0.01, parkKm + gapKm + i)
        .first<{ id: number }>())!;
      ids.push(row.id);
    }
    await env.DB.prepare(
      "UPDATE drives SET end_date_at = ?, start_position_id = ?, end_position_id = ?, start_km = ?, end_km = ?, distance = ? WHERE id = ?",
    )
      .bind(firstAt + 2 * 60_000, ids[0], ids[2], parkKm + gapKm, parkKm + gapKm + 2, 2, drive.id)
      .run();
    return drive.id;
  }

  it("gives a swept drive the origin the poller missed", async () => {
    const id = await settledDrive(NOW - 24 * HOUR, 1000, 0.5);

    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 1, repaired: 1 });

    const row = (await env.DB.prepare(
      "SELECT start_date_at, start_km, distance, start_position_id FROM drives WHERE id = ?",
    )
      .bind(id)
      .first<Record<string, number>>())!;
    // Distance now runs from the parked odometer; 0.5 km at the sample's
    // 50 km/h backdates the start by 36 s.
    expect(row.start_km).toBe(1000);
    expect(row.distance).toBeCloseTo(2.5, 5);
    expect(row.start_date_at).toBe(NOW - 24 * HOUR - 36_000);
    const origin = (await env.DB.prepare("SELECT latitude, odometer FROM positions WHERE id = ?")
      .bind(row.start_position_id)
      .first<{ latitude: number; odometer: number }>())!;
    expect(origin.latitude).toBe(52.52);
    expect(origin.odometer).toBe(1000);

    // One pass over everything, then the sweep is over and stays over.
    expect(await cursor()).toBe(0);
    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 0, repaired: 0 });
  });

  // Drive 7765: the wake's `start` row duplicates the first sample, drive-less
  // and at the same instant. The sweep must look past it to the night's parked
  // row — and a second pass, which 0005 forces on every database, must find
  // nothing left to do for drives it already gave an origin.
  it("looks past the wake's own row, and a re-pass changes nothing", async () => {
    const firstAt = NOW - 24 * HOUR;
    const id = await settledDrive(firstAt, 1000, 0.29);
    await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, latitude, longitude, odometer, elevation) VALUES (?, ?, 52.53, 13.42, ?, 30)",
    )
      .bind(CAR_ID, firstAt, 1000.29)
      .run();

    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 1, repaired: 1 });
    const row = (await env.DB.prepare("SELECT start_km, start_date_at FROM drives WHERE id = ?")
      .bind(id)
      .first<Record<string, number>>())!;
    expect(row.start_km).toBe(1000);
    expect(row.start_date_at).toBeLessThan(firstAt);

    await env.DB.prepare("UPDATE settings SET drive_origin_swept_before = NULL WHERE id = 1").run();
    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 1, repaired: 0 });
  });

  it("repairs the short pull-away gaps drives actually show", async () => {
    // ~30 s at city speed — the artifact that motivated the sweep.
    const id = await settledDrive(NOW - 24 * HOUR, 1000, 0.15);

    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 1, repaired: 1 });
    const row = (await env.DB.prepare("SELECT start_km FROM drives WHERE id = ?")
      .bind(id)
      .first<Record<string, number>>())!;
    expect(row.start_km).toBe(1000);
  });

  it("leaves a settled drive alone when only odometer noise is missing", async () => {
    const id = await settledDrive(NOW - 24 * HOUR, 1000, 0.02);

    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 1, repaired: 0 });

    const row = (await env.DB.prepare("SELECT start_km, distance FROM drives WHERE id = ?")
      .bind(id)
      .first<Record<string, number>>())!;
    expect(row.start_km).toBeCloseTo(1000.02, 5);
    expect(row.distance).toBe(2);
    expect(await cursor()).toBe(0);
  });

  // The sweep paces Nominatim at 1.2 s per repair, so five repairs need room.
  it("spends at most its repair budget per run and resumes below it", { timeout: 20_000 }, async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await settledDrive(NOW - (10 - i) * 24 * HOUR, 1000 + i * 100, 0.5));
    }

    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 4, repaired: 4 });
    // The oldest drive waits below the cursor for the next run.
    expect(await cursor()).toBe(ids[1]);
    expect(await repairDriveOrigins(env.DB, env.NOMINATIM_HOST)).toEqual({ examined: 1, repaired: 1 });
    expect(await cursor()).toBe(0);
  });
});
