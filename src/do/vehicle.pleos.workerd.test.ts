import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PleosPollState } from "../actors/pleosPoll";
import { encryptString } from "../core/crypto";
import { HOURLY_CAP } from "../core/pleos/pace";
import { clearDurableObject, clearTables } from "../../test/db";
import { FAKE_PLEOS_CLIENT_ID, FAKE_PLEOS_SECRET, FakePleos, ioniq5 } from "../../test/fake-pleos";
import type { VehicleDO } from "./vehicle";

/**
 * A Hyundai, Kia or Genesis logger, end to end against the fake Pleos Vehicle
 * Data API: the VehicleDO reads through the Pleos pass, the token comes from
 * the key's token holder on the auth actor's class, every answer is kept raw,
 * and the readings go through the same state machine as a Tesla's, so drives
 * and charging sessions come out as ordinary rows. Time moves by rewinding the
 * pass's own clocks and the car's upload times.
 */

const CAR_ID = 91;
const OTHER_CAR_ID = 92;
const VIN = "KMHKM81CPNU000091";
const OTHER_VIN = "KMHKM81CPNU000092";
const ACCOUNT = "pleos-test91";
const MIN = 60_000;

let fake: FakePleos;

const vehicle = (id = CAR_ID) => env.VEHICLE_DO.getByName(`car:${id}`);
const tokens = () => env.AUTH_DO.getByName(ACCOUNT);

async function poll(id = CAR_ID) {
  await runInDurableObject(vehicle(id), async (instance: VehicleDO) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
}

async function pollState(id = CAR_ID): Promise<PleosPollState> {
  return runInDurableObject(vehicle(id), async (_i, state) => (await state.storage.get<PleosPollState>("pleos"))!);
}

/**
 * Pretend `ms` passed: the pass's clocks, the readings' times and (unless
 * `uploads` is false) the cars' last uploads all move back. Moving an upload
 * changes its `data.timestamp`, so a spec about repeats keeps it still.
 */
async function rewind(ms: number, id = CAR_ID, uploads = true) {
  await runInDurableObject(vehicle(id), async (_i, state) => {
    const s = await state.storage.get<PleosPollState>("pleos");
    if (!s) return;
    s.sent = s.sent.map((t) => t - ms);
    for (const key of Object.keys(s.due) as (keyof typeof s.due)[]) s.due[key]! -= ms;
    for (const key of Object.keys(s.held) as (keyof typeof s.held)[]) s.held[key]! -= ms;
    if (s.pausedUntil !== null) s.pausedUntil -= ms;
    for (const r of Object.values(s.view)) {
      if (r && typeof r === "object" && "seen" in r) {
        r.seen -= ms;
        if (r.at !== null) r.at -= ms;
      }
    }
    await state.storage.put("pleos", s);
  });
  if (uploads) for (const car of fake.cars.values()) car.sentAt -= ms;
}

async function fsmState(id = CAR_ID): Promise<string> {
  return runInDurableObject(vehicle(id), async (_i, state) => {
    return (await state.storage.get<{ state: { name: string } }>("fsm"))?.state.name ?? "none";
  });
}

async function lastError(id = CAR_ID): Promise<string | null> {
  return runInDurableObject(vehicle(id), async (_i, state) => (await state.storage.get<string>("lastError")) ?? null);
}

async function dueIn(id = CAR_ID): Promise<number | null> {
  const row = await env.DB.prepare("SELECT next_due_at FROM cars WHERE id = ?")
    .bind(id)
    .first<{ next_due_at: number | null }>();
  return row?.next_due_at == null ? null : row.next_due_at - Date.now();
}

const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

async function addCar(id: number, vin: string) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO cars (id, vin, provider, account, inserted_at, updated_at) VALUES (?, ?, 'pleos', ?, ?, ?)",
  )
    .bind(id, vin, ACCOUNT, now, now)
    .run();
  await env.DB.prepare("INSERT INTO car_settings (car_id) VALUES (?)").bind(id).run();
  await runInDurableObject(vehicle(id), (_i, s) => s.storage.put("carId", id));
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearDurableObject(() => vehicle());
  await clearDurableObject(() => vehicle(OTHER_CAR_ID));
  await clearDurableObject(() => tokens());
  await clearTables(
    "provider_snapshots",
    "pleos_keys",
    "accounts",
    "charges",
    "charging_processes",
    "positions",
    "drives",
    "states",
    "cars",
  );
  const now = Date.now();
  await env.DB.prepare("INSERT INTO accounts (name, provider, label, created_at) VALUES (?, 'pleos', 'Hyundai', ?)")
    .bind(ACCOUNT, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO pleos_keys (account, brand, client_id, secret_enc, secret_last4, created_at, updated_at) " +
      "VALUES (?, 'hyundai', ?, ?, 'WXYZ', ?, ?)",
  )
    .bind(ACCOUNT, FAKE_PLEOS_CLIENT_ID, await encryptString(env.ENCRYPTION_KEY, FAKE_PLEOS_SECRET), now, now)
    .run();
  fake = new FakePleos(ioniq5({ vin: VIN }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  await addCar(CAR_ID, VIN);
});

afterEach(async () => {
  await clearDurableObject(() => vehicle());
  await clearDurableObject(() => vehicle(OTHER_CAR_ID));
  vi.restoreAllMocks();
});

describe("a Pleos car's logger", () => {
  it("reads all four on the first pass, keeps each raw, and comes back in ten minutes", async () => {
    await poll();
    expect(await fsmState()).toBe("online");
    expect(fake.reads).toBe(4);
    expect(fake.tokensMinted).toBe(1);
    expect(fake.commands).toEqual([]);
    const endpoints = await env.DB.prepare(
      "SELECT endpoint FROM provider_snapshots WHERE car_id = ? AND provider = 'pleos' ORDER BY endpoint",
    )
      .bind(CAR_ID)
      .all<{ endpoint: string }>();
    expect(endpoints.results.map((r) => r.endpoint)).toEqual(["batteries", "driving", "locations", "powertrains"]);
    const position = await env.DB.prepare("SELECT battery_level, latitude FROM positions WHERE car_id = ?")
      .bind(CAR_ID)
      .first();
    expect(position).toMatchObject({ battery_level: 64, latitude: 52.3702 });
    const due = (await dueIn())!;
    expect(due).toBeGreaterThan(9 * MIN);
    expect(due).toBeLessThanOrEqual(10 * MIN + 1_000);
    const summary = await vehicle().getSummary();
    expect(summary).toMatchObject({ provider: "pleos", state: "online", sleepBlocker: null, lastError: null });
  });

  it("stores a repeat of the car's last upload once, and a new upload with the same values again", async () => {
    // Pleos's times are to the second: the next upload must not fall in the same one.
    fake.set(VIN, { sentAt: Date.now() - 5 * MIN });
    await poll();
    await rewind(10 * MIN, CAR_ID, false);
    await poll();
    expect(fake.reads).toBe(6);
    expect(await count("SELECT COUNT(*) AS n FROM provider_snapshots")).toBe(4);
    fake.set(VIN, {});
    await rewind(10 * MIN, CAR_ID, false);
    await poll();
    expect(await count("SELECT COUNT(*) AS n FROM provider_snapshots")).toBe(6);
  });

  it("logs a drive from P released and the car ready, to P again", async () => {
    await poll();
    fake.set(VIN, { parked: false, ignition: "on", ign3: "on", speedKph: 50, odometerKm: 23_420 });
    await rewind(10 * MIN);
    await poll();
    expect(await fsmState()).toBe("driving");
    expect((await dueIn())!).toBeLessThanOrEqual(2 * MIN + 1_000);

    fake.set(VIN, { odometerKm: 23_430, lat: 52.4, lon: 4.9, speedKph: 80, soc: 61 });
    await rewind(2 * MIN);
    await poll();
    fake.set(VIN, { parked: true, ignition: "off", ign3: "off", speedKph: 0, odometerKm: 23_435, soc: 60 });
    await rewind(2 * MIN);
    await poll();

    expect(await fsmState()).toBe("online");
    const drive = await env.DB.prepare("SELECT distance, end_date_at FROM drives WHERE car_id = ?")
      .bind(CAR_ID)
      .first<{ distance: number; end_date_at: number | null }>();
    expect(drive?.end_date_at).not.toBeNull();
    expect(drive?.distance).toBeCloseTo(15, 3);
    // Every read once more, soon, to catch where the car settled.
    expect((await dueIn())!).toBeLessThanOrEqual(2 * MIN + 1_000);
  });

  it("does not open a drive while the car is ready in P, nor on a time from the car's future", async () => {
    await poll();
    fake.set(VIN, { parked: true, ignition: "on", ign3: "on" });
    await rewind(10 * MIN);
    await poll();
    expect(await fsmState()).toBe("online");
    // A Kia's reported extra summer hour.
    fake.set(VIN, { parked: false, ign3: "on", speedKph: 40, sentAt: Date.now() + 60 * MIN });
    await rewind(10 * MIN);
    fake.cars.get(VIN)!.sentAt = Date.now() + 60 * MIN;
    await poll();
    expect(await fsmState()).toBe("online");
  });

  it("logs a charge with its levels and no energy, rather than a guessed one", async () => {
    await poll();
    fake.set(VIN, { plugin: "connected", status: "charging", charging: true, remainTime: 90 });
    await rewind(10 * MIN);
    await poll();
    expect(await fsmState()).toBe("charging");
    fake.set(VIN, { soc: 68 });
    await rewind(5 * MIN);
    await poll();
    fake.set(VIN, { soc: 72 });
    await rewind(5 * MIN);
    await poll();
    fake.set(VIN, { status: "notCharging", charging: false, soc: 72, remainTime: 0 });
    await rewind(5 * MIN);
    await poll();
    expect(await fsmState()).toBe("online");

    const session = await env.DB.prepare(
      "SELECT end_date_at, charge_energy_added, start_battery_level, end_battery_level FROM charging_processes WHERE car_id = ?",
    )
      .bind(CAR_ID)
      .first<{
        end_date_at: number | null;
        charge_energy_added: number | null;
        start_battery_level: number;
        end_battery_level: number;
      }>();
    expect(session?.end_date_at).not.toBeNull();
    expect(session?.charge_energy_added).toBeNull();
    expect(session).toMatchObject({ start_battery_level: 64, end_battery_level: 72 });
  });

  it("does not take a scheduled charge or vehicle-to-load for a charge", async () => {
    fake.set(VIN, { plugin: "connected", status: "reservedCharging", charging: true });
    await poll();
    expect(await fsmState()).toBe("online");
    fake.set(VIN, { status: "v2lOperating", charging: false });
    await rewind(10 * MIN);
    await poll();
    expect(await fsmState()).toBe("online");
  });

  it("gives every car on a key the one token, rather than one each that cancel each other", async () => {
    fake.addCar(ioniq5({ vin: OTHER_VIN }));
    await addCar(OTHER_CAR_ID, OTHER_VIN);
    await poll(CAR_ID);
    await poll(OTHER_CAR_ID);
    expect(fake.tokensMinted).toBe(1);
    expect(await lastError(CAR_ID)).toBeNull();
    expect(await lastError(OTHER_CAR_ID)).toBeNull();
  });

  it("takes a new token once when another program replaced it, and rests the key when that keeps happening", async () => {
    await poll();
    for (let i = 1; i <= 2; i++) {
      fake.evict();
      await rewind(10 * MIN);
      await poll();
      expect(await lastError()).toBeNull();
      expect(fake.tokensMinted).toBe(1 + i);
    }
    fake.evict();
    await rewind(10 * MIN);
    await poll();
    expect(await lastError()).toContain("Another program");
    expect(fake.tokensMinted).toBe(3);
    expect((await pollState()).pausedUntil).toBeGreaterThan(Date.now() + 14 * MIN);
    // The refused token is not kept to be handed out again after the rest.
    const held = await runInDurableObject(tokens(), (_i, state) =>
      state.storage.get<{ tokenEnc: string | null }>("pleos:token"),
    );
    expect(held?.tokenEnc).toBeNull();
  });

  it("stops on a refused key, says so, and starts again once a new key is in", async () => {
    await poll();
    fake.revoke();
    await rewind(10 * MIN);
    await poll();
    expect(await lastError()).toContain("no longer accepts the key");
    const key = await env.DB.prepare("SELECT refused_reason FROM pleos_keys WHERE account = ?").bind(ACCOUNT).first();
    expect(key).toEqual({ refused_reason: "key_refused" });
    // A refused key is not tried again on its own.
    const before = fake.requests.length;
    await rewind(2 * 60 * MIN);
    await poll();
    expect(fake.requests.length).toBe(before);

    fake.keys.get(FAKE_PLEOS_CLIENT_ID)!.revoked = false;
    await env.DB.prepare("UPDATE pleos_keys SET refused_at = NULL, refused_reason = NULL WHERE account = ?")
      .bind(ACCOUNT)
      .run();
    await vehicle().restartPolling(CAR_ID);
    await poll();
    expect(await lastError()).toBeNull();
    expect(await fsmState()).toBe("online");
  });

  it("stops a car that is no longer shared, without touching the key", async () => {
    await poll();
    fake.unshared.add(VIN);
    await rewind(10 * MIN);
    await poll();
    expect(await lastError()).toContain("no longer shared");
    const before = fake.requests.length;
    await rewind(2 * 60 * MIN);
    await poll();
    expect(fake.requests.length).toBe(before);
    const key = await env.DB.prepare("SELECT refused_at FROM pleos_keys WHERE account = ?").bind(ACCOUNT).first();
    expect(key).toEqual({ refused_at: null });
  });

  it("waits on 'no data' and keeps what it knew when one read fails", async () => {
    for (const endpoint of ["batteries", "driving", "locations", "powertrains"]) fake.noData.add(endpoint);
    await poll();
    expect(await lastError()).toContain("no data");
    expect(await count("SELECT COUNT(*) AS n FROM pleos_keys WHERE refused_at IS NOT NULL")).toBe(0);
    fake.noData.clear();
    await vehicle().restartPolling(CAR_ID);
    await poll();
    expect(await lastError()).toBeNull();

    fake.noData.add("locations");
    await rewind(60 * MIN);
    await poll();
    const state = await pollState();
    expect(state.reads.locations).toBe("no_data");
    expect(state.view.position?.v).toEqual({ lat: 52.3702, lon: 4.8952 });
  });

  it("does not ask again early for a read Pleos has no data for, even while driving", async () => {
    const asked = () => fake.count((r) => r.path.endsWith("/locations"));
    fake.noData.add("locations");
    await poll();
    expect(asked()).toBe(1);
    fake.set(VIN, { parked: false, ignition: "on", ign3: "on" });
    for (let i = 0; i < 8; i++) {
      await rewind(2 * MIN);
      fake.set(VIN, {});
      await poll();
    }
    expect(await fsmState()).toBe("driving");
    expect(asked()).toBe(1);
    // Once the half hour is over it is asked again.
    await rewind(16 * MIN);
    fake.set(VIN, {});
    await poll();
    expect(asked()).toBe(2);
  });

  it("says so when the car's clock is ahead, rather than showing a parked car with nothing wrong", async () => {
    await poll();
    fake.set(VIN, { parked: false, ign3: "on", sentAt: Date.now() + 60 * MIN });
    await rewind(10 * MIN);
    fake.cars.get(VIN)!.sentAt = Date.now() + 60 * MIN;
    await poll();
    expect(await fsmState()).toBe("online");
    expect((await pollState()).failure?.kind).toBe("clock_ahead");
    fake.set(VIN, { parked: true, ign3: "off" });
    await rewind(10 * MIN);
    await poll();
    expect((await pollState()).failure).toBeNull();
  });

  it("names its own hourly cap as its own, not as Pleos's", async () => {
    await poll();
    await runInDurableObject(vehicle(), async (_i, state) => {
      const s = (await state.storage.get<PleosPollState>("pleos"))!;
      s.sent = Array.from({ length: HOURLY_CAP }, () => Date.now() - MIN);
      await state.storage.put("pleos", s);
    });
    const before = fake.requests.length;
    await rewind(10 * MIN);
    await poll();
    expect(fake.requests.length).toBe(before);
    expect(await lastError()).toContain("its own hourly limit");
  });

  it("backs off the whole pass on a 429, as long as Pleos says", async () => {
    await poll();
    fake.failNext = { status: 429, code: 429, retryAfter: "1200" };
    await rewind(10 * MIN);
    await poll();
    expect(await lastError()).toContain("slow down");
    expect((await pollState()).pausedUntil).toBeGreaterThan(Date.now() + 19 * MIN);
  });

  it("stays under its hourly cap while driving, and never sends a command", async () => {
    await poll();
    fake.set(VIN, { parked: false, ignition: "on", ign3: "on", speedKph: 60 });
    const start = fake.reads;
    for (let i = 0; i < 60; i++) {
      await rewind(MIN);
      fake.set(VIN, {});
      await poll();
    }
    expect(fake.reads - start).toBeLessThanOrEqual(HOURLY_CAP);
    expect(fake.commands).toEqual([]);
  });
});
