import type { CarAttrs, ChargeAttrs, PositionAttrs, VehicleData } from "./tesla/payload";
import { createCharge, createPosition, identify, snapshotDate } from "./tesla/payload";

/**
 * Pure port of TeslaMate's vehicle state machine (lib/teslamate/vehicles/vehicle.ex)
 * in polling mode (`use_streaming_api: false`).
 *
 * `handle()` is a pure function: (data, event, settings, now) -> Decision.
 * It never performs I/O — the vehicle actor executes the returned effects and
 * persists the returned state. That keeps TeslaMate's scenario tests portable
 * as fixture-driven unit tests.
 */

// Polling intervals in seconds, matching TeslaMate's defaults for i = 1
// (i is 2 only in streaming mode, which EVBook does not implement).
export const INTERVALS = {
  /**
   * TeslaMate polls a sleeping car every 30 s; this is 60 s so the idle cadence
   * reaches the cron's period and can be scheduled without an armed alarm. That
   * is the whole difference between a parked car costing a resident Durable
   * Object around the clock and costing nothing between polls.
   */
  asleep: 60,
  driving: 2.5,
  default: 15,
  online: 60,
  charging: 5,
  /** TeslaMate's bare `schedule_fetch(data)` with no explicit interval. */
  fallback: 10,
  /**
   * Gap between the two probes of the fake-wake guard. Deliberately not
   * `asleep`: the guard is timing the length of an MCU2 subsystem blip, not
   * saving polls, and lengthening it with the idle cadence would let a longer
   * blip through and spend a wake on it. Every second here is a second of
   * blindness at a real wake — a driver who pulls away immediately is this
   * far down the road before the first sample — so it is as short as the
   * blips (a few seconds) leave safe. If a car starts waking hourly, this is
   * the number that got too small.
   */
  wakeConfirm: 15,
} as const;

export const DRIVE_TIMEOUT_MIN = 15;

/** Placeholder for the id of a row created by this decision's own effects. */
export const PENDING_ID = -1;

type DriveSub = { kind: "available" } | { kind: "unavailable"; n: number } | { kind: "offline" };

export type FsmState =
  | { name: "start" }
  | { name: "asleep"; interval: number }
  | { name: "offline"; interval: number }
  | { name: "online" }
  | { name: "driving"; sub: DriveSub; driveId: number | null }
  | { name: "charging"; cprocId: number }
  | { name: "updating"; updateId: number }
  | { name: "suspended"; prev: FsmState };

export interface FsmData {
  state: FsmState;
  /** Last time the car showed activity — drives suspend_after_idle_min. */
  lastUsedAt: number;
  lastStateChangeAt: number;
  /** Last full online payload; the offline-drive ladder compares against it. */
  lastResponse: VehicleData | null;
  /** Consecutive "online" probes seen while asleep/offline (fake-wake guard). */
  onlineProbeStreak: number;
  /**
   * The last reading that showed the car not driving — an asleep or offline
   * probe, or a parked snapshot — and the last that showed it not charging. A
   * drive or charge that opens can have begun no earlier than these: they are
   * the far side of the span its start is known to lie in. Optional because
   * state stored before they existed has neither; absent reads as unknown.
   */
  notDrivingAt?: number | null;
  notChargingAt?: number | null;
}

export type FsmEvent =
  /** A full `vehicle_data` payload — the car is awake. */
  | { type: "vehicle_data"; data: VehicleData }
  /** Result of the cheap state probe, which never wakes the car. */
  | { type: "probe"; state: "online" | "asleep" | "offline" }
  | { type: "resume" };

export type Effect =
  | { type: "start_state"; state: "online" | "asleep" | "offline"; at: number }
  | { type: "update_car"; attrs: CarAttrs }
  | { type: "insert_position"; driveId: number | null; attrs: PositionAttrs }
  /**
   * `attrs` is the first driving sample — what origin reconstruction reads.
   * `quietAt` is the last reading that showed the car not driving.
   */
  | { type: "open_drive"; at: number; attrs: PositionAttrs; quietAt: number | null }
  /** `seenAt`: a reading after the last sample that showed the drive over. */
  | { type: "close_drive"; driveId: number; seenAt?: number }
  /** `quietAt` is the last reading that showed the car not charging. */
  | { type: "open_charging_process"; at: number; position: PositionAttrs; quietAt: number | null }
  | { type: "insert_charge"; cprocId: number; attrs: ChargeAttrs }
  /** `seenAt`: a reading after the last sample that showed the session over. */
  | { type: "complete_charging_process"; cprocId: number; seenAt?: number }
  | { type: "open_update"; at: number }
  | { type: "finish_update"; updateId: number; version: string | null; at: number }
  | { type: "cancel_update"; updateId: number }
  | { type: "synthesize_charging_process"; position: PositionAttrs; charges: ChargeAttrs[] }
  | { type: "log"; level: "info" | "warn"; message: string };

export interface Decision {
  effects: Effect[];
  next: FsmState;
  /** Seconds until the next fetch. Ignored when `redispatch` is set. */
  scheduleS: number;
  /** Re-handle the same payload in the new state (TeslaMate's :next_event). */
  redispatch?: boolean;
  /** Reset `lastUsedAt` — the car showed activity. */
  resetLastUsed?: boolean;
  stateChanged?: boolean;
  /** Reason a manual suspend request was refused. */
  suspendBlocker?: Blocker;
}

export interface CarSettingsLike {
  suspend_min: number;
  suspend_after_idle_min: number;
  req_not_unlocked: boolean;
}

export type Blocker =
  | "user_present"
  | "preconditioning"
  | "dogmode"
  | "sentry_mode"
  | "downloading_update"
  | "doors_open"
  | "trunk_open"
  | "unlocked"
  | "power_usage";

export const BLOCKER_MESSAGES: Record<Blocker, string> = {
  user_present: "Driver is present",
  preconditioning: "Car is preconditioning",
  dogmode: "Dog Mode is enabled",
  sentry_mode: "Sentry mode is enabled",
  downloading_update: "An update is downloading",
  doors_open: "Doors are open",
  trunk_open: "Trunk is open",
  unlocked: "Car is unlocked",
  power_usage: "Power is being used",
};

/** Port of can_fall_asleep/2 — checks are ordered exactly as in TeslaMate. */
export function canFallAsleep(v: VehicleData, settings: CarSettingsLike): Blocker | null {
  const vs = v.vehicle_state;
  const cl = v.climate_state;
  if (vs?.is_user_present === true) return "user_present";
  if (cl?.is_preconditioning === true) return "preconditioning";
  if (cl?.climate_keeper_mode === "dog") return "dogmode";
  if (vs?.sentry_mode === true) return "sentry_mode";
  const su = vs?.software_update;
  if (su?.status === "downloading" && typeof su.download_perc === "number" && su.download_perc < 100) {
    return "downloading_update";
  }
  const doors = [vs?.df, vs?.pf, vs?.dr, vs?.pr];
  if (doors.every((d) => typeof d === "number") && doors.some((d) => (d as number) > 0)) {
    return "doors_open";
  }
  const trunks = [vs?.ft, vs?.rt];
  if (trunks.every((t) => typeof t === "number") && trunks.some((t) => (t as number) > 0)) {
    return "trunk_open";
  }
  if (vs?.locked === false && settings.req_not_unlocked) return "unlocked";
  const power = v.drive_state?.power;
  if (typeof power === "number" && power > 0) return "power_usage";
  return null;
}

/** Port of determince_interval/1 — charging poll rate scales with charger power. */
export function chargingInterval(power: number | null | undefined): number {
  if (power == null || power <= 0) return INTERVALS.charging;
  return Math.max(INTERVALS.charging, Math.min(20, Math.round(250 / power)));
}

/** Which fetch the DO should perform next, given the state we expect to be in. */
export type FetchPlan =
  /** Try vehicle_data; on 408 (asleep) fall back to the cheap probe. */
  | "data_with_fallback"
  /** Probe first; only fetch vehicle_data if the probe says "online". */
  | "probe_then_data"
  /** Probe only — never wake the car on a single "online" blip. */
  | "probe_only";

export function fetchPlan(data: FsmData): FetchPlan {
  switch (data.state.name) {
    case "online":
    case "driving":
    case "charging":
    case "updating":
      return "data_with_fallback";
    case "suspended":
      // The car is known to be awake; we need the blockers to decide on sleep.
      return "probe_then_data";
    case "asleep":
    case "offline":
      // Deliberate deviation from TeslaMate: MCU2 cars report "online" for a
      // brief hourly subsystem check, and calling vehicle_data then forces a
      // ~15 min wake. Require two consecutive online probes (INTERVALS.wakeConfirm
      // apart) before spending a wake. TeslaMate solves this with the streaming API.
      return data.onlineProbeStreak >= 1 ? "probe_then_data" : "probe_only";
    case "start":
      return "probe_then_data";
  }
}

const SHIFT_DRIVING = new Set(["D", "N", "R"]);

function isDriving(v: VehicleData): boolean {
  const shift = v.drive_state?.shift_state;
  return typeof shift === "string" && SHIFT_DRIVING.has(shift);
}

function isParked(v: VehicleData): boolean {
  const shift = v.drive_state?.shift_state;
  return shift == null || shift === "P";
}

function isCharging(v: VehicleData): boolean {
  const state = v.charge_state?.charging_state;
  return state === "Starting" || state === "Charging";
}

function isInstallingUpdate(v: VehicleData): boolean {
  return v.vehicle_state?.software_update?.status === "installing";
}

/** The main reducer. */
export function handle(data: FsmData, event: FsmEvent, settings: CarSettingsLike, now: number): Decision {
  const state = data.state;

  if (event.type === "resume") {
    if (state.name === "suspended") {
      return {
        effects: [{ type: "log", level: "info", message: "Resuming logging" }],
        next: state.prev,
        scheduleS: 1,
        stateChanged: true,
        resetLastUsed: true,
      };
    }
    return { effects: [], next: state, scheduleS: INTERVALS.fallback };
  }

  if (event.type === "probe") {
    return handleProbe(data, event.state, now);
  }

  const v = event.data;

  // Discard payloads older than the last one we processed and refetch shortly.
  const lastTs = data.lastResponse?.drive_state?.timestamp;
  const newTs = v.drive_state?.timestamp;
  if (typeof lastTs === "number" && typeof newTs === "number" && newTs < lastTs) {
    return {
      effects: [{ type: "log", level: "warn", message: "Discarded stale vehicle_data" }],
      next: state,
      scheduleS: 2,
    };
  }

  return handleOnline(data, v, settings, now);
}

function handleProbe(data: FsmData, probed: "online" | "asleep" | "offline", now: number): Decision {
  const state = data.state;

  if (probed === "online") {
    switch (state.name) {
      case "asleep":
      case "offline":
        // Fake-wake guard: count the streak, only escalate to vehicle_data
        // once the car has looked online across two probes.
        return {
          effects: [],
          next: state,
          scheduleS: INTERVALS.wakeConfirm,
          // The streak itself is tracked by the DO via onlineProbeStreak.
        };
      default:
        // In reachable states a bare probe carries no telemetry; poll again.
        return { effects: [], next: state, scheduleS: INTERVALS.fallback };
    }
  }

  const kind = probed; // "asleep" | "offline"

  switch (state.name) {
    case "start":
      return {
        effects: [
          { type: "log", level: "info", message: `Start / ${kind}` },
          { type: "start_state", state: kind, at: now },
        ],
        next: { name: kind, interval: INTERVALS.asleep },
        scheduleS: INTERVALS.fallback,
        stateChanged: true,
      };

    case "asleep":
    case "offline": {
      if (state.name !== kind) {
        // asleep <-> offline transitions go through :start so a state row opens.
        return { effects: [], next: { name: "start" }, scheduleS: INTERVALS.fallback };
      }
      if (state.interval >= INTERVALS.asleep) {
        return { effects: [], next: state, scheduleS: INTERVALS.asleep };
      }
      // Backoff ramp used after a manual resume: 1, 2, 4, ... 60 s.
      return {
        effects: [],
        next: { name: kind, interval: Math.min(state.interval * 2, INTERVALS.asleep) },
        scheduleS: state.interval,
      };
    }

    case "suspended":
      return { effects: [], next: { name: "start" }, scheduleS: 0, redispatch: false };

    case "online":
      return { effects: [], next: { name: "start" }, scheduleS: INTERVALS.fallback };

    case "charging":
      if (kind === "offline") {
        return {
          effects: [{ type: "log", level: "warn", message: "Vehicle went offline while charging" }],
          next: state,
          scheduleS: INTERVALS.fallback,
        };
      }
      return {
        effects: [
          { type: "log", level: "warn", message: "Vehicle went asleep while charging" },
          { type: "complete_charging_process", cprocId: state.cprocId, seenAt: now },
        ],
        next: { name: "start" },
        scheduleS: 0,
      };

    case "updating":
      return {
        effects: [{ type: "log", level: "warn", message: `Vehicle went ${kind} while updating` }],
        next: state,
        scheduleS: INTERVALS.fallback,
        resetLastUsed: true,
      };

    case "driving":
      return handleDrivingUnreachable(data, state, kind, now);
  }
}

function handleDrivingUnreachable(
  data: FsmData,
  state: Extract<FsmState, { name: "driving" }>,
  kind: "asleep" | "offline",
  now: number,
): Decision {
  if (kind === "asleep") {
    const effects: Effect[] = [{ type: "log", level: "warn", message: "Vehicle fell asleep while driving" }];
    if (state.driveId !== null) effects.push({ type: "close_drive", driveId: state.driveId, seenAt: now });
    return { effects, next: { name: "start" }, scheduleS: INTERVALS.fallback };
  }

  switch (state.sub.kind) {
    case "available":
      return {
        effects: [{ type: "log", level: "warn", message: "Vehicle went offline while driving" }],
        next: { name: "driving", sub: { kind: "unavailable", n: 0 }, driveId: state.driveId },
        scheduleS: 5,
        resetLastUsed: true,
      };

    case "unavailable": {
      if (state.sub.n < 15) {
        return {
          effects: [],
          next: { name: "driving", sub: { kind: "unavailable", n: state.sub.n + 1 }, driveId: state.driveId },
          scheduleS: 5,
          resetLastUsed: true,
        };
      }
      return {
        effects: [],
        next: { name: "driving", sub: { kind: "offline" }, driveId: state.driveId },
        scheduleS: INTERVALS.asleep,
        resetLastUsed: true,
      };
    }

    case "offline": {
      if (state.driveId === null) {
        return { effects: [], next: { name: "start" }, scheduleS: INTERVALS.fallback, resetLastUsed: true };
      }
      const offlineSince = data.lastResponse?.drive_state?.timestamp;
      const offlineMin = typeof offlineSince === "number" ? (now - offlineSince) / 60_000 : 0;
      if (offlineMin >= DRIVE_TIMEOUT_MIN) {
        return {
          effects: [
            { type: "log", level: "warn", message: `Drive timed out after ${Math.round(offlineMin)} min offline` },
            { type: "close_drive", driveId: state.driveId },
          ],
          next: { name: "driving", sub: { kind: "offline" }, driveId: null },
          scheduleS: INTERVALS.asleep,
          resetLastUsed: true,
        };
      }
      return { effects: [], next: state, scheduleS: INTERVALS.asleep, resetLastUsed: true };
    }
  }
}

function handleOnline(data: FsmData, v: VehicleData, settings: CarSettingsLike, now: number): Decision {
  const state = data.state;

  switch (state.name) {
    case "start":
      return {
        effects: [
          { type: "log", level: "info", message: "Start / online" },
          { type: "update_car", attrs: identify(v) },
          { type: "start_state", state: "online", at: snapshotDate(v) },
          { type: "insert_position", driveId: null, attrs: createPosition(v) },
        ],
        next: { name: "online" },
        scheduleS: 0,
        redispatch: true,
        stateChanged: true,
      };

    case "asleep":
    case "offline":
      return { effects: [], next: { name: "start" }, scheduleS: 0, redispatch: true, resetLastUsed: true };

    case "online":
    case "suspended":
      return handleOnlineOrSuspended(data, state, v, settings, now);

    case "charging":
      return handleChargingOnline(state, v);

    case "updating":
      return handleUpdatingOnline(state, v);

    case "driving":
      return handleDrivingOnline(data, state, v, now);
  }
}

function handleOnlineOrSuspended(
  data: FsmData,
  state: Extract<FsmState, { name: "online" | "suspended" }>,
  v: VehicleData,
  settings: CarSettingsLike,
  now: number,
): Decision {
  // Evaluated in TeslaMate's order: update, then drive, then charge, then sleep.
  if (isInstallingUpdate(v)) {
    return {
      effects: [
        { type: "log", level: "info", message: "Update / Start" },
        { type: "open_update", at: snapshotDate(v) },
      ],
      next: { name: "updating", updateId: PENDING_ID },
      scheduleS: 15,
      stateChanged: true,
      resetLastUsed: true,
    };
  }

  if (isDriving(v)) {
    return {
      effects: [
        { type: "log", level: "info", message: "Driving / Started" },
        { type: "open_drive", at: snapshotDate(v), attrs: createPosition(v), quietAt: data.notDrivingAt ?? null },
        { type: "insert_position", driveId: PENDING_ID, attrs: createPosition(v) },
      ],
      next: { name: "driving", sub: { kind: "available" }, driveId: PENDING_ID },
      scheduleS: INTERVALS.driving,
      stateChanged: true,
      resetLastUsed: true,
    };
  }

  if (isCharging(v)) {
    return {
      effects: [
        { type: "log", level: "info", message: `Charging / SOC: ${v.charge_state?.battery_level ?? "?"}%` },
        {
          type: "open_charging_process",
          at: snapshotDate(v),
          position: createPosition(v),
          quietAt: data.notChargingAt ?? null,
        },
        { type: "insert_charge", cprocId: PENDING_ID, attrs: createCharge(v) },
      ],
      next: { name: "charging", cprocId: PENDING_ID },
      scheduleS: INTERVALS.charging,
      stateChanged: true,
      resetLastUsed: true,
    };
  }

  return tryToSuspend(data, state, v, settings, now);
}

/** Port of try_to_suspend/3 with i = 1 (polling mode). */
function tryToSuspend(
  data: FsmData,
  state: Extract<FsmState, { name: "online" | "suspended" }>,
  v: VehicleData,
  settings: CarSettingsLike,
  now: number,
): Decision {
  const idleMin = (now - data.lastUsedAt) / 60_000;
  const readyToSuspend = idleMin >= settings.suspend_after_idle_min;
  const blocker = canFallAsleep(v, settings);

  if (blocker !== null) {
    // Sleep-blocking conditions that keep the car meaningfully busy poll slower.
    const slow: Blocker[] = ["sentry_mode", "preconditioning", "dogmode"];
    const scheduleS = slow.includes(blocker) ? 30 : INTERVALS.default;
    return {
      effects: readyToSuspend
        ? [{ type: "log", level: "info", message: `Cannot sleep: ${BLOCKER_MESSAGES[blocker]}` }]
        : [],
      next: state,
      scheduleS,
      // `unlocked` is the one blocker that does not count as activity, so the
      // idle timer keeps running while the car sits unlocked.
      resetLastUsed: blocker !== "unlocked",
      suspendBlocker: blocker,
    };
  }

  if (!readyToSuspend) {
    return { effects: [], next: state, scheduleS: INTERVALS.default };
  }

  const effects: Effect[] = [{ type: "insert_position", driveId: null, attrs: createPosition(v) }];
  if (state.name === "suspended") {
    return { effects, next: state, scheduleS: settings.suspend_min * 60 };
  }
  return {
    effects: [{ type: "log", level: "info", message: "Suspending logging" }, ...effects],
    next: { name: "suspended", prev: state },
    scheduleS: settings.suspend_min * 60,
    stateChanged: true,
  };
}

function handleChargingOnline(state: Extract<FsmState, { name: "charging" }>, v: VehicleData): Decision {
  if (isCharging(v)) {
    return {
      effects: [{ type: "insert_charge", cprocId: state.cprocId, attrs: createCharge(v) }],
      next: state,
      scheduleS: chargingInterval(v.charge_state?.charger_power),
      resetLastUsed: true,
    };
  }
  return {
    effects: [
      { type: "log", level: "info", message: `Charging / ${v.charge_state?.charging_state ?? "Done"}` },
      { type: "insert_position", driveId: null, attrs: createPosition(v) },
      { type: "insert_charge", cprocId: state.cprocId, attrs: createCharge(v) },
      { type: "complete_charging_process", cprocId: state.cprocId },
    ],
    next: { name: "start" },
    scheduleS: 0,
    redispatch: true,
    resetLastUsed: true,
  };
}

function handleUpdatingOnline(state: Extract<FsmState, { name: "updating" }>, v: VehicleData): Decision {
  const su = v.vehicle_state?.software_update;
  if (!v.vehicle_state || !su) {
    return {
      effects: [{ type: "log", level: "warn", message: "Update / empty payload" }],
      next: state,
      scheduleS: 5,
      resetLastUsed: true,
    };
  }
  if (su.status === "installing") {
    return { effects: [], next: state, scheduleS: INTERVALS.default, resetLastUsed: true };
  }
  if (su.status === "available") {
    return {
      effects: [
        { type: "log", level: "warn", message: "Update canceled" },
        { type: "cancel_update", updateId: state.updateId },
      ],
      next: { name: "start" },
      scheduleS: 0,
      redispatch: true,
      resetLastUsed: true,
    };
  }
  const version = v.vehicle_state.car_version ?? null;
  return {
    effects: [
      { type: "log", level: "info", message: `Update / Installed ${version ?? "?"}` },
      { type: "finish_update", updateId: state.updateId, version, at: snapshotDate(v) },
    ],
    next: { name: "start" },
    scheduleS: 0,
    redispatch: true,
    resetLastUsed: true,
  };
}

function handleDrivingOnline(
  data: FsmData,
  state: Extract<FsmState, { name: "driving" }>,
  v: VehicleData,
  now: number,
): Decision {
  if (state.sub.kind === "unavailable") {
    return {
      effects: [{ type: "log", level: "info", message: "Vehicle is back online" }],
      next: { name: "driving", sub: { kind: "available" }, driveId: state.driveId },
      scheduleS: 0,
      redispatch: true,
      resetLastUsed: true,
    };
  }

  if (state.sub.kind === "offline") {
    return handleDriveBackOnline(data, state, v, now);
  }

  // sub.kind === "available"
  if (state.driveId === null) {
    return { effects: [], next: { name: "start" }, scheduleS: 0, redispatch: true };
  }

  if (isDriving(v)) {
    return {
      effects: [{ type: "insert_position", driveId: state.driveId, attrs: createPosition(v) }],
      next: state,
      scheduleS: INTERVALS.driving,
      resetLastUsed: true,
    };
  }

  if (isParked(v)) {
    return {
      effects: [
        { type: "insert_position", driveId: state.driveId, attrs: createPosition(v) },
        { type: "close_drive", driveId: state.driveId },
        { type: "log", level: "info", message: "Driving / Ended" },
      ],
      next: { name: "start" },
      scheduleS: 0,
      redispatch: true,
      resetLastUsed: true,
    };
  }

  return { effects: [], next: state, scheduleS: INTERVALS.driving };
}

/**
 * Came back online after a long offline stretch mid-drive. TeslaMate infers a
 * charge session from the range gained while unreachable.
 */
function handleDriveBackOnline(
  data: FsmData,
  state: Extract<FsmState, { name: "driving" }>,
  v: VehicleData,
  now: number,
): Decision {
  const last = data.lastResponse;
  const lastAt = last?.drive_state?.timestamp;
  const nowAt = v.drive_state?.timestamp ?? now;
  const offlineMin = typeof lastAt === "number" ? (nowAt - lastAt) / 60_000 : 0;

  const lastRange = last?.charge_state?.ideal_battery_range;
  const nowRange = v.charge_state?.ideal_battery_range;
  // Ranges are compared in the API's own unit (miles), as TeslaMate does.
  const gainedRange = typeof lastRange === "number" && typeof nowRange === "number" && nowRange - lastRange > 5;

  const effects: Effect[] = [
    { type: "log", level: "info", message: `Vehicle came back online after ${Math.round(offlineMin)} min` },
  ];

  if (gainedRange && offlineMin >= 5) {
    if (state.driveId !== null) effects.push({ type: "close_drive", driveId: state.driveId, seenAt: nowAt });
    if (last) {
      effects.push({
        type: "synthesize_charging_process",
        position: createPosition(last),
        charges: [createCharge(last), createCharge(v)],
      });
      effects.push({ type: "log", level: "info", message: "Vehicle was charged while offline" });
    }
    return { effects, next: { name: "start" }, scheduleS: 0, redispatch: true, resetLastUsed: true };
  }

  if (!gainedRange && offlineMin >= DRIVE_TIMEOUT_MIN) {
    if (state.driveId !== null) effects.push({ type: "close_drive", driveId: state.driveId, seenAt: nowAt });
    return { effects, next: { name: "start" }, scheduleS: 0, redispatch: true, resetLastUsed: true };
  }

  if (state.driveId !== null) {
    return {
      effects,
      next: { name: "driving", sub: { kind: "available" }, driveId: state.driveId },
      scheduleS: 0,
      redispatch: true,
      resetLastUsed: true,
    };
  }

  return { effects, next: { name: "start" }, scheduleS: 0, redispatch: true, resetLastUsed: true };
}

/**
 * The new `notDrivingAt` / `notChargingAt` after an event: the instant this
 * reading showed the car not driving (or not charging), else the previous value.
 * An asleep or offline probe counts for both. The Owner API reports a moving car
 * as online, and the rare car driven while unreachable is caught downstream: its
 * odometer moves further than the quiet span can explain (core/driveOrigin.ts).
 */
export function quietReadings(
  data: Pick<FsmData, "notDrivingAt" | "notChargingAt">,
  event: FsmEvent | null,
  now: number,
): { notDrivingAt: number | null; notChargingAt: number | null } {
  let notDrivingAt = data.notDrivingAt ?? null;
  let notChargingAt = data.notChargingAt ?? null;
  if (event?.type === "probe" && event.state !== "online") {
    notDrivingAt = now;
    notChargingAt = now;
  } else if (event?.type === "vehicle_data") {
    const at = snapshotDate(event.data);
    if (isParked(event.data)) notDrivingAt = at;
    if (!isCharging(event.data)) notChargingAt = at;
  }
  return { notDrivingAt, notChargingAt };
}

/** Replace PENDING_ID placeholders once the executor knows the real row id. */
export function resolvePendingId(state: FsmState, id: number): FsmState {
  switch (state.name) {
    case "driving":
      return state.driveId === PENDING_ID ? { ...state, driveId: id } : state;
    case "charging":
      return state.cprocId === PENDING_ID ? { ...state, cprocId: id } : state;
    case "updating":
      return state.updateId === PENDING_ID ? { ...state, updateId: id } : state;
    default:
      return state;
  }
}

/** Human-readable state name for the UI/summary. */
export function stateLabel(state: FsmState): string {
  switch (state.name) {
    case "driving":
      return "driving";
    case "charging":
      return "charging";
    case "updating":
      return "updating";
    case "suspended":
      return "falling_asleep";
    case "asleep":
      return "asleep";
    case "offline":
      return "offline";
    case "online":
      return "online";
    case "start":
      return "unknown";
  }
}
