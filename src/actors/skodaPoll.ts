import { decryptString } from "../core/crypto";
import { SkodaClient, type RateInfo } from "../core/skoda/api";
import { isKeyRefusal, type SkodaErrorKind } from "../core/skoda/errors";
import {
  fingerprint,
  isCharging,
  mergeView,
  normalize,
  type Section,
  type SectionState,
  type SkodaView,
} from "../core/skoda/normalize";
import { SETTLE_READS, nextDelayMs, prune, budgetWaitMs, type Mode } from "../core/skoda/pace";
import { MOTION_STALE_MS, toVehicleData } from "../core/skoda/vehicleData";
import type { VehicleData } from "../core/tesla/payload";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";

/**
 * One polling pass for a Škoda, run by its VehicleActor in place of the Owner
 * API fetch: one read of the MySkoda Public API, kept raw in `skoda_snapshots`,
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
  failure: { kind: SkodaErrorKind | "no_key" | "wrong_car"; at: number } | null;
  /** The last stored answer, so a repeat only moves its `checked_at`. */
  stored: { hash: string; id: number } | null;
  /** The charging session under way: energy integrated from the reported power. */
  session: { startedAt: number; energyKwh: number; powerKw: number | null; at: number; ended?: boolean } | null;
  /** Where the car last stood, for the start of the drive that moves it. */
  lastParked: { lat: number; lon: number } | null;
  readAt: number | null;
}

export type SkodaPassResult =
  | { kind: "event"; data: VehicleData; nextAt: number; transition: boolean }
  | { kind: "wait"; untilMs: number; error: string };

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

/** The words the car card shows for a failure; never Škoda's message, which can carry the VIN. */
export const FAILURE_TEXT: Record<SkodaErrorKind | "no_key" | "wrong_car", string> = {
  key_expired: "Škoda no longer accepts the API key — create a new one in the MySkoda app and paste it in Settings",
  not_authorized: "Škoda's API key does not cover this car — check the key in Settings",
  not_found: "Škoda knows no car with this VIN on the key — check the key in Settings",
  bad_request: "Škoda refused EVBook's request — this is a bug in EVBook",
  rate_limited: "Škoda's hourly request quota is used up",
  vehicle_refused: "The car is not accepting requests right now (often a low 12 V battery)",
  unavailable: "Škoda's API did not answer",
  no_key: "No Škoda API key — add one in Settings",
  wrong_car: "Škoda answered for a different car than this key was saved for — check the key in Settings",
};

/** What `refused_reason` in `skoda_keys` holds, for the refusals that stop a car. */
export type RefusedReason = "expired" | "not_authorized" | "not_found" | "wrong_car";

const REFUSED_OF: Partial<Record<SkodaErrorKind | "wrong_car", RefusedReason>> = {
  key_expired: "expired",
  not_authorized: "not_authorized",
  not_found: "not_found",
  wrong_car: "wrong_car",
};

const TEXT_OF_REFUSED: Record<RefusedReason, string> = {
  expired: FAILURE_TEXT.key_expired,
  not_authorized: FAILURE_TEXT.not_authorized,
  not_found: FAILURE_TEXT.not_found,
  wrong_car: FAILURE_TEXT.wrong_car,
};

interface KeyRow {
  key_enc: string;
  vin: string;
  expires_at: number | null;
  refused_at: number | null;
  refused_reason: RefusedReason | null;
}

export class SkodaPoller {
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

  async pass(carId: number, vin: string, account: string): Promise<SkodaPassResult> {
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
        error: TEXT_OF_REFUSED[key.refused_reason ?? "expired"] ?? FAILURE_TEXT.key_expired,
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
      await this.refuse(account, "expired", now);
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
        await this.refuse(account, REFUSED_OF[error.kind]!, now);
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
    state.session = nextSession(state.session, state.view, now);
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

  private async refuse(account: string, reason: RefusedReason, now: number): Promise<void> {
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
    const hash = await fingerprint(value);
    const last = state.stored;
    if (last && last.hash === hash) {
      const res = await this.env.DB.prepare("UPDATE skoda_snapshots SET checked_at = ? WHERE id = ?")
        .bind(now, last.id)
        .run();
      if (res.meta.changes > 0) return;
    }
    const row = await this.env.DB.prepare(
      "INSERT INTO skoda_snapshots (car_id, fetched_at, checked_at, fingerprint, payload) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(carId, now, now, hash, raw)
      .first<{ id: number }>();
    if (row) state.stored = { hash, id: row.id };
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

/**
 * Energy into the battery this session, kWh: the reported charging power
 * integrated over the read times (trapezoids), as for a Volvo. A gap longer
 * than `MAX_INTEGRATION_GAP_MS` adds nothing rather than a guess, and charging
 * whose power Škoda does not report adds nothing either: unknown, not 0 kW.
 */
export function nextSession(
  session: SkodaPollState["session"],
  view: SkodaView,
  now: number,
): SkodaPollState["session"] {
  const charging = isCharging(view);
  const power = charging ? (view.powerKw?.v ?? null) : 0;
  if (!charging && (!session || session.ended)) return null;
  if (!session || session.ended) return { startedAt: now, energyKwh: 0, powerKw: power, at: now };
  const dt = now - session.at;
  let energy = session.energyKwh;
  if (dt > 0 && dt <= MAX_INTEGRATION_GAP_MS && power !== null && session.powerKw !== null) {
    energy += ((session.powerKw + power) / 2) * (dt / 3_600_000);
  }
  return {
    startedAt: session.startedAt,
    energyKwh: Math.round(energy * 1000) / 1000,
    powerKw: power,
    at: now,
    ...(charging ? {} : { ended: true }),
  };
}
