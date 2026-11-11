import { decryptString, encryptString } from "../core/crypto";
import { VolvoClient, apiOf, type Endpoint, type VolvoApi } from "../core/volvo/api";
import type { VolvoErrorKind } from "../core/volvo/errors";
import { fingerprint, mergeView, normalize, type VolvoView } from "../core/volvo/normalize";
import {
  PACE_MS,
  SETTLE,
  dueEndpoints,
  freshBudget,
  nextDueAt,
  spend,
  take,
  type Budget,
  type Mode,
} from "../core/volvo/pace";
import { toVehicleData } from "../core/volvo/vehicleData";
import type { VehicleData } from "../core/tesla/payload";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";

/**
 * One polling pass for a Volvo car, run by its VehicleActor in place of the
 * Owner API fetch. It reads whichever endpoints are due, keeps every answer
 * raw in `volvo_snapshots`, folds the readings into the car's running view,
 * and hands back a `vehicle_data` payload for the same state machine a Tesla
 * goes through — plus when the next pass is due.
 */

export interface VolvoPollState {
  view: VolvoView;
  lastFetched: Partial<Record<Endpoint, number>>;
  /** The last stored answer per endpoint, so a repeat only moves `checked_at`. */
  stored: Partial<Record<Endpoint, { hash: string; id: number }>>;
  budget: Budget | null;
  /** An API whose quota ran out, and until when. Only that API waits. */
  quotaUntil: Partial<Record<VolvoApi, number>>;
  /** An endpoint refused for this car (no scope, not on this model): try again after. */
  missingUntil: Partial<Record<Endpoint, number>>;
  /** Rate limited, key refused, sign-in refused: the whole car waits. */
  pausedUntil: number | null;
  /** Nothing will ever be read: a market Volvo does not serve, or an unknown VIN. */
  stopped: { reason: "market" | "not_found"; at: number } | null;
  failure: { kind: VolvoErrorKind | "token"; endpoint: Endpoint | null; at: number } | null;
  mode: Mode;
  /** The charging session under way: energy integrated from the reported power. */
  session: { startedAt: number; energyKwh: number; powerKw: number | null; at: number; ended?: boolean } | null;
  readAt: number | null;
}

export type VolvoPassResult =
  | { kind: "event"; data: VehicleData; nextAt: number; transition: boolean }
  | { kind: "wait"; untilMs: number; error: string };

const STATE_KEY = "volvo";
const AUTH_CACHE_KEY = "volvoAuthCache";
const PAUSE_TOKEN_MS = 5 * 60_000;
const PAUSE_KEY_MS = 60 * 60_000;
const MISSING_MS = 24 * 60 * 60_000;
const STOPPED_RECHECK_MS = 6 * 60 * 60_000;
/** Power samples further apart than this are not joined into energy: the gap is unknown. */
const MAX_INTEGRATION_GAP_MS = 20 * 60_000;

export function initialPollState(): VolvoPollState {
  return {
    view: {},
    lastFetched: {},
    stored: {},
    budget: null,
    quotaUntil: {},
    missingUntil: {},
    pausedUntil: null,
    stopped: null,
    failure: null,
    mode: "parked",
    session: null,
    readAt: null,
  };
}

export function modeOf(view: VolvoView): Mode {
  if (view.engineRunning?.v === true) return "driving";
  if (view.charging?.v === "charging") return "charging";
  return "parked";
}

/** The words the car card shows for a failure kind; never the vendor's message, which carries the VIN. */
export const FAILURE_TEXT: Record<VolvoErrorKind | "token", string> = {
  quota: "Volvo's daily call quota is used up for part of the API",
  key_refused: "Volvo refused the API key (vcc-api-key) — check it in Settings",
  unauthorized: "Volvo no longer accepts the sign-in — reconnect in Settings",
  token: "Not connected to Volvo — connect in Settings",
  rate_limited: "Rate limited by Volvo",
  market: "Volvo's API does not serve this car's market",
  not_found: "Volvo does not know this car on the connected account",
  forbidden: "Volvo refused part of the API for this car",
  unavailable: "Volvo's API did not answer",
};

interface AuthCache {
  tokenEnc: string;
  apiKeyEnc: string;
  apiHost: string;
  expiresAt: number;
}

export class VolvoPoller {
  constructor(
    private readonly storage: ActorStorage,
    private readonly env: AppEnv,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async state(): Promise<VolvoPollState> {
    return { ...initialPollState(), ...((await this.storage.get<VolvoPollState>(STATE_KEY)) ?? {}) };
  }

  /**
   * The owner acted (a new consent, Find cars): forget what made the car stop
   * or pause, and every endpoint's refusal, so the next pass asks again.
   */
  async restart(): Promise<void> {
    const state = await this.state();
    state.stopped = null;
    state.pausedUntil = null;
    state.missingUntil = {};
    state.quotaUntil = {};
    state.failure = null;
    await this.storage.put(STATE_KEY, state);
    await this.forgetAccess();
  }

  async forgetAccess(): Promise<void> {
    await this.storage.delete(AUTH_CACHE_KEY);
  }

  private async access(force = false): Promise<{ token: string; apiKey: string; apiHost: string } | null> {
    const key = this.env.ENCRYPTION_KEY;
    const cached = force ? undefined : await this.storage.get<AuthCache>(AUTH_CACHE_KEY);
    if (cached && cached.expiresAt - Date.now() > 60_000) {
      try {
        return {
          token: await decryptString(key, cached.tokenEnc),
          apiKey: await decryptString(key, cached.apiKeyEnc),
          apiHost: cached.apiHost,
        };
      } catch {
        // The encryption key changed under the cache: ask again.
      }
    }
    const fresh = await this.env.actors.volvo().getAccessContext();
    if (!fresh) {
      await this.storage.delete(AUTH_CACHE_KEY);
      return null;
    }
    await this.storage.put(AUTH_CACHE_KEY, {
      tokenEnc: await encryptString(key, fresh.token),
      apiKeyEnc: await encryptString(key, fresh.apiKey),
      apiHost: fresh.apiHost,
      expiresAt: fresh.expiresAt,
    } satisfies AuthCache);
    return fresh;
  }

  async pass(carId: number, vin: string, volvoCars: number): Promise<VolvoPassResult> {
    const now = Date.now();
    const state = await this.state();
    const save = () => this.storage.put(STATE_KEY, state);

    if (state.stopped) {
      return { kind: "wait", untilMs: STOPPED_RECHECK_MS, error: FAILURE_TEXT[state.stopped.reason] };
    }
    if (state.pausedUntil !== null && state.pausedUntil > now) {
      return {
        kind: "wait",
        untilMs: state.pausedUntil - now,
        error: state.failure ? FAILURE_TEXT[state.failure.kind] : "Paused",
      };
    }

    let creds = await this.access();
    if (!creds) {
      state.failure = { kind: "token", endpoint: null, at: now };
      await save();
      return { kind: "wait", untilMs: PAUSE_TOKEN_MS, error: FAILURE_TEXT.token };
    }

    const client = new VolvoClient(creds.apiHost, this.fetchImpl);
    state.budget ??= freshBudget(volvoCars, now);
    const previousMode = state.mode;
    const blocked = new Set<Endpoint>();
    for (const [endpoint, until] of Object.entries(state.missingUntil) as [Endpoint, number][]) {
      if (until > now) blocked.add(endpoint);
    }
    const quotaBlocked = (endpoint: Endpoint) => (state.quotaUntil[apiOf(endpoint)] ?? 0) > now;

    const queue = dueEndpoints(state.lastFetched, state.mode, now, blocked);
    const done = new Set<Endpoint>();
    let refreshed = false;
    let readSomething = false;
    let notFound = 0;
    let transition = false;

    for (let i = 0; i < queue.length; i++) {
      const endpoint = queue[i]!;
      if (done.has(endpoint)) continue;
      done.add(endpoint);
      const api = apiOf(endpoint);
      if (quotaBlocked(endpoint)) continue;
      if (!take(state.budget, api, volvoCars, now)) continue; // late, not dropped

      const before = client.calls[api];
      let result = await client.get(endpoint, vin, creds);
      if (!result.ok && result.error.kind === "unauthorized" && !refreshed) {
        refreshed = true;
        await this.forgetAccess();
        const ok = await this.env.actors.volvo().forceRefresh();
        const renewed = ok ? await this.access(true) : null;
        if (!renewed) {
          spend(state.budget, api, client.calls[api] - before - 1);
          state.failure = { kind: "unauthorized", endpoint, at: now };
          state.pausedUntil = now + PAUSE_TOKEN_MS;
          await save();
          return { kind: "wait", untilMs: PAUSE_TOKEN_MS, error: FAILURE_TEXT.unauthorized };
        }
        creds = renewed;
        result = await client.get(endpoint, vin, creds);
      }
      spend(state.budget, api, client.calls[api] - before - 1);

      if (result.ok) {
        readSomething = true;
        state.lastFetched[endpoint] = now;
        await this.store(carId, state, endpoint, result.value, result.raw, now);
        state.view = mergeView(state.view, normalize(endpoint, result.value));
        if (endpoint === "details") await this.applyDetails(carId, state.view);
        // Once the mode-setting readings are in, a change of mode reads the
        // settling endpoints in this same pass and paces the rest by the new mode.
        if (endpoint === "engine-status" || endpoint === "energy-state") {
          const mode = modeOf(state.view);
          if (mode !== state.mode) {
            transition = true;
            state.mode = mode;
            for (const extra of [...SETTLE, ...dueEndpoints(state.lastFetched, mode, now, blocked)]) {
              if (!done.has(extra) && !queue.includes(extra)) queue.push(extra);
            }
          }
        }
        continue;
      }

      const error = result.error;
      state.failure = { kind: error.kind, endpoint, at: now };
      // Volvo's own words help diagnose a car; the VIN in them (from the URL) does not.
      console.warn(
        `[volvo] car ${carId} ${endpoint}: ${error.kind} (${error.status}) ${error.message.split(vin).join("…")}`,
      );
      if (error.kind === "quota") {
        state.quotaUntil[api] = now + (error.retryInMs ?? PACE_MS.rare);
        continue;
      }
      if (error.kind === "unavailable") continue;
      if (error.kind === "forbidden" || error.kind === "not_found") {
        // Not this model, or a scope the grant lacks (location:read can be under
        // review): leave the endpoint alone for a day instead of failing the pass.
        // A car Volvo does not know at all answers this everywhere; that is
        // decided after the pass, from whether anything could be read.
        state.missingUntil[endpoint] = now + MISSING_MS;
        if (error.kind === "not_found") notFound += 1;
        continue;
      }
      if (error.kind === "market") {
        state.stopped = { reason: error.kind, at: now };
        await save();
        return { kind: "wait", untilMs: STOPPED_RECHECK_MS, error: FAILURE_TEXT[error.kind] };
      }
      // The car as a whole waits: rate limit, refused key, refused sign-in.
      const wait =
        error.kind === "rate_limited"
          ? (error.retryInMs ?? 60_000)
          : error.kind === "key_refused"
            ? PAUSE_KEY_MS
            : PAUSE_TOKEN_MS;
      state.pausedUntil = now + wait;
      await save();
      return { kind: "wait", untilMs: wait, error: FAILURE_TEXT[error.kind] };
    }

    if (!readSomething && notFound > 0 && notFound === done.size && state.readAt === null) {
      // Every endpoint asked said "not found", and this car has never been read.
      state.stopped = { reason: "not_found", at: now };
      await save();
      return { kind: "wait", untilMs: STOPPED_RECHECK_MS, error: FAILURE_TEXT.not_found };
    }
    if (readSomething) {
      state.readAt = now;
      if (state.failure && state.failure.kind !== "quota") state.failure = null;
    }
    state.mode = modeOf(state.view);
    if (state.mode !== previousMode) transition = true;
    state.session = nextSession(state.session, state.view, now);
    await save();

    if (state.readAt === null) {
      // Nothing has ever been read: there is no snapshot to hand the state machine.
      const error = state.failure ? FAILURE_TEXT[state.failure.kind] : "Waiting for Volvo";
      return { kind: "wait", untilMs: PACE_MS.parked, error };
    }
    return {
      kind: "event",
      data: toVehicleData(state.view, { vin, at: now, sessionEnergyKwh: state.session?.energyKwh ?? null }),
      nextAt: nextDueAt(state.lastFetched, state.mode, now),
      transition,
    };
  }

  /** Keep the answer as it came; a repeat of the last one only moves its `checked_at`. */
  private async store(
    carId: number,
    state: VolvoPollState,
    endpoint: Endpoint,
    value: unknown,
    raw: string,
    now: number,
  ): Promise<void> {
    const hash = await fingerprint(value);
    const last = state.stored[endpoint];
    if (last && last.hash === hash) {
      const res = await this.env.DB.prepare("UPDATE volvo_snapshots SET checked_at = ? WHERE id = ?")
        .bind(now, last.id)
        .run();
      if (res.meta.changes > 0) return;
    }
    const row = await this.env.DB.prepare(
      "INSERT INTO volvo_snapshots (car_id, endpoint, fetched_at, checked_at, fingerprint, payload) " +
        "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(carId, endpoint, now, now, hash, raw)
      .first<{ id: number }>();
    if (row) state.stored[endpoint] = { hash, id: row.id };
  }

  /** What the car is: model and year from `details`, never overwriting a name the owner set. */
  private async applyDetails(carId: number, view: VolvoView): Promise<void> {
    const d = view.details;
    if (!d) return;
    await this.env.DB.prepare(
      "UPDATE cars SET model = COALESCE(?, model), marketing_name = COALESCE(?, marketing_name), " +
        "exterior_color = COALESCE(?, exterior_color), name = COALESCE(name, ?), updated_at = ? WHERE id = ?",
    )
      .bind(
        d.model,
        d.model && d.modelYear ? `${d.model} (${d.modelYear})` : d.model,
        d.colour,
        d.model ? `Volvo ${d.model}` : null,
        Date.now(),
        carId,
      )
      .run();
  }
}

/**
 * Energy into the battery this session, kWh: the reported charging power
 * integrated over the poll times (trapezoids). Volvo reports no energy figure of
 * its own, and the state of charge times a guessed capacity would make the
 * Health page's capacity estimate measure its own assumption. A gap longer
 * than `MAX_INTEGRATION_GAP_MS` adds nothing rather than a guess.
 */
export function nextSession(
  session: VolvoPollState["session"],
  view: VolvoView,
  now: number,
): VolvoPollState["session"] {
  const charging = view.charging?.v === "charging";
  const power = charging ? (view.powerKw?.v ?? null) : 0;
  if (!charging && (!session || session.ended)) return null;
  if (!session) return { startedAt: now, energyKwh: 0, powerKw: power, at: now };
  const dt = now - session.at;
  let energy = session.energyKwh;
  if (dt > 0 && dt <= MAX_INTEGRATION_GAP_MS && power !== null && session.powerKw !== null) {
    energy += ((session.powerKw + power) / 2) * (dt / 3_600_000);
  }
  // The pass that sees the session over adds its last stretch and is the
  // session's closing sample; the one after that has no session at all.
  return {
    startedAt: session.startedAt,
    energyKwh: Math.round(energy * 1000) / 1000,
    powerKw: power,
    at: now,
    ...(charging ? {} : { ended: true }),
  };
}
