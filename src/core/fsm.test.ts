import { describe, expect, it } from "bun:test";
import {
  DRIVE_TIMEOUT_MIN,
  INTERVALS,
  PENDING_ID,
  canFallAsleep,
  chargingInterval,
  fetchPlan,
  handle,
  type CarSettingsLike,
  type Decision,
  type Effect,
  type FsmData,
  type FsmEvent,
  type FsmState,
} from "./fsm";
import { charging, driving, parked, vehicleData } from "../../test/fixtures";

const SETTINGS: CarSettingsLike = {
  suspend_min: 21,
  suspend_after_idle_min: 15,
  req_not_unlocked: false,
};

const T0 = 1_700_000_000_000;

function data(state: FsmState, overrides: Partial<FsmData> = {}): FsmData {
  return {
    state,
    lastUsedAt: T0,
    lastStateChangeAt: T0,
    lastResponse: null,
    onlineProbeStreak: 0,
    ...overrides,
  };
}

function effectTypes(decision: Decision): Effect["type"][] {
  return decision.effects.map((e) => e.type);
}

/** Drives the reducer through a redispatch chain the way the DO does. */
function run(initial: FsmData, event: FsmEvent, now = T0): { state: FsmState; effects: Effect[]; last: Decision } {
  let current = initial;
  const effects: Effect[] = [];
  let last!: Decision;
  for (let i = 0; i < 5; i++) {
    last = handle(current, event, SETTINGS, now);
    effects.push(...last.effects);
    let next = last.next;
    // The executor substitutes real row ids; use a stable fake id in tests.
    if (
      last.effects.some(
        (e) => e.type === "open_drive" || e.type === "open_charging_process" || e.type === "open_update",
      )
    ) {
      next = JSON.parse(JSON.stringify(next).replaceAll(String(PENDING_ID), "99")) as FsmState;
    }
    current = {
      ...current,
      state: next,
      lastUsedAt: last.resetLastUsed ? now : current.lastUsedAt,
      lastResponse: event.type === "vehicle_data" ? event.data : current.lastResponse,
    };
    if (!last.redispatch) break;
  }
  return { state: current.state, effects, last };
}

describe("cold start", () => {
  it("opens an asleep state row and polls again shortly", () => {
    const decision = handle(data({ name: "start" }), { type: "probe", state: "asleep" }, SETTINGS, T0);
    expect(decision.next).toEqual({ name: "asleep", interval: INTERVALS.asleep });
    expect(effectTypes(decision)).toContain("start_state");
    expect(decision.scheduleS).toBe(INTERVALS.fallback);
  });

  it("identifies the car and records a position when it is awake", () => {
    const { state, effects } = run(data({ name: "start" }), { type: "vehicle_data", data: parked() });
    expect(effects.map((e) => e.type)).toEqual(
      expect.arrayContaining(["update_car", "start_state", "insert_position"]),
    );
    // Redispatch lands in online and immediately evaluates sleep.
    expect(state.name).toBe("online");
  });
});

describe("fake-wake guard", () => {
  it("probes only until the car has looked online twice", () => {
    const asleep = data({ name: "asleep", interval: INTERVALS.asleep });
    expect(fetchPlan(asleep)).toBe("probe_only");
    expect(fetchPlan({ ...asleep, onlineProbeStreak: 1 })).toBe("probe_then_data");
  });

  it("stays asleep on a single online probe", () => {
    const decision = handle(
      data({ name: "asleep", interval: INTERVALS.asleep }),
      { type: "probe", state: "online" },
      SETTINGS,
      T0,
    );
    expect(decision.next.name).toBe("asleep");
    expect(decision.effects).toEqual([]);
  });

  it("never fetches vehicle_data from start or suspended without a probe first", () => {
    expect(fetchPlan(data({ name: "start" }))).toBe("probe_then_data");
    expect(fetchPlan(data({ name: "suspended", prev: { name: "online" } }))).toBe("probe_then_data");
  });

  it("polls vehicle_data directly in reachable states", () => {
    expect(fetchPlan(data({ name: "online" }))).toBe("data_with_fallback");
    expect(fetchPlan(data({ name: "driving", sub: { kind: "available" }, driveId: 1 }))).toBe("data_with_fallback");
  });
});

describe("asleep backoff ramp", () => {
  it("holds steady at the asleep interval", () => {
    const decision = handle(
      data({ name: "asleep", interval: INTERVALS.asleep }),
      { type: "probe", state: "asleep" },
      SETTINGS,
      T0,
    );
    expect(decision.scheduleS).toBe(INTERVALS.asleep);
    expect(decision.next).toEqual({ name: "asleep", interval: INTERVALS.asleep });
  });

  it("doubles a short interval after a manual resume", () => {
    const decision = handle(data({ name: "asleep", interval: 4 }), { type: "probe", state: "asleep" }, SETTINGS, T0);
    expect(decision.scheduleS).toBe(4);
    expect(decision.next).toEqual({ name: "asleep", interval: 8 });
  });

  it("routes asleep -> offline through start so a new state row opens", () => {
    const decision = handle(
      data({ name: "asleep", interval: INTERVALS.asleep }),
      { type: "probe", state: "offline" },
      SETTINGS,
      T0,
    );
    expect(decision.next).toEqual({ name: "start" });
  });
});

describe("drive lifecycle", () => {
  it("opens a drive when the car shifts into gear", () => {
    const decision = handle(data({ name: "online" }), { type: "vehicle_data", data: driving() }, SETTINGS, T0);
    expect(effectTypes(decision)).toEqual(["log", "open_drive", "insert_position"]);
    expect(decision.next).toEqual({ name: "driving", sub: { kind: "available" }, driveId: PENDING_ID });
    expect(decision.scheduleS).toBe(INTERVALS.driving);
  });

  it("records a position per poll while driving", () => {
    const decision = handle(
      data({ name: "driving", sub: { kind: "available" }, driveId: 7 }),
      { type: "vehicle_data", data: driving({ odometer: 10_010 }) },
      SETTINGS,
      T0,
    );
    expect(effectTypes(decision)).toEqual(["insert_position"]);
    expect(decision.next).toEqual({ name: "driving", sub: { kind: "available" }, driveId: 7 });
    expect(decision.resetLastUsed).toBe(true);
  });

  it("closes the drive when parked", () => {
    const { state, effects } = run(data({ name: "driving", sub: { kind: "available" }, driveId: 7 }), {
      type: "vehicle_data",
      data: parked({ odometer: 10_050 }),
    });
    expect(effects.map((e) => e.type)).toEqual(expect.arrayContaining(["insert_position", "close_drive"]));
    expect(state.name).toBe("online");
  });

  it("converts position units to SI", () => {
    const decision = handle(
      data({ name: "driving", sub: { kind: "available" }, driveId: 7 }),
      { type: "vehicle_data", data: driving({ speed: 62, odometer: 100 }) },
      SETTINGS,
      T0,
    );
    const effect = decision.effects[0];
    if (effect?.type !== "insert_position") throw new Error("expected a position insert");
    expect(effect.attrs.speed).toBe(100); // 62 mph -> 100 km/h
    expect(effect.attrs.odometer).toBeCloseTo(160.934, 2);
  });
});

describe("drive offline ladder", () => {
  it("steps available -> unavailable -> offline", () => {
    let state: FsmState = { name: "driving", sub: { kind: "available" }, driveId: 7 };
    let decision = handle(data(state), { type: "probe", state: "offline" }, SETTINGS, T0);
    expect(decision.next).toEqual({ name: "driving", sub: { kind: "unavailable", n: 0 }, driveId: 7 });
    expect(decision.scheduleS).toBe(5);

    // Counts 0..15 at 5 s each, then declares the car offline on the next poll.
    state = decision.next;
    let polls = 0;
    while (state.name === "driving" && state.sub.kind === "unavailable" && polls < 50) {
      decision = handle(data(state), { type: "probe", state: "offline" }, SETTINGS, T0);
      state = decision.next;
      polls++;
    }
    expect(polls).toBe(16);
    expect(state).toEqual({ name: "driving", sub: { kind: "offline" }, driveId: 7 });
    expect(decision.scheduleS).toBe(INTERVALS.asleep);
  });

  it("times out the drive after 15 minutes offline", () => {
    const last = driving({ at: T0 });
    const state: FsmState = { name: "driving", sub: { kind: "offline" }, driveId: 7 };
    const now = T0 + (DRIVE_TIMEOUT_MIN + 1) * 60_000;
    const decision = handle(data(state, { lastResponse: last }), { type: "probe", state: "offline" }, SETTINGS, now);
    expect(effectTypes(decision)).toContain("close_drive");
    expect(decision.next).toEqual({ name: "driving", sub: { kind: "offline" }, driveId: null });
  });

  it("keeps the drive open before the timeout", () => {
    const last = driving({ at: T0 });
    const state: FsmState = { name: "driving", sub: { kind: "offline" }, driveId: 7 };
    const decision = handle(
      data(state, { lastResponse: last }),
      { type: "probe", state: "offline" },
      SETTINGS,
      T0 + 5 * 60_000,
    );
    expect(effectTypes(decision)).not.toContain("close_drive");
  });

  it("synthesizes a charge session when range was gained while offline", () => {
    const last = driving({ at: T0, idealRange: 100 });
    const back = parked({ at: T0 + 30 * 60_000, idealRange: 150 });
    const { effects } = run(
      data({ name: "driving", sub: { kind: "offline" }, driveId: 7 }, { lastResponse: last }),
      { type: "vehicle_data", data: back },
      T0 + 30 * 60_000,
    );
    const types = effects.map((e) => e.type);
    expect(types).toContain("close_drive");
    expect(types).toContain("synthesize_charging_process");
  });

  it("does not synthesize a charge for a small range change", () => {
    const last = driving({ at: T0, idealRange: 100 });
    const back = driving({ at: T0 + 6 * 60_000, idealRange: 102 });
    const { effects } = run(
      data({ name: "driving", sub: { kind: "offline" }, driveId: 7 }, { lastResponse: last }),
      { type: "vehicle_data", data: back },
      T0 + 6 * 60_000,
    );
    expect(effects.map((e) => e.type)).not.toContain("synthesize_charging_process");
  });

  it("closes the drive if the car fell asleep mid-drive", () => {
    const decision = handle(
      data({ name: "driving", sub: { kind: "available" }, driveId: 7 }),
      { type: "probe", state: "asleep" },
      SETTINGS,
      T0,
    );
    expect(effectTypes(decision)).toContain("close_drive");
    expect(decision.next).toEqual({ name: "start" });
  });
});

describe("charge lifecycle", () => {
  it("opens a charging process and records the first sample", () => {
    const decision = handle(data({ name: "online" }), { type: "vehicle_data", data: charging() }, SETTINGS, T0);
    expect(effectTypes(decision)).toEqual(["log", "open_charging_process", "insert_charge"]);
    expect(decision.next).toEqual({ name: "charging", cprocId: PENDING_ID });
    expect(decision.scheduleS).toBe(INTERVALS.charging);
  });

  it("scales the poll interval with charger power", () => {
    expect(chargingInterval(null)).toBe(5);
    expect(chargingInterval(0)).toBe(5);
    expect(chargingInterval(150)).toBe(5); // fast DC -> floor of 5 s
    expect(chargingInterval(11)).toBe(20); // slow AC -> cap of 20 s
    expect(chargingInterval(25)).toBe(10);
  });

  it("appends samples while charging continues", () => {
    const decision = handle(
      data({ name: "charging", cprocId: 3 }),
      { type: "vehicle_data", data: charging({ chargeEnergyAdded: 5.5 }) },
      SETTINGS,
      T0,
    );
    expect(effectTypes(decision)).toEqual(["insert_charge"]);
    expect(decision.next).toEqual({ name: "charging", cprocId: 3 });
  });

  it("completes the session when charging stops", () => {
    const { state, effects } = run(data({ name: "charging", cprocId: 3 }), {
      type: "vehicle_data",
      data: parked({ chargingState: "Complete" }),
    });
    expect(effects.map((e) => e.type)).toEqual(
      expect.arrayContaining(["insert_position", "insert_charge", "complete_charging_process"]),
    );
    expect(state.name).toBe("online");
  });

  it("completes the session if the car falls asleep while plugged in", () => {
    const decision = handle(data({ name: "charging", cprocId: 3 }), { type: "probe", state: "asleep" }, SETTINGS, T0);
    expect(effectTypes(decision)).toContain("complete_charging_process");
  });

  it("waits rather than closing the session when the car goes offline", () => {
    const decision = handle(data({ name: "charging", cprocId: 3 }), { type: "probe", state: "offline" }, SETTINGS, T0);
    expect(effectTypes(decision)).not.toContain("complete_charging_process");
    expect(decision.next).toEqual({ name: "charging", cprocId: 3 });
  });
});

describe("sleep preservation", () => {
  const idle = (minutes: number) => T0 + minutes * 60_000;

  it("does not suspend before the idle threshold", () => {
    const decision = handle(data({ name: "online" }), { type: "vehicle_data", data: parked() }, SETTINGS, idle(5));
    expect(decision.next).toEqual({ name: "online" });
    expect(decision.scheduleS).toBe(INTERVALS.default);
    expect(decision.effects).toEqual([]);
  });

  it("suspends once idle long enough", () => {
    const decision = handle(data({ name: "online" }), { type: "vehicle_data", data: parked() }, SETTINGS, idle(16));
    expect(decision.next).toEqual({ name: "suspended", prev: { name: "online" } });
    expect(decision.scheduleS).toBe(SETTINGS.suspend_min * 60);
    expect(effectTypes(decision)).toContain("insert_position");
  });

  it("stays suspended while the car is still awake", () => {
    const state: FsmState = { name: "suspended", prev: { name: "online" } };
    const decision = handle(data(state), { type: "vehicle_data", data: parked() }, SETTINGS, idle(30));
    expect(decision.next).toEqual(state);
    expect(decision.stateChanged).toBeUndefined();
  });

  it.each([
    ["sentry mode", { sentryMode: true }, 30],
    ["preconditioning", { isPreconditioning: true }, 30],
    ["dog mode", { climateKeeperMode: "dog" }, 30],
    ["driver present", { isUserPresent: true }, INTERVALS.default],
    ["open door", { doorOpen: true }, INTERVALS.default],
    ["open trunk", { trunkOpen: true }, INTERVALS.default],
    ["power draw", { power: 3 }, INTERVALS.default],
  ])("refuses to suspend during %s", (_label, overrides, scheduleS) => {
    const decision = handle(
      data({ name: "online" }),
      { type: "vehicle_data", data: parked(overrides) },
      SETTINGS,
      idle(20),
    );
    expect(decision.next).toEqual({ name: "online" });
    expect(decision.suspendBlocker).toBeTruthy();
    expect(decision.scheduleS).toBe(scheduleS);
  });

  it("treats an unlocked car as a blocker only when configured", () => {
    const unlocked = parked({ locked: false });
    expect(canFallAsleep(unlocked, SETTINGS)).toBeNull();
    expect(canFallAsleep(unlocked, { ...SETTINGS, req_not_unlocked: true })).toBe("unlocked");
  });

  it("keeps the idle timer running while merely unlocked", () => {
    const decision = handle(
      data({ name: "online" }),
      { type: "vehicle_data", data: parked({ locked: false }) },
      { ...SETTINGS, req_not_unlocked: true },
      idle(20),
    );
    // Every other blocker counts as activity; `unlocked` must not.
    expect(decision.resetLastUsed).toBe(false);
  });

  it("blocks sleep while an update is downloading but not once complete", () => {
    expect(canFallAsleep(parked({ updateStatus: "downloading", downloadPerc: 40 }), SETTINGS)).toBe(
      "downloading_update",
    );
    expect(canFallAsleep(parked({ updateStatus: "downloading", downloadPerc: 100 }), SETTINGS)).toBeNull();
  });

  it("checks blockers in TeslaMate's order", () => {
    const both = parked({ isUserPresent: true, sentryMode: true });
    expect(canFallAsleep(both, SETTINGS)).toBe("user_present");
  });
});

describe("software updates", () => {
  it("starts tracking an installing update", () => {
    const decision = handle(
      data({ name: "online" }),
      { type: "vehicle_data", data: parked({ updateStatus: "installing" }) },
      SETTINGS,
      T0,
    );
    expect(effectTypes(decision)).toContain("open_update");
    expect(decision.next).toEqual({ name: "updating", updateId: PENDING_ID });
  });

  it("keeps waiting while installing", () => {
    const decision = handle(
      data({ name: "updating", updateId: 4 }),
      { type: "vehicle_data", data: parked({ updateStatus: "installing" }) },
      SETTINGS,
      T0,
    );
    expect(decision.next).toEqual({ name: "updating", updateId: 4 });
    expect(decision.effects).toEqual([]);
  });

  it("records the installed version when the update finishes", () => {
    const { effects } = run(data({ name: "updating", updateId: 4 }), {
      type: "vehicle_data",
      data: parked({ updateStatus: "", carVersion: "2024.20.1 xyz" }),
    });
    const finish = effects.find((e) => e.type === "finish_update");
    expect(finish).toMatchObject({ updateId: 4, version: "2024.20.1 xyz" });
  });

  it("discards a canceled update", () => {
    const { effects } = run(data({ name: "updating", updateId: 4 }), {
      type: "vehicle_data",
      data: parked({ updateStatus: "available" }),
    });
    expect(effects.map((e) => e.type)).toContain("cancel_update");
  });
});

describe("stale payloads", () => {
  it("discards data older than what was already processed", () => {
    const fresh = parked({ at: T0 + 60_000 });
    const stale = parked({ at: T0 });
    const decision = handle(
      data({ name: "online" }, { lastResponse: fresh }),
      { type: "vehicle_data", data: stale },
      SETTINGS,
      T0 + 60_000,
    );
    expect(decision.effects).toEqual([{ type: "log", level: "warn", message: "Discarded stale vehicle_data" }]);
    expect(decision.scheduleS).toBe(2);
  });
});

describe("manual resume", () => {
  it("returns to the previous state and polls immediately", () => {
    const decision = handle(data({ name: "suspended", prev: { name: "online" } }), { type: "resume" }, SETTINGS, T0);
    expect(decision.next).toEqual({ name: "online" });
    expect(decision.scheduleS).toBe(1);
  });
});

describe("payload robustness", () => {
  it("tolerates a payload with no shift state or charge info", () => {
    const bare = vehicleData({ shiftState: null, chargingState: null });
    const decision = handle(data({ name: "online" }), { type: "vehicle_data", data: bare }, SETTINGS, T0);
    expect(decision.next.name).toBe("online");
  });
});
