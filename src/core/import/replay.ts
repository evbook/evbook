import {
  DRIVE_TIMEOUT_MIN,
  PENDING_ID,
  handle,
  resolvePendingId,
  type CarSettingsLike,
  type Decision,
  type FsmData,
  type FsmEvent,
} from "../fsm";
import { createPosition, snapshotDate, type PositionAttrs, type VehicleData } from "../tesla/payload";
import type { Repo } from "../../db/repo";
import type { ImportProgress, ImportSnapshot } from "./types";

/**
 * Replays reconstructed snapshots through the live state machine.
 *
 * This is the whole point of the import design: instead of guessing at drive and
 * charge boundaries, an imported history is fed to `core/fsm.ts` exactly as the
 * Durable Object feeds it live polls, and the effects are written with the same
 * `Repo`. Drive segmentation, the close rule, energy and cost derivations and
 * efficiency all behave identically to data the logger recorded itself.
 *
 * Two things replace the parts of reality an export cannot carry:
 *
 * - **Time is data time.** `now` is the snapshot's own timestamp, so the sleep
 *   and drive-timeout rules measure the car's clock rather than the wall clock.
 * - **Gaps mean sleep.** An export only has rows while the vendor could reach
 *   the car, so a gap longer than `sleepGapMin` is replayed as the probe result
 *   the logger would have seen: the car became unreachable.
 *
 * The reducer's own polling schedule is honoured as well, because it is what
 * paces the writes: while suspended it asks to be called back in 21 minutes, and
 * feeding it a sample every ten seconds instead would store a position for each
 * one. A sample that changes something the reducer switches on — shift state,
 * charging state, a software update — is always dispatched, so no transition can
 * be thinned away.
 */

/** The subset of `Repo` the replay writes through. */
type ReplaySink = Pick<
  Repo,
  | "startState"
  | "updateCar"
  | "insertPositions"
  | "openDrive"
  | "closeDrive"
  | "openChargingProcess"
  | "insertCharges"
  | "completeChargingProcess"
  | "openUpdate"
  | "finishUpdate"
  | "cancelUpdate"
  | "synthesizeChargingProcess"
>;

interface ReplayOptions {
  settings: CarSettingsLike;
  /**
   * A data gap at least this long is replayed as the car going unreachable.
   * Below TeslaMate's 15 min drive timeout a gap cannot end a drive, so that is
   * the floor as well as the default.
   */
  sleepGapMin?: number;
  /** Which unreachable state a gap stands for. */
  gapState?: "asleep" | "offline";
  /** Positions per D1 write. */
  batchSize?: number;
  /** Location trail while online or charging, matching `VehicleDO`. */
  positionHeartbeatMin?: number;
  onProgress?: (progress: ImportProgress) => void;
  /** Snapshots between progress callbacks. */
  progressEvery?: number;
  signal?: AbortSignal;
  /** Continue a slice-by-slice import from where the last slice stopped. */
  resume?: ReplayState;
  /**
   * Checked after every snapshot; returning true ends the slice cleanly, with
   * writes flushed and the state safe to persist and resume from. This is how a
   * Worker import stays inside one invocation's budget.
   */
  stopAfter?: () => boolean;
}

/**
 * Everything needed to carry an import across invocations. Plain data, so a
 * Durable Object can store it between alarms — the reducer's own state already
 * survives that way for live logging.
 */
export interface ReplayState {
  fsm: FsmData;
  counters: ReplayCounters;
  /** When the reducer next wants to be called. */
  nextDueAt: number;
  /** When the location-trail heartbeat is next due. */
  nextHeartbeatAt: number;
}

export interface ReplayResult {
  /** False when `stopAfter` ended the slice before the snapshots ran out. */
  done: boolean;
  state: ReplayState;
}

export interface ReplayCounters {
  snapshots: number;
  positions: number;
  drives: number;
  drivesDiscarded: number;
  chargingProcesses: number;
  charges: number;
  states: number;
  distanceKm: number;
  energyAddedKwh: number;
  firstAt: number | null;
  lastAt: number | null;
}

const MAX_REDISPATCH = 5;

export async function replay(
  snapshots: AsyncIterable<ImportSnapshot>,
  sink: ReplaySink,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const settings = options.settings;
  const sleepGapMs = Math.max(options.sleepGapMin ?? DRIVE_TIMEOUT_MIN, DRIVE_TIMEOUT_MIN) * 60_000;
  const gapState = options.gapState ?? "asleep";
  const batchSize = options.batchSize ?? 200;
  const heartbeatMs = (options.positionHeartbeatMin ?? 5) * 60_000;
  const progressEvery = options.progressEvery ?? 5_000;

  const counters: ReplayCounters = options.resume
    ? { ...options.resume.counters }
    : {
        snapshots: 0,
        positions: 0,
        drives: 0,
        drivesDiscarded: 0,
        chargingProcesses: 0,
        charges: 0,
        states: 0,
        distanceKm: 0,
        energyAddedKwh: 0,
        firstAt: null,
        lastAt: null,
      };

  let data: FsmData | null = options.resume?.fsm ?? null;
  let buffer: { driveId: number | null; attrs: PositionAttrs }[] = [];
  let nextHeartbeatAt = options.resume?.nextHeartbeatAt ?? 0;
  /** When the reducer asked to be called again — see the note at the top. */
  let nextDueAt = options.resume?.nextDueAt ?? 0;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    await sink.insertPositions(rows);
    counters.positions += rows.length;
  }

  /** Runs one event to completion, following the reducer's redispatch chain. */
  async function dispatch(event: FsmEvent, now: number): Promise<void> {
    for (let i = 0; i < MAX_REDISPATCH; i++) {
      const current = data!;
      const decision = handle(current, event, settings, now);
      const openedId = await executeEffects(decision, current, now);

      let nextState = decision.next;
      if (openedId !== null) nextState = resolvePendingId(nextState, openedId);

      data = {
        state: nextState,
        lastUsedAt: decision.resetLastUsed ? now : current.lastUsedAt,
        lastStateChangeAt: decision.stateChanged ? now : current.lastStateChangeAt,
        lastResponse: event.type === "vehicle_data" ? event.data : current.lastResponse,
        onlineProbeStreak: event.type === "probe" ? (event.state === "online" ? current.onlineProbeStreak + 1 : 0) : 0,
      };

      if (!decision.redispatch) {
        nextDueAt = now + Math.max(0, decision.scheduleS) * 1000;
        return;
      }
    }
    await flush();
  }

  /** Does this sample carry something the reducer branches on? */
  function changesState(previous: VehicleData | null, next: VehicleData): boolean {
    return (
      previous === null ||
      previous.drive_state?.shift_state !== next.drive_state?.shift_state ||
      previous.charge_state?.charging_state !== next.charge_state?.charging_state ||
      previous.vehicle_state?.software_update?.status !== next.vehicle_state?.software_update?.status
    );
  }

  async function executeEffects(decision: Decision, current: FsmData, now: number): Promise<number | null> {
    let openedId: number | null = null;

    for (const effect of decision.effects) {
      if (effect.type === "insert_position") {
        const driveId = effect.driveId === PENDING_ID ? openedId : effect.driveId;
        buffer.push({ driveId, attrs: effect.attrs });
        if (buffer.length >= batchSize) await flush();
        continue;
      }

      // Anything else must see a consistent set of rows.
      await flush();

      switch (effect.type) {
        case "start_state":
          await sink.startState(effect.state, effect.at);
          counters.states++;
          break;
        case "update_car":
          await sink.updateCar(effect.attrs);
          break;
        case "open_drive":
          openedId = await sink.openDrive(effect.at);
          break;
        case "close_drive": {
          const closed = await sink.closeDrive(effect.driveId);
          if (closed.deleted) counters.drivesDiscarded++;
          else {
            counters.drives++;
            counters.distanceKm += closed.distance ?? 0;
          }
          break;
        }
        case "open_charging_process":
          openedId = await sink.openChargingProcess(effect.at, effect.position);
          counters.chargingProcesses++;
          counters.positions++; // the session's own position row
          break;
        case "insert_charge": {
          const cprocId = effect.cprocId === PENDING_ID ? openedId : effect.cprocId;
          if (cprocId !== null) {
            await sink.insertCharges(cprocId, [effect.attrs]);
            counters.charges++;
          }
          break;
        }
        case "complete_charging_process": {
          const completed = await sink.completeChargingProcess(effect.cprocId);
          counters.energyAddedKwh += completed.energyAdded ?? 0;
          break;
        }
        case "open_update":
          openedId = await sink.openUpdate(effect.at);
          break;
        case "finish_update":
          await sink.finishUpdate(effect.updateId, effect.version, effect.at);
          break;
        case "cancel_update":
          await sink.cancelUpdate(effect.updateId);
          break;
        case "synthesize_charging_process":
          await sink.synthesizeChargingProcess(
            effect.position,
            effect.charges,
            current.lastResponse ? snapshotDate(current.lastResponse) : now,
          );
          counters.chargingProcesses++;
          counters.charges += effect.charges.length;
          counters.positions++;
          break;
        case "log":
          break; // the report replaces the live log
      }
    }

    return openedId;
  }

  /**
   * Replays "the vendor could not reach the car".
   *
   * The live loop probes over and over, and it takes two probes to record a
   * sleep: the first drops whatever state the car was in back to `start` (ending
   * an open drive or charge session), and only the second opens the `asleep`
   * state row. One probe per gap would lose the sleep timeline entirely.
   */
  async function dispatchUnreachable(now: number): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const before = data!.state.name;
      if (before === gapState) return;
      await dispatch({ type: "probe", state: gapState }, now);
      if (data!.state.name === before) return;
    }
  }

  /** `VehicleDO` keeps a location trail while online or charging; so do we. */
  function maybeHeartbeat(payload: VehicleData, at: number): void {
    const state = data!.state.name;
    if (state !== "online" && state !== "charging") {
      nextHeartbeatAt = 0;
      return;
    }
    if (nextHeartbeatAt === 0) {
      nextHeartbeatAt = at + heartbeatMs;
      return;
    }
    if (at < nextHeartbeatAt) return;
    buffer.push({ driveId: null, attrs: createPosition(payload) });
    nextHeartbeatAt = at + heartbeatMs;
  }

  for await (const snapshot of snapshots) {
    options.signal?.throwIfAborted();

    if (data === null) {
      data = {
        state: { name: "start" },
        lastUsedAt: snapshot.at,
        lastStateChangeAt: snapshot.at,
        lastResponse: null,
        onlineProbeStreak: 0,
      };
      counters.firstAt ??= snapshot.at;
    } else if (counters.lastAt !== null && snapshot.at - counters.lastAt >= sleepGapMs) {
      // The vendor lost the car here — the car went to sleep or dropped off the
      // network. Either way an open drive or charge session ends.
      await dispatchUnreachable(counters.lastAt + 1_000);
    }

    if (snapshot.at >= nextDueAt || changesState(data.lastResponse, snapshot.data)) {
      await dispatch({ type: "vehicle_data", data: snapshot.data }, snapshot.at);
      maybeHeartbeat(snapshot.data, snapshot.at);
    }

    counters.snapshots++;
    counters.lastAt = snapshot.at;
    if (options.onProgress && counters.snapshots % progressEvery === 0) {
      options.onProgress(progressOf(counters));
    }

    if (options.stopAfter?.()) {
      // Out of budget. Flushing here is what makes the state resumable: the
      // next slice starts from `counters.lastAt` with nothing in flight.
      await flush();
      options.onProgress?.(progressOf(counters));
      return { done: false, state: snapshotState() };
    }
  }

  if (data !== null && counters.lastAt !== null) {
    // Close whatever the export ended in the middle of.
    await dispatchUnreachable(counters.lastAt + 1_000);
  }
  await flush();
  options.onProgress?.(progressOf(counters));

  counters.distanceKm = round(counters.distanceKm, 2);
  counters.energyAddedKwh = round(counters.energyAddedKwh, 2);
  return { done: true, state: snapshotState() };

  function snapshotState(): ReplayState {
    return {
      // A slice that saw no snapshots at all has no reducer state yet.
      fsm: data ?? {
        state: { name: "start" },
        lastUsedAt: 0,
        lastStateChangeAt: 0,
        lastResponse: null,
        onlineProbeStreak: 0,
      },
      counters,
      nextDueAt,
      nextHeartbeatAt,
    };
  }
}

function progressOf(counters: ReplayCounters): ImportProgress {
  return {
    snapshots: counters.snapshots,
    positions: counters.positions,
    drives: counters.drives,
    chargingProcesses: counters.chargingProcesses,
    charges: counters.charges,
    at: counters.lastAt ?? 0,
  };
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
