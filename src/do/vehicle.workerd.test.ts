import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { charging, driving, parked } from "../../test/fixtures";
import type { VehicleDO } from "./vehicle";

/**
 * Integration tests for the logging runtime: the DO drives its own polling loop,
 * so these stub `fetch` to impersonate the Tesla Owner API and then assert what
 * ended up in D1 and how the next alarm was scheduled.
 */

const CAR_ID = 1;
const EID = 10;

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
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, ?, 20, 'VIN1', 'Bro', ?, ?)",
  )
    .bind(CAR_ID, EID, now, now)
    .run();
  await env.DB.prepare("INSERT INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
}

/**
 * Response bodies must be constructed inside the mock implementation: an object
 * created in the test's I/O context cannot be read from a Durable Object's.
 */
async function signInTesla() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 28_800 }),
  );
  const result = await env.AUTH_DO.getByName("default").signIn("access-1", "refresh-1");
  expect(result.ok).toBe(true);
}

type Reply = { probe: "online" | "asleep" | "offline" } | { data: unknown } | { status: number; body?: string };

/** Queue of canned Owner API responses, consumed in order. */
function mockTesla(replies: Reply[]) {
  const calls: string[] = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    if (!reply) throw new Error(`no canned reply for ${url}`);
    if ("status" in reply) return new Response(reply.body ?? "{}", { status: reply.status });
    if ("probe" in reply) return Response.json({ response: { id: EID, state: reply.probe } });
    return Response.json({ response: reply.data });
  });
  return calls;
}

function stub() {
  return env.VEHICLE_DO.getByName(`car:${CAR_ID}`);
}

async function alarmNow() {
  await runInDurableObject(stub(), async (instance: VehicleDO) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
}

async function fsmState(): Promise<string> {
  return runInDurableObject(stub(), async (_instance, state) => {
    const fsm = await state.storage.get<{ state: { name: string } }>("fsm");
    return fsm?.state.name ?? "none";
  });
}

async function bufferLength(): Promise<number> {
  return runInDurableObject(stub(), async (_instance, state) => {
    const buffer = await state.storage.get<unknown[]>("buffer");
    return buffer?.length ?? 0;
  });
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return row?.count ?? 0;
}

/** The alarm clock: set only for cadences too short for the cron to serve. */
async function alarmIn(): Promise<number | null> {
  const at = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
  return at === null ? null : at - Date.now();
}

/** The cron clock: the deadline published to D1 for the cron to read. */
async function dueIn(): Promise<number | null> {
  const row = await env.DB.prepare("SELECT next_due_at FROM cars WHERE id = ?")
    .bind(CAR_ID)
    .first<{ next_due_at: number | null }>();
  return row?.next_due_at == null ? null : row.next_due_at - Date.now();
}

describe("VehicleDO polling loop", () => {
  beforeEach(async () => {
    await reset();
    await runInDurableObject(stub(), async (_i, state) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
    vi.restoreAllMocks();
    await signInTesla();
    vi.restoreAllMocks();
    await stub().ensureRunning(CAR_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("arms an alarm when registered", async () => {
    const alarm = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it("records the car as asleep without ever calling vehicle_data", async () => {
    const calls = mockTesla([{ probe: "asleep" }]);
    await alarmNow();

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("vehicle_data");
    expect(await fsmState()).toBe("asleep");
    const state = await env.DB.prepare("SELECT state FROM states WHERE car_id = ?")
      .bind(CAR_ID)
      .first<{ state: string }>();
    expect(state?.state).toBe("asleep");
  });

  it("needs two consecutive online probes before waking the car", async () => {
    await mockTesla([{ probe: "asleep" }]);
    await alarmNow();
    vi.restoreAllMocks();

    // First online probe: still no vehicle_data call.
    const first = mockTesla([{ probe: "online" }]);
    await alarmNow();
    expect(first.some((u) => u.includes("vehicle_data"))).toBe(false);
    expect(await fsmState()).toBe("asleep");
    vi.restoreAllMocks();

    // Second consecutive online probe: now it is worth spending a wake.
    const second = mockTesla([{ probe: "online" }, { data: parked() }]);
    await alarmNow();
    expect(second.some((u) => u.includes("vehicle_data"))).toBe(true);
    expect(await fsmState()).toBe("online");
  });

  it("resets the online streak when the car reports asleep again", async () => {
    mockTesla([{ probe: "asleep" }]);
    await alarmNow(); // settle into the asleep state
    vi.restoreAllMocks();

    // online (streak 1) -> asleep (streak 0) -> online (streak 1 again).
    // A blip that is interrupted by a real asleep reading must not accumulate.
    const calls = mockTesla([{ probe: "online" }, { probe: "asleep" }, { probe: "online" }]);
    await alarmNow();
    await alarmNow();
    await alarmNow();
    expect(calls.some((u) => u.includes("vehicle_data"))).toBe(false);
    expect(await fsmState()).toBe("asleep");
  });

  it("logs a drive end to end and aggregates it", async () => {
    const t = Date.now();
    mockTesla([{ data: parked({ at: t }) }]);
    await alarmNow(); // start -> online
    vi.restoreAllMocks();

    mockTesla([{ data: driving({ at: t + 1000, odometer: 1000 }) }]);
    await alarmNow(); // online -> driving
    expect(await fsmState()).toBe("driving");
    vi.restoreAllMocks();

    mockTesla([{ data: driving({ at: t + 60_000, odometer: 1010 }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    mockTesla([{ data: parked({ at: t + 120_000, odometer: 1020 }) }]);
    await alarmNow(); // parked -> close the drive
    expect(await fsmState()).toBe("online");

    const drive = await env.DB.prepare("SELECT distance, duration_min, end_date_at FROM drives").first<{
      distance: number;
      duration_min: number;
      end_date_at: number | null;
    }>();
    expect(drive).not.toBeNull();
    expect(drive!.distance).toBeCloseTo(32.19, 1);
    expect(drive!.duration_min).toBe(2);
    expect(drive!.end_date_at).not.toBeNull();
    expect(await countRows("positions")).toBeGreaterThanOrEqual(4);
  });

  it("buffers drive positions instead of writing on every poll", async () => {
    const t = Date.now();
    mockTesla([{ data: parked({ at: t }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    mockTesla([{ data: driving({ at: t + 1000, odometer: 1000 }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    const rowsBefore = await countRows("positions");
    const bufferedBefore = await bufferLength();

    mockTesla([{ data: driving({ at: t + 3000, odometer: 1001 }) }]);
    await alarmNow();

    // The new position sits in the buffer rather than hitting D1 immediately.
    expect(await bufferLength()).toBe(bufferedBefore + 1);
    expect(await countRows("positions")).toBe(rowsBefore);
  });

  it("logs a charging session end to end", async () => {
    const t = Date.now();
    mockTesla([{ data: parked({ at: t }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    mockTesla([{ data: charging({ at: t + 1000, chargeEnergyAdded: 0, batteryLevel: 50 }) }]);
    await alarmNow();
    expect(await fsmState()).toBe("charging");
    vi.restoreAllMocks();

    mockTesla([{ data: charging({ at: t + 600_000, chargeEnergyAdded: 10, batteryLevel: 70 }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    mockTesla([{ data: parked({ at: t + 660_000, chargingState: "Complete", batteryLevel: 70 }) }]);
    await alarmNow();
    expect(await fsmState()).toBe("online");

    const cproc = await env.DB.prepare(
      "SELECT charge_energy_added, start_battery_level, end_battery_level, duration_min FROM charging_processes",
    ).first<{
      charge_energy_added: number;
      start_battery_level: number;
      end_battery_level: number;
      duration_min: number;
    }>();
    expect(cproc).not.toBeNull();
    expect(cproc!.charge_energy_added).toBeCloseTo(10, 2);
    expect(cproc!.start_battery_level).toBe(50);
    expect(cproc!.end_battery_level).toBe(70);
  });

  it("polls faster while driving than while parked", async () => {
    const t = Date.now();
    mockTesla([{ data: parked({ at: t }) }]);
    await alarmNow();
    const parkedAlarm = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    vi.restoreAllMocks();

    mockTesla([{ data: driving({ at: t + 1000, odometer: 1000 }) }]);
    await alarmNow();
    const drivingAlarm = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());

    expect(drivingAlarm! - Date.now()).toBeLessThan(parkedAlarm! - Date.now());
    expect(drivingAlarm! - Date.now()).toBeLessThanOrEqual(2_500);
  });

  it("backs off for the requested period when rate limited", async () => {
    mockTesla([{ status: 429 }]);
    await alarmNow();
    // Default retry-after is 300 s when Tesla sends no header. Five minutes is
    // the cron's to keep — holding an alarm that long would keep the object
    // resident for the whole backoff, which is the opposite of backing off.
    expect(await alarmIn()).toBeNull();
    expect(await dueIn()).toBeGreaterThan(250_000);
  });

  it("waits on the cron, with no alarm armed, once the car has settled asleep", async () => {
    mockTesla([{ probe: "asleep" }]);
    await alarmNow();
    await alarmNow();
    expect(await fsmState()).toBe("asleep");

    expect(await alarmIn()).toBeNull();
    const due = await dueIn();
    expect(due).toBeGreaterThan(50_000);
    expect(due).toBeLessThanOrEqual(60_000);
  });

  it("keeps the alarm while driving, with the cron's deadline behind it", async () => {
    const t = Date.now();
    mockTesla([{ data: parked({ at: t }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    mockTesla([{ data: driving({ at: t + 1000, odometer: 1000 }) }]);
    await alarmNow();

    // 2.5 s is far too fine for a one-minute cron, so this cadence stays on the
    // alarm — and the deadline sits a period past it, purely to heal a lost one.
    expect(await alarmIn()).toBeLessThanOrEqual(2_500);
    expect(await dueIn()).toBeGreaterThan(60_000);
  });

  it("leaves a car alone when the cron calls and its fast alarm already owns it", async () => {
    const t = Date.now();
    mockTesla([{ data: parked({ at: t }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    mockTesla([{ data: driving({ at: t + 1000, odometer: 1000 }) }]);
    await alarmNow();
    vi.restoreAllMocks();

    // The watchdog deadline can come round while the drive loop is healthy. It
    // must not turn into a second poll on top of the alarm's.
    const calls = mockTesla([{ data: driving({ at: t + 2000, odometer: 1001 }) }]);
    await stub().pollDue(CAR_ID);
    expect(calls).toHaveLength(0);
  });

  it("falls back to the cheap probe when vehicle_data reports the car unavailable", async () => {
    mockTesla([{ data: parked() }]);
    await alarmNow();
    expect(await fsmState()).toBe("online");
    vi.restoreAllMocks();

    const calls = mockTesla([{ status: 408, body: '{"error":"vehicle unavailable:"}' }, { probe: "asleep" }]);
    await alarmNow();
    expect(calls).toHaveLength(2);
    // online -> asleep routes through `start` so the next poll opens a state row.
    expect(await fsmState()).toBe("start");

    await alarmNow();
    expect(await fsmState()).toBe("asleep");
    const state = await env.DB.prepare("SELECT state FROM states WHERE end_date_at IS NULL").first<{ state: string }>();
    expect(state?.state).toBe("asleep");
  });

  it("stops polling when the car is disabled", async () => {
    await env.DB.prepare("UPDATE car_settings SET enabled = 0 WHERE car_id = ?").bind(CAR_ID).run();
    mockTesla([{ probe: "asleep" }]);
    await alarmNow();
    // Off both clocks — a deadline left behind would have the cron poll a car
    // whose logging is switched off.
    expect(await alarmIn()).toBeNull();
    expect(await dueIn()).toBeNull();
  });

  it("suspends logging only when nothing blocks sleep", async () => {
    mockTesla([{ data: parked({ sentryMode: true }) }]);
    await alarmNow();
    const refused = await stub().suspendLogging();
    expect(refused).toEqual({ ok: false, reason: "Sentry mode is enabled" });
    vi.restoreAllMocks();

    mockTesla([{ data: parked() }]);
    await alarmNow();
    const accepted = await stub().suspendLogging();
    expect(accepted.ok).toBe(true);
    expect(await fsmState()).toBe("suspended");
  });

  it("reports a summary the API can serve", async () => {
    mockTesla([{ data: parked({ batteryLevel: 63, odometer: 12_345 }) }]);
    await alarmNow();
    const summary = await stub().getSummary();
    expect(summary).toMatchObject({ carId: CAR_ID, state: "online", batteryLevel: 63, healthy: true });
    expect(summary!.odometerKm).toBeCloseTo(19_867.4, 0);
  });

  it("carries the diagnostics in the summary", async () => {
    mockTesla([{ data: parked({ tpmsSoftWarningRl: true, doorOpen: true }) }]);
    await alarmNow();
    const summary = await stub().getSummary();
    expect(summary).toMatchObject({
      tpmsSoftWarningRl: true,
      tpmsSoftWarningFl: false,
      doorDfOpen: true,
      doorPfOpen: false,
      windowFdOpen: false,
      passengerTempSetting: 21,
      dashcamState: "Recording",
      scheduledChargingPending: false,
      cabinOverheatProtection: "On",
      copActivelyCooling: false,
      autoSeatClimateLeft: true,
      autoSeatClimateRight: false,
      batteryHeater: false,
      connChargeCable: "IEC",
      tripCharging: false,
      activeRoute: null,
    });
    expect(summary!.dataAt).toBe(1_700_000_000_000);
  });

  it("keeps a tyre history from the snapshots it already fetches, downsampled", async () => {
    const t0 = 1_700_000_000_000;
    const poll = async (minutes: number, tpms: NonNullable<Parameters<typeof parked>[0]>["tpms"] = {}) => {
      vi.restoreAllMocks();
      mockTesla([{ data: parked({ at: t0 + minutes * 60_000, tpms: { tpms_rcp_front_value: 2.9, ...tpms } }) }]);
      await alarmNow();
    };
    await poll(0);
    await poll(5); // nothing changed, too soon: no row
    await poll(6, { tpms_soft_warning_rl: true }); // a warning appears: written at once
    await poll(10, { tpms_soft_warning_rl: true });
    await poll(21, { tpms_soft_warning_rl: true }); // quarter of an hour on: written

    const rows = await env.DB.prepare(
      "SELECT date_at, pressure_rl, recommended_front, recommended_rear, soft_warning_rl, hard_warning_rl " +
        "FROM tyre_readings WHERE car_id = ? ORDER BY date_at",
    )
      .bind(CAR_ID)
      .all<Record<string, number | null>>();
    expect(rows.results.map((r) => (r.date_at! - t0) / 60_000)).toEqual([0, 6, 21]);
    // Unknown stays NULL — the fixture sends no rear recommendation and no hard warnings.
    expect(rows.results[0]).toMatchObject({
      pressure_rl: 2.9,
      recommended_front: 2.9,
      recommended_rear: null,
      soft_warning_rl: 0,
      hard_warning_rl: null,
    });
    expect(rows.results[1]).toMatchObject({ soft_warning_rl: 1 });

    const summary = await stub().getSummary();
    expect(summary!.tyres.map((t) => t.status)).toEqual(["ok", "ok", "low", "ok"]);
  });

  it("records no tyre row for a snapshot without pressures", async () => {
    mockTesla([
      {
        data: parked({
          tpms: { tpms_pressure_fl: null, tpms_pressure_fr: null, tpms_pressure_rl: null, tpms_pressure_rr: null },
        }),
      },
    ]);
    await alarmNow();
    expect(await countRows("tyre_readings")).toBe(0);
    const summary = await stub().getSummary();
    expect(summary!.tyres.every((t) => t.status === "unknown")).toBe(true);
  });

  it("reports the active route while navigating", async () => {
    mockTesla([{ data: driving({ activeRouteDestination: "Fixture Depot" }) }]);
    await alarmNow();
    const summary = await stub().getSummary();
    expect(summary!.activeRoute).toMatchObject({
      destination: "Fixture Depot",
      minutesToArrival: 12.4,
      trafficMinutesDelay: 2,
      energyAtArrival: 55,
    });
    expect(summary!.activeRoute!.distanceKm).toBeCloseTo(7.4, 1);
  });

  it("wake short-circuits the fake-wake guard", async () => {
    mockTesla([{ probe: "asleep" }]);
    await alarmNow();
    expect(await fsmState()).toBe("asleep");
    vi.restoreAllMocks();

    const calls = mockTesla([{ probe: "online" }]); // the wake_up reply
    expect(await stub().wake()).toEqual({ ok: true });
    expect(calls.some((url) => url.endsWith("/wake_up"))).toBe(true);

    const streak = await runInDurableObject(stub(), async (_i, state) => {
      const fsm = await state.storage.get<{ onlineProbeStreak: number }>("fsm");
      return fsm?.onlineProbeStreak;
    });
    expect(streak).toBe(1);
    const alarm = await runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
    expect(alarm! - Date.now()).toBeLessThanOrEqual(1_000);
    vi.restoreAllMocks();

    // With the streak credited, one tick reaches online — the guard would have
    // spent this tick on a second probe (see the two-probe test above).
    mockTesla([{ probe: "online" }, { data: parked() }]);
    await alarmNow();
    expect(await fsmState()).toBe("online");
  });

  it("wake is a no-op when the car is already awake", async () => {
    mockTesla([{ data: parked() }]);
    await alarmNow();
    vi.restoreAllMocks();

    const calls = mockTesla([{ probe: "online" }]);
    expect(await stub().wake()).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("sendDestination shares the address with an awake car", async () => {
    mockTesla([{ data: parked() }]);
    await alarmNow();
    vi.restoreAllMocks();

    const calls = mockTesla([{ data: { result: true, reason: "" } }]);
    expect(await stub().sendDestination("Berliner Str. 1, Berlin")).toEqual({ ok: true });
    expect(calls.some((url) => url.endsWith("/command/navigation_request"))).toBe(true);
  });

  it("sendDestination surfaces refusals instead of waking the car", async () => {
    mockTesla([{ data: parked() }]);
    await alarmNow();
    vi.restoreAllMocks();

    mockTesla([{ status: 408, body: '{"error":"vehicle unavailable:"}' }]);
    expect(await stub().sendDestination("Somewhere")).toEqual({
      ok: false,
      reason: "Car is asleep — wake it first",
    });
    vi.restoreAllMocks();

    mockTesla([{ data: { result: false, reason: "no nav data" } }]);
    expect(await stub().sendDestination("Somewhere")).toEqual({ ok: false, reason: "no nav data" });

    expect(await stub().sendDestination("   ")).toEqual({ ok: false, reason: "Destination is empty" });
  });
});
