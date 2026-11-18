import { decryptString } from "../core/crypto";
import { nextSession, type ChargeSession } from "../core/provider/session";
import { SkodaClient, type RateInfo } from "../core/skoda/api";
import { FAILURE_TEXT, isKeyRefusal, refusedReasonOf, type SkodaFailure } from "../core/skoda/errors";
import {
  VOLATILE_KEYS,
  isCharging,
  mergeView,
  normalize,
  type Section,
  type SectionState,
  type SkodaView,
} from "../core/skoda/normalize";
import { SETTLE_READS, nextDelayMs, prune, budgetWaitMs, type Mode } from "../core/skoda/pace";
import { MOTION_STALE_MS, toVehicleData } from "../core/skoda/vehicleData";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import type { CarSummaryDto, SkodaRefusedReason } from "@shared/api-types";
import {
  storeSnapshot,
  type PassResult,
  type PolledCar,
  type ProviderPoller,
  type StoredSnapshot,
} from "./providerPoll";

/**
 * One polling pass for a Škoda, run by its VehicleActor in place of the Owner
 * API fetch (the `ProviderPoller` seam, providerPoll.ts): one read of the
 * MySkoda Public API, kept raw in `provider_snapshots`,
 * folded into the car's running view, and handed back as a `vehicle_data`
 * payload for the same state machine a Tesla goes through, with when the next
 * read is due.
 *
 * The key lives in `skoda_keys`, encrypted, one per car. When Škoda refuses it
 * (lapsed, not covering this car), the refusal is written there, the car stops
 * asking, and Settings asks the owner for a new key. Nothing retries a refused
 * key on its own: each try would cost the quota and change nothing.
 */

export interface SkodaPollState {
  view: SkodaView;
  sections: Partial<Record<Section, SectionState>>;
  /** Error types Škoda sent that this code does not know. */
  unknownErrors: string[];
  /** When each request went out, within the last hour: the local quota guard. */
  sent: number[];
  mode: Mode;
  /** Reads left at the active pace after a drive or a charge ended. */
  settleLeft: number;
  /** Rate limited, refused by the car, Škoda unavailable: wait until then. */
  pausedUntil: number | null;
  failure: { kind: SkodaFailure; at: number } | null;
  /** The last stored answer, so a repeat only moves its `checked_at`. */
  stored: StoredSnapshot | null;
  /** The charging session under way: energy integrated from the reported power. */
  session: ChargeSession | null;
  /** Where the car last stood, for the start of the drive that moves it. */
  lastParked: { lat: number; lon: number } | null;
  readAt: number | null;
}

/** The one read a Škoda has, as `provider_snapshots.endpoint` names it. */
const SNAPSHOT_ENDPOINT = "vehicle";
const STATE_KEY = "skoda";
const MIN = 60_000;
/** A refused key is not asked again until the owner pastes another: check back now and then for one. */
const KEY_RECHECK_MS = 60 * MIN;
const UNAVAILABLE_RETRY_MS = 10 * MIN;
/** Power samples further apart than this are not joined into energy: the gap is unknown. */
const MAX_INTEGRATION_GAP_MS = 15 * MIN;

export function initialPollState(): SkodaPollState {
  return {
    view: {},
    sections: {},
    unknownErrors: [],
    sent: [],
    mode: "parked",
    settleLeft: 0,
    pausedUntil: null,
    failure: null,
    stored: null,
    session: null,
    lastParked: null,
    readAt: null,
  };
}

export function modeOf(view: SkodaView, now: number): Mode {
  const motion = view.motion;
  if (motion?.v === "moving" && now - motion.seen <= MOTION_STALE_MS) return "driving";
  if (isCharging(view)) return "charging";
  return "parked";
}

interface KeyRow {
  key_enc: string;
  vin: string;
  expires_at: number | null;
  refused_at: number | null;
  refused_reason: string | null;
}

export class SkodaPoller implements ProviderPoller {
  constructor(
    private readonly storage: ActorStorage,
    private readonly env: AppEnv,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async state(): Promise<SkodaPollState> {
    return { ...initialPollState(), ...((await this.storage.get<SkodaPollState>(STATE_KEY)) ?? {}) };
  }

  /** The owner acted (a new key): forget why the car waited, so the next pass asks at once. */
  async restart(): Promise<void> {
    const state = await this.state();
    state.pausedUntil = null;
    state.failure = null;
    await this.storage.put(STATE_KEY, state);
  }

  async pass(car: PolledCar): Promise<PassResult> {
    const { id: carId, vin, account } = car;
    const now = Date.now();
    const state = await this.state();
    const save = () => this.storage.put(STATE_KEY, state);

    const key = await this.env.DB.prepare(
      "SELECT key_enc, vin, expires_at, refused_at, refused_reason FROM skoda_keys WHERE account = ?",
    )
      .bind(account)
      .first<KeyRow>();
    if (!key) {
      state.failure = { kind: "no_key", at: now };
      await save();
      return { kind: "wait", untilMs: KEY_RECHECK_MS, error: FAILURE_TEXT.no_key };
    }
    if (key.refused_at !== null) {
      return {
        kind: "wait",
        untilMs: KEY_RECHECK_MS,
        error: FAILURE_TEXT[refusedReasonOf(key.refused_reason) ?? "key_expired"],
      };
    }
    if (state.pausedUntil !== null && state.pausedUntil > now) {
      return {
        kind: "wait",
        untilMs: state.pausedUntil - now,
        error: state.failure ? FAILURE_TEXT[state.failure.kind] : "Paused",
      };
    }
    const guard = budgetWaitMs(state.sent, now);
    if (guard > 0) return { kind: "wait", untilMs: guard, error: FAILURE_TEXT.rate_limited };

    let apiKey: string;
    try {
      apiKey = await decryptString(this.env.ENCRYPTION_KEY, key.key_enc);
    } catch {
      // The encryption key changed: the stored key cannot be read, so it is as good as gone.
      await this.refuse(account, "key_expired", now);
      return { kind: "wait", untilMs: KEY_RECHECK_MS, error: FAILURE_TEXT.key_expired };
    }

    const client = new SkodaClient(undefined, this.fetchImpl);
    const result = await client.read(vin, apiKey);
    state.sent = [...prune(state.sent, now), now];
    await this.noteExpiry(account, key, result.rate);

    if (!result.ok) {
      const error = result.error;
      state.failure = { kind: error.kind, at: now };
      console.warn(`[skoda] car ${carId}: ${error.kind} (${error.status}) ${error.message.split(vin).join("…")}`);
      if (isKeyRefusal(error.kind)) {
        await this.refuse(account, error.kind, now);
        await save();
        return { kind: "wait", untilMs: KEY_RECHECK_MS, error: FAILURE_TEXT[error.kind] };
      }
      const wait = Math.max(error.retryInMs ?? UNAVAILABLE_RETRY_MS, serverWait(result.rate) ?? 0);
      state.pausedUntil = now + wait;
      await save();
      return { kind: "wait", untilMs: wait, error: FAILURE_TEXT[error.kind] };
    }

    const normalized = normalize(result.value, now);
    if (normalized.vin !== null && normalized.vin.toUpperCase() !== vin.toUpperCase()) {
      // Never let one car's key fill in another car's history.
      state.failure = { kind: "wrong_car", at: now };
      await this.refuse(account, "wrong_car", now);
      await save();
      return { kind: "wait", untilMs: KEY_RECHECK_MS, error: FAILURE_TEXT.wrong_car };
    }

    await this.store(carId, state, result.value, result.raw, now);
    state.view = mergeView(state.view, normalized.patch);
    state.sections = { ...state.sections, ...normalized.sections };
    state.unknownErrors = normalized.unknownErrors;
    if (normalized.unknownErrors.length > 0) {
      console.warn(`[skoda] car ${carId}: unknown section errors ${normalized.unknownErrors.join(", ")}`);
    }
    if (normalized.patch.name) await this.applyName(carId, normalized.patch.name.v);
    state.readAt = now;
    state.failure = null;
    state.pausedUntil = null;

    const previousMode = state.mode;
    const mode = modeOf(state.view, now);
    const transition = mode !== previousMode;
    const departedFrom = previousMode !== "driving" && mode === "driving" ? state.lastParked : null;
    if (state.view.position && state.view.motion?.v === "parked") state.lastParked = state.view.position.v;
    if (transition && previousMode !== "parked" && mode === "parked") state.settleLeft = SETTLE_READS;
    else if (mode === "parked" && state.settleLeft > 0 && !transition) state.settleLeft -= 1;
    else if (mode !== "parked") state.settleLeft = 0;
    state.mode = mode;
    state.session = nextSession(state.session, chargeSample(state.view), now, MAX_INTEGRATION_GAP_MS);
    await save();

    const delay = nextDelayMs({
      mode,
      settleLeft: state.settleLeft,
      sent: state.sent,
      now,
      serverWaitMs: serverWait(result.rate),
    });
    return {
      kind: "event",
      data: toVehicleData(state.view, {
        vin,
        at: now,
        sessionEnergyKwh: state.session?.energyKwh ?? null,
        departedFrom,
      }),
      nextAt: now + delay,
      transition,
    };
  }

  private async refuse(account: string, reason: SkodaRefusedReason, now: number): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE skoda_keys SET refused_at = ?, refused_reason = ?, updated_at = ? WHERE account = ?",
    )
      .bind(now, reason, now, account)
      .run();
  }

  /** Škoda says when the key lapses on every answer: keep what it last said. */
  private async noteExpiry(account: string, key: KeyRow, rate: RateInfo): Promise<void> {
    if (rate.keyExpiresAt === null || rate.keyExpiresAt === key.expires_at) return;
    await this.env.DB.prepare("UPDATE skoda_keys SET expires_at = ?, updated_at = ? WHERE account = ?")
      .bind(rate.keyExpiresAt, Date.now(), account)
      .run();
  }

  /** Keep the answer as it came; a repeat of the last one only moves its `checked_at`. */
  private async store(carId: number, state: SkodaPollState, value: unknown, raw: string, now: number): Promise<void> {
    state.stored = await storeSnapshot(this.env.DB, {
      carId,
      provider: "skoda",
      endpoint: SNAPSHOT_ENDPOINT,
      value,
      raw,
      now,
      volatile: VOLATILE_KEYS,
      last: state.stored,
    });
  }

  /** A failure that outlasts the pass that met it (a refused key, a pause) is said on the card. */
  async summarize(summary: CarSummaryDto): Promise<void> {
    const state = await this.state();
    if (summary.lastError === null && state.failure) summary.lastError = FAILURE_TEXT[state.failure.kind];
  }

  /**
   * The car's name as the MySkoda app shows it (the owner's, or the model's,
   * "Enyaq", when they gave none), never over one set in EVBook.
   */
  private async applyName(carId: number, name: string): Promise<void> {
    await this.env.DB.prepare("UPDATE cars SET name = COALESCE(name, ?), updated_at = ? WHERE id = ?")
      .bind(name.slice(0, 60), Date.now(), carId)
      .run();
  }
}

/** Škoda says no requests are left: how long until the window refills. */
function serverWait(rate: RateInfo): number | null {
  return rate.remaining === 0 && rate.resetInMs !== null ? rate.resetInMs : null;
}

/** What the charging session (core/provider/session.ts) is fed from a Škoda's view. */
export function chargeSample(view: SkodaView): { charging: boolean; powerKw: number | null } {
  return { charging: isCharging(view), powerKw: view.powerKw?.v ?? null };
}
