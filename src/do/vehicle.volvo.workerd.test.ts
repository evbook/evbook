import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VolvoPollState } from "../actors/volvoPoll";
import { clearDurableObject, clearTables } from "../../test/db";
import { FAKE_CLIENT, FakeVolvo, ex30 } from "../../test/fake-volvo";
import type { VehicleDO } from "./vehicle";

/**
 * A Volvo car's logger, end to end against the fake Volvo: the VehicleDO polls
 * through the Volvo pass, every answer is kept raw, and the readings go through
 * the same state machine as a Tesla's — so a drive and a charging session come
 * out of it as ordinary rows. Time moves by rewinding the pass's own clocks
 * (when each endpoint was last read), which is all its pacing looks at.
 */

const CAR_ID = 72;
const VIN = "YV1XZK1V8RX000072";
const MIN = 60_000;

let fake: FakeVolvo;

const vehicle = () => env.VEHICLE_DO.getByName(`car:${CAR_ID}`);
const volvoAuth = () => env.AUTH_DO.getByName("volvo");

async function poll() {
  await runInDurableObject(vehicle(), async (instance: VehicleDO) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
}

async function pollState(): Promise<VolvoPollState> {
  return runInDurableObject(vehicle(), async (_i, state) => (await state.storage.get<VolvoPollState>("volvo"))!);
}

/** Pretend `ms` passed since the last pass: every clock the pacing reads moves back. */
async function rewind(ms: number) {
  await runInDurableObject(vehicle(), async (_i, state) => {
    const s = (await state.storage.get<VolvoPollState>("volvo"))!;
    for (const key of Object.keys(s.lastFetched) as (keyof typeof s.lastFetched)[]) s.lastFetched[key]! -= ms;
    if (s.session) s.session.at -= ms;
    if (s.budget) for (const bucket of Object.values(s.budget)) bucket.at -= ms;
    await state.storage.put("volvo", s);
    // The token cache would otherwise outlive a fake that forgot its tokens.
    await state.storage.delete("volvoAuthCache");
  });
}

async function fsmState(): Promise<string> {
  return runInDurableObject(vehicle(), async (_i, state) => {
    return (await state.storage.get<{ state: { name: string } }>("fsm"))?.state.name ?? "none";
  });
}

async function dueIn(): Promise<number | null> {
  const row = await env.DB.prepare("SELECT next_due_at FROM cars WHERE id = ?")
    .bind(CAR_ID)
    .first<{ next_due_at: number | null }>();
  return row?.next_due_at == null ? null : row.next_due_at - Date.now();
}

async function alarmArmed(): Promise<boolean> {
  return (await runInDurableObject(vehicle(), (_i, state) => state.storage.getAlarm())) !== null;
}

async function lastError(): Promise<string | null> {
  return runInDurableObject(vehicle(), async (_i, state) => (await state.storage.get<string>("lastError")) ?? null);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearDurableObject(() => volvoAuth());
  await clearDurableObject(() => vehicle());
  await clearTables(
    "volvo_snapshots",
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
    "INSERT INTO cars (id, vin, provider, account, inserted_at, updated_at) VALUES (?, ?, 'volvo', 'volvo', ?, ?)",
  )
    .bind(CAR_ID, VIN, now, now)
    .run();
  await env.DB.prepare("INSERT INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();

  fake = new FakeVolvo(ex30({ vin: VIN }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  const auth = volvoAuth();
  expect(await auth.volvoSetCredentials(FAKE_CLIENT)).toEqual({ ok: true });
  const begun = await auth.volvoBeginAuthorization("https://x/api/v1/auth/volvo/callback");
  if (!begun.ok) throw new Error(begun.error);
  const { code, state } = fake.consent(begun.url);
  expect(await auth.volvoCompleteAuthorization(state, code)).toEqual({ ok: true });
  await runInDurableObject(vehicle(), (_i, s) => s.storage.put("carId", CAR_ID));
});

afterEach(async () => {
  await clearDurableObject(() => vehicle());
  vi.restoreAllMocks();
});

describe("a Volvo car's logger", () => {
  it("reads everything on its first pass, keeps it raw, and names the car", async () => {
    await poll();
    expect(await fsmState()).toBe("online");
    const endpoints = (
      await env.DB.prepare("SELECT endpoint FROM volvo_snapshots ORDER BY id").all<{ endpoint: string }>()
    ).results.map((r) => r.endpoint);
    expect(endpoints).toEqual([
      "energy-state",
      "engine-status",
      "odometer",
      "location",
      "statistics",
      "doors",
      "windows",
      "tyres",
      "details",
    ]);
    const car = await env.DB.prepare("SELECT model, name FROM cars WHERE id = ?").bind(CAR_ID).first();
    expect(car).toEqual({ model: "EX30", name: "Volvo EX30" });
    const position = await env.DB.prepare("SELECT odometer, battery_level, latitude FROM positions WHERE car_id = ?")
      .bind(CAR_ID)
      .first();
    expect(position).toMatchObject({ battery_level: 62, latitude: 52.52 });
    expect((position as { odometer: number }).odometer).toBeCloseTo(12_345.6, 3);
    // Parked: the next pass is the cron's, ten minutes out, with no alarm keeping the object resident.
    expect(await alarmArmed()).toBe(false);
    expect((await dueIn())!).toBeGreaterThan(9 * MIN);
  });

  it("stores a repeated answer once and only moves when it was last seen", async () => {
    await poll();
    await rewind(10 * MIN);
    await poll();
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(checked_at - fetched_at) AS seen FROM volvo_snapshots WHERE endpoint = 'energy-state'",
    ).first<{ n: number; seen: number }>();
    expect(rows!.n).toBe(1);
    expect(rows!.seen).toBeGreaterThanOrEqual(0);
    fake.set({ soc: 61 });
    await rewind(10 * MIN);
    await poll();
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM volvo_snapshots WHERE endpoint = 'energy-state'").first<{
        n: number;
      }>())!.n,
    ).toBe(2);
  });

  it("logs a drive from engine start to engine stop, on the minute cron", async () => {
    await poll();

    fake.set({ engine: "RUNNING" });
    await rewind(10 * MIN);
    await poll();
    expect(await fsmState()).toBe("driving");
    expect(await alarmArmed()).toBe(false);
    expect((await dueIn())!).toBeLessThanOrEqual(MIN);

    fake.set({ odometerKm: 12_350.6, lat: 52.53, soc: 60 });
    await rewind(MIN);
    await poll();
    fake.set({ engine: "STOPPED", odometerKm: 12_353.6, lat: 52.54, soc: 59 });
    await rewind(MIN);
    await poll();

    expect(await fsmState()).toBe("online");
    const drive = await env.DB.prepare("SELECT distance, end_date_at, start_km, end_km FROM drives WHERE car_id = ?")
      .bind(CAR_ID)
      .first<{ distance: number; end_date_at: number | null; start_km: number; end_km: number }>();
    expect(drive?.end_date_at).not.toBeNull();
    expect(drive?.distance).toBeCloseTo(8, 3);
    const positions = await env.DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE drive_id IS NOT NULL").first<{
      n: number;
    }>();
    expect(positions!.n).toBeGreaterThanOrEqual(3);
  });

  it("logs a charging session with the energy integrated from the reported power", async () => {
    await poll();
    fake.set({ cable: "CONNECTED", charging: "CHARGING", chargeType: "AC", powerKw: 11 });
    await rewind(10 * MIN);
    await poll();
    expect(await fsmState()).toBe("charging");

    fake.set({ soc: 66 });
    await rewind(10 * MIN);
    await poll();
    fake.set({ soc: 68, charging: "DONE", powerKw: 0 });
    await rewind(10 * MIN);
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
    // 11 kW for ten minutes, then a ramp from 11 to 0 over the next ten.
    expect(session?.charge_energy_added).toBeCloseTo(11 / 6 + 11 / 12, 2);
    expect(session).toMatchObject({ start_battery_level: 62, end_battery_level: 68 });
    const ac = await env.DB.prepare("SELECT fast_charger_present FROM charges LIMIT 1").first();
    expect(ac).toEqual({ fast_charger_present: 0 });
  });

  it("waits out a spent quota on one API and keeps reading the others", async () => {
    await poll();
    fake.quota.location = 0;
    await rewind(60 * MIN);
    await poll();
    const state = await pollState();
    expect(state.quotaUntil.location).toBeGreaterThan(Date.now() + 17 * 60 * MIN);
    expect(state.lastFetched.odometer).toBeGreaterThan(Date.now() - MIN);
    const summary = await vehicle().getSummary();
    expect(summary?.lastError).toContain("quota");
    expect(summary?.provider).toBe("volvo");

    const before = fake.calls.filter((c) => c.includes("/location/")).length;
    await rewind(60 * MIN);
    await poll();
    expect(fake.calls.filter((c) => c.includes("/location/")).length).toBe(before);
  });

  it("refreshes an expired access token once and carries on", async () => {
    await poll();
    fake.expireAccess();
    await rewind(10 * MIN);
    await poll();
    expect(await lastError()).toBeNull();
    expect(fake.calls.filter((c) => c.endsWith("/token")).length).toBe(2); // the consent, then one refresh
  });

  it("says so when the grant is gone, and asks for a new consent", async () => {
    await poll();
    fake.revokeAll();
    await rewind(10 * MIN);
    await poll();
    expect(await lastError()).toContain("reconnect");
    const status = await volvoAuth().volvoStatus();
    expect(status).toMatchObject({ connected: false, reauthReason: "grant_expired" });
  });

  it("stops for good on a market Volvo does not serve", async () => {
    fake.failures.push({ match: "/state", status: 404, body: '{"message":"VIN does not belong to allowed markets"}' });
    await poll();
    expect(await lastError()).toContain("market");
    expect((await pollState()).stopped?.reason).toBe("market");
    expect(fake.calls.some((c) => c.includes("/engine-status"))).toBe(false);
  });

  it("leaves an endpoint the grant cannot read for a day instead of failing the pass", async () => {
    fake.failures.push({ match: "/location/", status: 403, body: '{"error":{"message":"Access Denied"}}' });
    await poll();
    expect(await lastError()).toBeNull();
    expect((await pollState()).missingUntil.location).toBeGreaterThan(Date.now() + 23 * 60 * MIN);
  });

  it("refuses the Tesla-only commands", async () => {
    await poll();
    expect(await vehicle().wake()).toEqual({ ok: false, reason: "EVBook only reads a Volvo; it sends it no commands" });
    expect((await vehicle().sendDestination("Berlin")).ok).toBe(false);
  });
});
