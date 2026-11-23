import type { CarSummaryDto } from "@shared/api-types";
import { decryptString, encryptString } from "../core/crypto";
import { INTERVALS, fetchPlan, type FsmData, type FsmState } from "../core/fsm";
import { OwnerApi, type TeslaError } from "../core/tesla/ownerapi";
import { parseVehicleData } from "../core/tesla/payload";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import type { CarCommand, CommandResult, PassResult, PolledCar, ProviderPoller } from "./providerPoll";

/**
 * One polling pass for a Tesla, through the Owner API (the `ProviderPoller`
 * seam, providerPoll.ts). Unlike the other providers a Tesla sleeps, and
 * reading it in full keeps it awake, so what a pass asks for depends on the
 * state machine (`fetchPlan`): a sleeping car gets only the probe that never
 * wakes it, and a car seen online once is probed again (the fake-wake guard,
 * `INTERVALS.wakeConfirm`) before it is asked for data. Between those reads
 * the state machine's own cadence paces the passes, down to 2.5 s while
 * driving, which is why this is the one poller that may arm an alarm.
 *
 * Errors back off as TeslaMate's do, per state, behind two circuit breakers
 * (its `:fuse` configuration). The access token is cached here, encrypted,
 * so a poll does not wake the account's AuthActor.
 *
 * Wake and send-destination are the two commands the Owner API accepts
 * without Tesla's signed command protocol, and the only ones EVBook sends.
 */

/**
 * How long a fetched access token is reused before asking AuthDO again. Long
 * enough that polling no longer keeps a second object resident around the
 * clock; short enough that a sign-out stops the polling within the quarter
 * hour rather than whenever the token expires.
 */
const AUTH_CACHE_MS = 15 * 60_000;
/** Never reuse a cached token this close to its expiry. */
const AUTH_EXPIRY_MARGIN_MS = 5 * 60_000;

interface AuthCache {
  /** The Tesla account the token belongs to; absent on caches from before there were several. */
  account?: string;
  tokenEnc: string;
  apiHost: string;
  expiresAt: number;
  fetchedAt: number;
}

/** Circuit-breaker thresholds, ported from TeslaMate's :fuse configuration. */
const API_ERROR_LIMIT = 3;
const API_ERROR_WINDOW_MS = 10 * 60_000;
const API_ERROR_PAUSE_MS = 5 * 60_000;
const NOT_FOUND_LIMIT = 8;
const NOT_FOUND_WINDOW_MS = 20 * 60_000;
/** How long the not-found breaker pauses a car, matching the old cron re-arm. */
const NOT_FOUND_PAUSE_MS = 10 * 60_000;

interface Breaker {
  count: number;
  windowStartedAt: number;
}

type Read = { kind: "data"; data: unknown } | { kind: "probe"; state: "online" | "asleep" | "offline" };
type Fetched = { ok: true; read: Read } | { ok: false; error: TeslaError };

export class TeslaPoller implements ProviderPoller {
  /** A drive is read every 2.5 s, on an alarm. */
  readonly minDelayMs = 0;

  constructor(
    private readonly storage: ActorStorage,
    private readonly env: AppEnv,
  ) {}

  async pass(car: PolledCar, fsm: FsmData): Promise<PassResult> {
    const auth = await this.accessContext(car.account);
    if (!auth) return { kind: "wait", untilMs: 5 * 60_000, error: "Not signed in to Tesla" };
    if (!car.eid) return { kind: "wait", untilMs: 10 * 60_000, error: "Car has no Tesla id" };

    const fetched = await this.fetchForPlan(new OwnerApi(auth.apiHost), auth.token, car.eid, fsm);
    if (!fetched.ok) return this.onError(fsm.state, fetched.error, car.account);

    if (fetched.read.kind === "probe") {
      await this.resetBreaker("apiError");
      return { kind: "probe", state: fetched.read.state };
    }
    const parsed = parseVehicleData(fetched.read.data);
    if (!parsed) return this.onError(fsm.state, { kind: "unknown", message: "unparseable vehicle_data" }, car.account);
    await this.resetBreaker("apiError");
    return { kind: "event", data: parsed };
  }

  /** The owner just signed in again: forget the old token and why the car was paused. */
  async restart(): Promise<void> {
    await this.storage.delete("authCache");
    await this.resetBreaker("apiError");
    await this.resetBreaker("notFound");
  }

  /** The summary is built from Tesla's own payload: nothing to add. */
  async summarize(_summary: CarSummaryDto): Promise<void> {}

  async send(car: PolledCar, command: CarCommand): Promise<CommandResult> {
    const auth = await this.accessContext(car.account);
    if (!auth) return { ok: false, reason: "Not signed in to Tesla" };
    if (!car.eid) return { ok: false, reason: "Car has no Tesla id" };
    const api = new OwnerApi(auth.apiHost);

    if (command.kind === "wake") {
      const result = await api.wakeUp(auth.token, car.eid);
      if (result.ok) return { ok: true };
      if (result.error.kind === "unauthorized") await this.storage.delete("authCache");
      return { ok: false, reason: commandErrorReason(result.error) };
    }

    const result = await api.navigationRequest(auth.token, car.eid, command.destination);
    if (!result.ok) {
      if (result.error.kind === "unauthorized") await this.storage.delete("authCache");
      if (result.error.kind === "vehicle_unavailable") {
        // Deliberately not woken for this: sending an address is not consent
        // to a 15-minute wake. The user has a Wake button next to this one.
        return { ok: false, reason: "Car is asleep — wake it first" };
      }
      return { ok: false, reason: commandErrorReason(result.error) };
    }
    if (result.value.result === false) {
      return { ok: false, reason: result.value.reason || "Car refused the destination" };
    }
    return { ok: true };
  }

  /**
   * The access token and Owner API host, cached in this object's own storage
   * so a poll does not wake AuthDO. Every tick used to make two AuthDO calls,
   * which kept a second object resident around the clock for an answer that
   * changes a few times a day. The cache is refreshed after AUTH_CACHE_MS or
   * near the token's expiry, and dropped on a 401 (onError) so a token revoked
   * early costs one wasted poll, not fifteen minutes of them. Encrypted at
   * rest, as AuthDO's own copy is.
   */
  private async accessContext(account: string): Promise<{ token: string; apiHost: string } | null> {
    const now = Date.now();
    const cached = await this.storage.get<AuthCache>("authCache");
    if (
      cached &&
      (cached.account ?? "default") === account &&
      now - cached.fetchedAt < AUTH_CACHE_MS &&
      cached.expiresAt - now > AUTH_EXPIRY_MARGIN_MS
    ) {
      try {
        const token = await decryptString(this.env.ENCRYPTION_KEY, cached.tokenEnc);
        return { token, apiHost: cached.apiHost };
      } catch {
        // The encryption key changed under the cache; fall through and refetch.
      }
    }

    const fresh = await this.env.actors.auth(account).getAccessContext();
    if (!fresh) {
      await this.storage.delete("authCache");
      return null;
    }
    await this.storage.put("authCache", {
      account,
      tokenEnc: await encryptString(this.env.ENCRYPTION_KEY, fresh.token),
      apiHost: fresh.apiHost,
      expiresAt: fresh.expiresAt,
      fetchedAt: now,
    } satisfies AuthCache);
    return { token: fresh.token, apiHost: fresh.apiHost };
  }

  private async fetchForPlan(api: OwnerApi, token: string, eid: number, fsm: FsmData): Promise<Fetched> {
    const plan = fetchPlan(fsm);

    if (plan === "data_with_fallback") {
      const result = await api.getVehicleData(token, eid);
      if (result.ok) return { ok: true, read: { kind: "data", data: result.value } };
      // 408 means the car is actually asleep — fall back to the cheap probe.
      if (result.error.kind !== "vehicle_unavailable") return { ok: false, error: result.error };
      return this.probe(api, token, eid);
    }

    const probed = await this.probe(api, token, eid);
    if (!probed.ok || probed.read.kind !== "probe" || probed.read.state !== "online") return probed;

    if (plan === "probe_only") return probed; // fake-wake guard: do not spend a wake yet

    const result = await api.getVehicleData(token, eid);
    if (result.ok) return { ok: true, read: { kind: "data", data: result.value } };
    if (result.error.kind === "vehicle_unavailable") return { ok: true, read: { kind: "probe", state: "asleep" } };
    return { ok: false, error: result.error };
  }

  private async probe(api: OwnerApi, token: string, eid: number): Promise<Fetched> {
    const result = await api.probeState(token, eid);
    if (!result.ok) return { ok: false, error: result.error };
    const state = result.value.state;
    const normalized = state === "online" ? "online" : state === "asleep" ? "asleep" : "offline";
    return { ok: true, read: { kind: "probe", state: normalized } };
  }

  private async onError(state: FsmState, error: TeslaError, account: string): Promise<PassResult> {
    switch (error.kind) {
      case "unauthorized": {
        await this.storage.delete("authCache");
        const refreshed = await this.env.actors.auth(account).forceRefresh();
        return refreshed
          ? { kind: "wait", untilMs: 5_000, error: "Token refreshed, retrying" }
          : { kind: "wait", untilMs: 5 * 60_000, error: "Tesla tokens are invalid" };
      }
      case "too_many_requests":
      case "account_rate_limited":
        return {
          kind: "wait",
          untilMs: error.retryAfterS * 1000,
          error: `Rate limited by Tesla, retrying in ${error.retryAfterS}s`,
        };
      case "vehicle_not_found": {
        const tripped = await this.bumpBreaker("notFound", NOT_FOUND_LIMIT, NOT_FOUND_WINDOW_MS);
        // Back right off rather than stop: the cron used to undo a bare
        // deleteAlarm within ten minutes anyway, so say that outright.
        return {
          kind: "wait",
          untilMs: tripped ? NOT_FOUND_PAUSE_MS : INTERVALS.asleep * 1000,
          error: "Vehicle not found on this Tesla account",
        };
      }
      case "vehicle_in_service":
        return { kind: "wait", untilMs: INTERVALS.online * 1000, error: "Vehicle is in service" };
      case "vehicle_unavailable":
        return { kind: "wait", untilMs: INTERVALS.asleep * 1000 };
      case "timeout":
        return { kind: "wait", untilMs: errorInterval(state) * 1000 };
      default: {
        const tripped = await this.bumpBreaker("apiError", API_ERROR_LIMIT, API_ERROR_WINDOW_MS);
        return {
          kind: "wait",
          untilMs: tripped ? API_ERROR_PAUSE_MS : errorInterval(state) * 1000,
          error: `Tesla API error: ${error.message}`,
        };
      }
    }
  }

  private async bumpBreaker(name: string, limit: number, windowMs: number): Promise<boolean> {
    const key = `breaker:${name}`;
    const current = (await this.storage.get<Breaker>(key)) ?? { count: 0, windowStartedAt: Date.now() };
    const now = Date.now();
    const breaker: Breaker =
      now - current.windowStartedAt > windowMs
        ? { count: 1, windowStartedAt: now }
        : { count: current.count + 1, windowStartedAt: current.windowStartedAt };
    await this.storage.put(key, breaker);
    if (breaker.count >= limit) {
      await this.storage.delete(key);
      return true;
    }
    return false;
  }

  private async resetBreaker(name: string): Promise<void> {
    await this.storage.delete(`breaker:${name}`);
  }
}

/** Post-error backoff, matching TeslaMate's per-state intervals. */
function errorInterval(state: FsmState): number {
  switch (state.name) {
    case "driving":
      return 10;
    case "charging":
      return 15;
    case "online":
      return 20;
    default:
      return INTERVALS.asleep;
  }
}

/** A command refusal in words the card can show, unlike the poller's lastError. */
function commandErrorReason(error: TeslaError): string {
  switch (error.kind) {
    case "unauthorized":
      return "Tesla tokens are invalid";
    case "vehicle_not_found":
      return "Vehicle not found on this Tesla account";
    case "vehicle_in_service":
      return "Vehicle is in service";
    case "vehicle_unavailable":
      return "Car is unreachable";
    case "too_many_requests":
    case "account_rate_limited":
      return "Rate limited by Tesla — try again later";
    case "timeout":
      return "Tesla did not answer in time";
    default:
      return `Tesla API error: ${error.message}`;
  }
}
