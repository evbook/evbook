import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkodaPollState } from "../actors/skodaPoll";
import { encryptString } from "../core/crypto";
import { clearDurableObject, clearTables } from "../../test/db";
import { FAKE_SKODA_KEY, FakeSkoda, elroq } from "../../test/fake-skoda";
import type { VehicleDO } from "./vehicle";

/**
 * A Škoda's logger, end to end against the fake MySkoda Public API: the
 * VehicleDO reads through the Škoda pass, every answer is kept raw, and the
 * readings go through the same state machine as a Tesla's, so drives and
 * charging sessions come out as ordinary rows. Time moves by rewinding the
 * pass's own clocks (its sends, the motion it saw, the session's last sample).
 */

const CAR_ID = 81;
const VIN = "TMBJC7NY0SF000081";
const ACCOUNT = "skoda-test81";
const MIN = 60_000;

let fake: FakeSkoda;

const vehicle = () => env.VEHICLE_DO.getByName(`car:${CAR_ID}`);

async function poll() {
  await runInDurableObject(vehicle(), async (instance: VehicleDO) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
}

async function pollState(): Promise<SkodaPollState> {
  return runInDurableObject(vehicle(), async (_i, state) => (await state.storage.get<SkodaPollState>("skoda"))!);
}

/** Pretend `ms` passed since the last pass. */
async function rewind(ms: number) {
  await runInDurableObject(vehicle(), async (_i, state) => {
    const s = (await state.storage.get<SkodaPollState>("skoda"))!;
    s.sent = s.sent.map((t) => t - ms);
    if (s.session) s.session.at -= ms;
    if (s.view.motion) s.view.motion.seen -= ms;
    if (s.pausedUntil !== null) s.pausedUntil -= ms;
    await state.storage.put("skoda", s);
  });
}

async function fsmState(): Promise<string> {
  return runInDurableObject(vehicle(), async (_i, state) => {
    return (await state.storage.get<{ state: { name: string } }>("fsm"))?.state.name ?? "none";
  });
}

async function lastError(): Promise<string | null> {
  return runInDurableObject(vehicle(), async (_i, state) => (await state.storage.get<string>("lastError")) ?? null);
}

async function dueIn(): Promise<number | null> {
  const row = await env.DB.prepare("SELECT next_due_at FROM cars WHERE id = ?")
    .bind(CAR_ID)
    .first<{ next_due_at: number | null }>();
  return row?.next_due_at == null ? null : row.next_due_at - Date.now();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearDurableObject(() => vehicle());
  await clearTables(
    "skoda_snapshots",
    "skoda_keys",
    "accounts",
    "charges",
    "charging_processes",
    "positions",
    "drives",
    "states",
    "cars",
  );
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO cars (id, vin, provider, account, inserted_at, updated_at) VALUES (?, ?, 'skoda', ?, ?, ?)",
  )
    .bind(CAR_ID, VIN, ACCOUNT, now, now)
    .run();
  await env.DB.prepare("INSERT INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
  await env.DB.prepare("INSERT INTO accounts (name, provider, label, created_at) VALUES (?, 'skoda', 'Elroq', ?)")
    .bind(ACCOUNT, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO skoda_keys (account, vin, key_enc, key_last4, created_at, updated_at) VALUES (?, ?, ?, 'ABCD', ?, ?)",
  )
    .bind(ACCOUNT, VIN, await encryptString(env.ENCRYPTION_KEY, FAKE_SKODA_KEY), now, now)
    .run();
  fake = new FakeSkoda(elroq({ vin: VIN }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  await runInDurableObject(vehicle(), (_i, s) => s.storage.put("carId", CAR_ID));
});

afterEach(async () => {
  await clearDurableObject(() => vehicle());
  vi.restoreAllMocks();
});

describe("a Škoda's logger", () => {
  it("reads once, keeps the answer raw, names the car, and comes back in half an hour", async () => {
    await poll();
    expect(await fsmState()).toBe("online");
    expect(fake.reads).toBe(1);
    expect(fake.commands).toEqual([]);
    const snapshots = await env.DB.prepare("SELECT COUNT(*) AS n FROM skoda_snapshots WHERE car_id = ?")
      .bind(CAR_ID)
      .first<{ n: number }>();
    expect(snapshots!.n).toBe(1);
    expect(await env.DB.prepare("SELECT name FROM cars WHERE id = ?").bind(CAR_ID).first()).toEqual({ name: "Elroq" });
    const position = await env.DB.prepare("SELECT battery_level, latitude FROM positions WHERE car_id = ?")
      .bind(CAR_ID)
      .first();
    expect(position).toMatchObject({ battery_level: 52, latitude: 50.0755 });
    expect((await dueIn())!).toBeGreaterThan(29 * MIN);
    const summary = await vehicle().getSummary();
    expect(summary).toMatchObject({ provider: "skoda", state: "online", sleepBlocker: null, lastError: null });
    // Škoda's word on when the key lapses is kept.
    const key = await env.DB.prepare("SELECT expires_at FROM skoda_keys WHERE account = ?").bind(ACCOUNT).first();
    expect((key as { expires_at: number }).expires_at).toBeGreaterThan(Date.now());
  });

  it("stores a repeated answer once", async () => {
    await poll();
    await rewind(30 * MIN);
    await poll();
    const count = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM skoda_snapshots").first<{ n: number }>())!.n;
    expect(await count()).toBe(1);
    fake.set(VIN, { soc: 51 });
    await rewind(30 * MIN);
    await poll();
    expect(await count()).toBe(2);
  });

  it("logs a drive from 'in motion' to 'parked', starting where the car stood", async () => {
    await poll();
    fake.set(VIN, { parking: "IN_MOTION", odometerKm: 8_414, soc: 51 });
    await rewind(30 * MIN);
    await poll();
    expect(await fsmState()).toBe("driving");
    expect((await dueIn())!).toBeLessThanOrEqual(5 * MIN + 1_000);

    fake.set(VIN, { odometerKm: 8_420, soc: 49 });
    await rewind(5 * MIN);
    await poll();
    fake.set(VIN, { parking: "PARKED", odometerKm: 8_431, soc: 47, lat: 50.1, lon: 14.5 });
    await rewind(5 * MIN);
    await poll();

    expect(await fsmState()).toBe("online");
    const drive = await env.DB.prepare("SELECT distance, end_date_at FROM drives WHERE car_id = ?")
      .bind(CAR_ID)
      .first<{ distance: number; end_date_at: number | null }>();
    expect(drive?.end_date_at).not.toBeNull();
    expect(drive?.distance).toBeCloseTo(17, 3);
    const start = await env.DB.prepare(
      "SELECT latitude FROM positions WHERE drive_id IS NOT NULL ORDER BY date_at LIMIT 1",
    ).first();
    expect(start).toEqual({ latitude: 50.0755 });
    // Three settling reads at the active pace after the drive.
    expect((await pollState()).settleLeft).toBe(3);
  });

  it("logs a charging session with the energy integrated from the reported power", async () => {
    await poll();
    fake.set(VIN, { state: "CHARGING", plug: "CONNECTED", chargeType: "AC", powerKw: 11, minutesToFull: 120 });
    await rewind(30 * MIN);
    await poll();
    expect(await fsmState()).toBe("charging");
    fake.set(VIN, { soc: 56 });
    await rewind(5 * MIN);
    await poll();
    fake.set(VIN, { soc: 58 });
    await rewind(5 * MIN);
    await poll();
    fake.set(VIN, { state: "READY_FOR_CHARGING", powerKw: 0, soc: 58, minutesToFull: null });
    await rewind(5 * MIN);
    await poll();

    const session = await env.DB.prepare(
      "SELECT end_date_at, charge_energy_added, start_battery_level, end_battery_level FROM charging_processes WHERE car_id = ?",
    )
      .bind(CAR_ID)
      .first<{
        end_date_at: number | null;
        charge_energy_added: number;
        start_battery_level: number;
        end_battery_level: number;
      }>();
    expect(session?.end_date_at).not.toBeNull();
    // 11 kW for ten minutes, then a ramp from 11 to 0 over five.
    expect(session?.charge_energy_added).toBeCloseTo(11 / 6 + 11 / 24, 2);
    expect(session).toMatchObject({ start_battery_level: 52, end_battery_level: 58 });
  });

  it("stops on a lapsed key, says so, and starts again once a new key is in", async () => {
    fake.keys.delete(FAKE_SKODA_KEY);
    await poll();
    expect(await lastError()).toContain("API key");
    const key = await env.DB.prepare("SELECT refused_reason FROM skoda_keys WHERE account = ?").bind(ACCOUNT).first();
    expect(key).toEqual({ refused_reason: "expired" });
    // A refused key is not tried again on its own: it would only spend the quota.
    await rewind(2 * 60 * MIN);
    await poll();
    expect(fake.requests.length).toBe(1);

    fake.keys.set(FAKE_SKODA_KEY, { vin: VIN, expiresAt: Date.now() + 80 * 24 * 60 * MIN });
    await env.DB.prepare("UPDATE skoda_keys SET refused_at = NULL, refused_reason = NULL WHERE account = ?")
      .bind(ACCOUNT)
      .run();
    await vehicle().restartPolling(CAR_ID);
    await poll();
    expect(await lastError()).toBeNull();
    expect(await fsmState()).toBe("online");
  });

  it("never lets a key fill in another car's history", async () => {
    fake.answerAsVin = "TMBJC7NY0SF000099";
    await poll();
    expect(await lastError()).toContain("different car");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM skoda_snapshots").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM positions").first<{ n: number }>())!.n).toBe(0);
  });

  it("backs off when the car refuses, and keeps what it knew when a section fails", async () => {
    await poll();
    fake.failNext = { status: 429, type: "vehicle-not-accepting-requests", retryAfter: "900" };
    await rewind(30 * MIN);
    await poll();
    expect(await lastError()).toContain("12 V");
    expect((await pollState()).pausedUntil).toBeGreaterThan(Date.now() + 14 * MIN);

    await rewind(16 * MIN);
    fake.sectionErrors = ["CHARGING_UNAVAILABLE"];
    await poll();
    const state = await pollState();
    expect(state.sections.charging).toBe("unavailable");
    expect(state.view.soc?.v).toBe(52);
  });

  it("stays under 18 reads an hour whatever happens", async () => {
    await poll();
    fake.set(VIN, { parking: "IN_MOTION" });
    for (let i = 0; i < 25; i++) {
      await rewind(MIN);
      await poll();
    }
    expect(fake.reads).toBeLessThanOrEqual(18);
    expect(fake.commands).toEqual([]);
  });
});
