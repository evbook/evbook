import { PleosClient, type Endpoint } from "../core/pleos/api";
import { FAILURE_TEXT, type PleosFailure } from "../core/pleos/errors";
import {
  VOLATILE_KEYS,
  clockAhead,
  isCharging,
  isDriving,
  mergeView,
  normalize,
  type PleosView,
} from "../core/pleos/normalize";
import {
  budgetWaitMs,
  dueNow,
  hold,
  nextDelayMs,
  prune,
  schedule,
  settle,
  type Due,
  type Held,
  type Mode,
} from "../core/pleos/pace";
import { toVehicleData } from "../core/pleos/vehicleData";
import type { AppEnv } from "../platform/env";
import type { ActorStorage, PleosTokenAnswer } from "../platform/ports";
import { isPleosBrand, type CarSummaryDto, type PleosBrand } from "@shared/api-types";
import {
  CRON_PERIOD_MS,
  storeSnapshot,
  type PassResult,
  type PolledCar,
  type ProviderPoller,
  type StoredSnapshot,
} from "./providerPoll";

/**
 * One polling pass for a Hyundai, Kia or Genesis read through the Pleos
 * Vehicle Data API, run by its VehicleActor (the `ProviderPoller` seam,
 * providerPoll.ts): the reads that are due (core/pleos/pace.ts), each kept raw
 * in `provider_snapshots` under its endpoint, folded into the car's running
 * view, and handed back as a `vehicle_data` payload for the same state machine
 * a Tesla goes through, with when the next pass is due.
 *
 * The token comes from the key's token holder (pleosAuth.ts), shared by every
 * car on the key. A token refused mid-pass is handed back once for a new one
 * and the read retried; refused again, the car rests an hour. A key Pleos
 * refuses stops every car on it until the owner pastes a new one, and a car
 * Pleos says is no longer shared stops until then too. Nothing retries either
 * on a timer: each try would change nothing.
 */

export type ReadState = "available" | "no_data";

export interface PleosPollState {
  view: PleosView;
  /** When each read is next due. */
  due: Due;
  /** Reads Pleos had no data for, or refused as malformed: not asked again before then, whatever the mode. */
  held: Held;
  /** What each read last answered. */
  reads: Partial<Record<Endpoint, ReadState>>;
  /** When each request went out, within the last hour: the local guard. */
  sent: number[];
  mode: Mode;
  /** Rate limited, refused, Pleos down: wait until then. */
  pausedUntil: number | null;
  /** Pleos says the car is not shared through the key (5006, 4101): nothing is read until the owner acts. */
  unshared: boolean;
  failure: { kind: PleosFailure; at: number } | null;
  /** The last stored answer per read, so a repeat only moves its `checked_at`. */
  stored: Partial<Record<Endpoint, StoredSnapshot>>;
}

const STATE_KEY = "pleos";
const MIN = 60_000;
/** A refused key, or a car no longer shared, is not asked again until the owner acts: check back now and then. */
const RECHECK_MS = 60 * MIN;
/** Refused even with a fresh token. */
const FORBIDDEN_PAUSE_MS = 60 * MIN;
/** A read with no data (4045): ask again in a while, not faster. */
const NO_DATA_RETRY_MS = 30 * MIN;
/** A read EVBook built wrong (a bug): do not hammer it. */
const BAD_REQUEST_RETRY_MS = 60 * MIN;
const UNAVAILABLE_RETRY_MS = 10 * MIN;

export function initialPollState(): PleosPollState {
  return {
    view: {},
    due: {},
    held: {},
    reads: {},
    sent: [],
    mode: "parked",
    pausedUntil: null,
    unshared: false,
    failure: null,
    stored: {},
  };
}

export function modeOf(view: PleosView, now: number): Mode {
  if (isDriving(view, now)) return "driving";
  if (isCharging(view, now)) return "charging";
  return "parked";
}

/** A failed token answer as the pass reports it, and how long the car waits. */
export function tokenWait(answer: Exclude<PleosTokenAnswer, { ok: true }>): { kind: PleosFailure; waitMs: number } {
  switch (answer.kind) {
    case "no_key":
    case "key_refused":
      return { kind: answer.kind, waitMs: RECHECK_MS };
    case "key_shared":
      return { kind: "key_shared", waitMs: answer.retryInMs ?? 15 * MIN };
    case "rate_limited":
    case "unavailable":
      return { kind: answer.kind, waitMs: answer.retryInMs ?? UNAVAILABLE_RETRY_MS };
  }
}

interface KeyRow {
  brand: string;
  refused_at: number | null;
}

export class PleosPoller implements ProviderPoller {
  /** Read on the cron's clock only: never an alarm. */
  readonly minDelayMs = CRON_PERIOD_MS;

  constructor(
    private readonly storage: ActorStorage,
    private readonly env: AppEnv,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async state(): Promise<PleosPollState> {
    return { ...initialPollState(), ...((await this.storage.get<PleosPollState>(STATE_KEY)) ?? {}) };
  }

  /** The owner acted (a new key): forget why the car waited or stopped, and read everything at once. */
  async restart(): Promise<void> {
    const state = await this.state();
    state.pausedUntil = null;
    state.unshared = false;
    state.failure = null;
    state.due = {};
    state.held = {};
    await this.storage.put(STATE_KEY, state);
  }

  async pass(car: PolledCar): Promise<PassResult> {
    const { id: carId, vin, account } = car;
    const now = Date.now();
    const state = await this.state();
    const save = () => this.storage.put(STATE_KEY, state);
    const stop = async (kind: PleosFailure, waitMs: number): Promise<PassResult> => {
      state.failure = { kind, at: now };
      await save();
      return { kind: "wait", untilMs: waitMs, error: FAILURE_TEXT[kind] };
    };

    const key = await this.env.DB.prepare("SELECT brand, refused_at FROM pleos_keys WHERE account = ?")
      .bind(account)
      .first<KeyRow>();
    if (!key || !isPleosBrand(key.brand)) return stop("no_key", RECHECK_MS);
    if (key.refused_at !== null) return stop("key_refused", RECHECK_MS);
    if (state.unshared) return stop("not_shared", RECHECK_MS);
    if (state.pausedUntil !== null && state.pausedUntil > now) {
      return {
        kind: "wait",
        untilMs: state.pausedUntil - now,
        error: state.failure ? FAILURE_TEXT[state.failure.kind] : "Paused",
      };
    }

    let due = dueNow(state.due, now);
    if (due.length === 0) due = ["batteries"];
    const guard = budgetWaitMs(state.sent, now, due.length);
    // EVBook's own cap, not a word from Pleos: said as such.
    if (guard > 0) return { kind: "wait", untilMs: guard, error: FAILURE_TEXT.own_cap };

    const tokens = this.env.actors.pleos(account);
    const first = await tokens.token(account);
    if (!first.ok) {
      const { kind, waitMs } = tokenWait(first);
      if (kind === "rate_limited" || kind === "unavailable" || kind === "key_shared") state.pausedUntil = now + waitMs;
      return stop(kind, waitMs);
    }
    let token = first.token;
    let renewed = false;

    const client = new PleosClient(undefined, this.fetchImpl);
    const brand: PleosBrand = key.brand;
    const read: Endpoint[] = [];
    let halt: { kind: PleosFailure; waitMs: number } | null = null;
    /** A read EVBook built wrong: said on the card, but the other reads go on. */
    let buggy = false;
    /** The car's clock is ahead: its readings are kept, but none can open a drive or a charge. */
    let ahead = false;

    for (const endpoint of due) {
      let result = await client.read(brand, token, vin, endpoint);
      state.sent = [...prune(state.sent, now), now];
      if (!result.ok && result.error.kind === "token_refused" && !renewed) {
        // Another car's pass, or another program, may have replaced the token: ask for the current one, once.
        renewed = true;
        const again = await tokens.token(account, token);
        if (!again.ok) {
          halt = tokenWait(again);
          break;
        }
        token = again.token;
        result = await client.read(brand, token, vin, endpoint);
        state.sent = [...state.sent, now];
      }
      if (!result.ok) {
        const { kind, status, code, message, retryInMs } = result.error;
        console.warn(
          `[pleos] car ${carId} ${endpoint}: ${kind} (${status}${code ? ` / ${code}` : ""}) ${message.split(vin).join("…")}`,
        );
        if (kind === "no_data") {
          state.reads[endpoint] = "no_data";
          state.held[endpoint] = state.due[endpoint] = now + NO_DATA_RETRY_MS;
          continue;
        }
        if (kind === "bad_request") {
          state.held[endpoint] = state.due[endpoint] = now + BAD_REQUEST_RETRY_MS;
          buggy = true;
          continue;
        }
        if (kind === "not_shared") {
          state.unshared = true;
          halt = { kind, waitMs: RECHECK_MS };
        } else if (kind === "token_refused") {
          halt = { kind: "forbidden", waitMs: FORBIDDEN_PAUSE_MS };
        } else {
          halt = { kind, waitMs: retryInMs ?? UNAVAILABLE_RETRY_MS };
        }
        break;
      }
      const normalized = normalize(endpoint, result.value, now);
      if (normalized.unknown.length > 0) {
        console.warn(`[pleos] car ${carId} ${endpoint}: unknown values ${normalized.unknown.join(", ")}`);
      }
      if (normalized.sentAt !== null && clockAhead(normalized.sentAt, now)) {
        // Said once, when it starts, not on every pass of a summer.
        if (!ahead && state.failure?.kind !== "clock_ahead") {
          const minutes = Math.round((normalized.sentAt - now) / MIN);
          console.warn(`[pleos] car ${carId} ${endpoint}: the car's clock is ${minutes} min ahead`);
        }
        ahead = true;
      }
      state.stored[endpoint] =
        (await storeSnapshot(this.env.DB, {
          carId,
          provider: "pleos",
          endpoint,
          value: result.value,
          raw: result.raw,
          now,
          volatile: VOLATILE_KEYS,
          last: state.stored[endpoint],
        })) ?? undefined;
      state.view = mergeView(state.view, normalized.patch);
      state.reads[endpoint] = "available";
      delete state.held[endpoint];
      read.push(endpoint);
    }

    if (halt) {
      if (halt.kind !== "not_shared") state.pausedUntil = now + halt.waitMs;
      state.failure = { kind: halt.kind, at: now };
    }

    if (read.length === 0) {
      if (halt) {
        await save();
        return { kind: "wait", untilMs: halt.waitMs, error: FAILURE_TEXT[halt.kind] };
      }
      // Every read due answered "no data", or was one EVBook built wrong.
      const kind: PleosFailure = due.every((e) => state.reads[e] === "no_data") ? "no_data" : "bad_request";
      state.failure = { kind, at: now };
      await save();
      return { kind: "wait", untilMs: nextDelayMs(state.due, state.sent, now), error: FAILURE_TEXT[kind] };
    }

    if (!halt) {
      // A read with no data is not a failure while the others answer: Pleos does not have every value for every car.
      const kind: PleosFailure | null = buggy ? "bad_request" : ahead ? "clock_ahead" : null;
      state.failure = kind ? { kind, at: now } : null;
      state.pausedUntil = null;
    }
    const previousMode = state.mode;
    const mode = modeOf(state.view, now);
    const transition = mode !== previousMode;
    state.mode = mode;
    state.due = schedule(state.due, read, mode, now);
    if (transition) state.due = settle(state.due, now);
    state.due = hold(state.due, state.held, now);
    await save();

    const serverWait = state.pausedUntil !== null ? state.pausedUntil - now : null;
    return {
      kind: "event",
      data: toVehicleData(state.view, { vin, at: now }),
      nextAt: now + nextDelayMs(state.due, state.sent, now, serverWait),
      transition,
    };
  }

  /** A failure that outlasts the pass that met it (a refused key, a pause, no data) is said on the card. */
  async summarize(summary: CarSummaryDto): Promise<void> {
    const state = await this.state();
    if (summary.lastError === null && state.failure) summary.lastError = FAILURE_TEXT[state.failure.kind];
  }
}
