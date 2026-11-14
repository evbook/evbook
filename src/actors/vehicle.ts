import {
  BLOCKER_MESSAGES,
  INTERVALS,
  PENDING_ID,
  canFallAsleep,
  fetchPlan,
  handle,
  quietReadings,
  resolvePendingId,
  stateLabel,
  type CarSettingsLike,
  type Decision,
  type FsmData,
  type FsmEvent,
  type FsmState,
} from "../core/fsm";
import { decryptString, encryptString } from "../core/crypto";
import { OwnerApi, type TeslaError } from "../core/tesla/ownerapi";
import {
  createPosition,
  createTyreReading,
  parseVehicleData,
  tyreReadingOf,
  snapshotDate,
  type PositionAttrs,
  type VehicleData,
} from "../core/tesla/payload";
import { Repo } from "../db/repo";
import { FAILURE_TEXT, VolvoPoller } from "./volvoPoll";
import { maintenanceOf } from "../core/volvo/vehicleData";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import type { CarSummaryDto } from "@shared/api-types";
import { tyreStates } from "@shared/tyres";

const BUFFER_MAX_ROWS = 25;
const BUFFER_MAX_AGE_MS = 30_000;
const POSITION_HEARTBEAT_MS = 5 * 60_000;
/**
 * The longest a run of unchanged tyre readings goes without a row. A pressure
 * moves with the weather and the miles, not by the minute, so a quarter hour
 * keeps the history honest at a few thousand rows a year. A change of warning
 * or recommended pressure is written at once, whatever the clock says.
 */
const TYRE_READING_INTERVAL_MS = 15 * 60_000;

interface TyreMark {
  at: number;
  /** The warnings and recommended pressures last written, as one comparable key. */
  flags: string;
}
const MAX_REDISPATCH = 5;
const VOLVO_NO_COMMANDS = "EVBook only reads a Volvo; it sends it no commands";

/**
 * The cron's period, and with it the line between the two clocks this object
 * can poll on. An armed alarm keeps the object resident for the whole gap, and
 * residency is what Durable Objects bill — so a cadence that reaches the cron's
 * period is handed to the cron instead (see `schedule`).
 */
const CRON_PERIOD_MS = 60_000;
/**
 * How far past an armed alarm the cron's deadline sits. Long enough that the
 * cron never races a healthy alarm loop, short enough that a lost alarm is
 * picked up in a minute or two rather than going unnoticed.
 */
const WATCHDOG_GRACE_MS = 60_000;
/**
 * Smallest move worth a write while an alarm owns the loop. Without it a 2.5 s
 * drive loop would write the deadline to D1 on every tick — the write the
 * position buffer exists to avoid.
 */
const NEXT_DUE_WRITE_SLACK_MS = 30_000;
/** How long the not-found breaker pauses a car, matching the old cron re-arm. */
const NOT_FOUND_PAUSE_MS = 10 * 60_000;

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

/** What the poller needs to know about its car, read once per tick. */
interface CarRow {
  eid: number | null;
  vin: string;
  provider: string;
  account: string;
  /** How many Volvo cars share the instance's Volvo key — and with it the quota. */
  volvo_cars: number;
}

interface BufferedPosition {
  driveId: number | null;
  attrs: PositionAttrs;
}

interface Breaker {
  count: number;
  windowStartedAt: number;
}

/**
 * A fresh state machine treats "now" as the last activity, matching TeslaMate's
 * `last_used: DateTime.utc_now()` at init. Starting at 0 would make the car look
 * infinitely idle and suspend logging on the very first poll.
 */
function initialFsm(now: number): FsmData {
  return {
    state: { name: "start" },
    lastUsedAt: now,
    lastStateChangeAt: now,
    lastResponse: null,
    onlineProbeStreak: 0,
  };
}

/**
 * One instance per car — the runtime for EVBook's port of TeslaMate's
 * per-car GenStateMachine. The pure reducer lives in core/fsm.ts; this class
 * performs the fetches, executes the returned effects against the database,
 * and drives the polling loop with its storage's alarm. The runtime serializes
 * calls (a Durable Object on Cloudflare, a mutex on Node) — the FSM
 * read-modify-write depends on that.
 */
export class VehicleActor {
  constructor(
    protected readonly storage: ActorStorage,
    protected readonly env: AppEnv,
  ) {}

  private async carId(): Promise<number | null> {
    return (await this.storage.get<number>("carId")) ?? null;
  }

  private async fsm(): Promise<FsmData> {
    return (await this.storage.get<FsmData>("fsm")) ?? initialFsm(Date.now());
  }

  private repo(carId: number): Repo {
    return new Repo(this.env.DB, carId, this.env.NOMINATIM_HOST, this.env.ELEVATION_HOST);
  }

  private async carRow(carId: number): Promise<CarRow | null> {
    return this.env.DB.prepare(
      "SELECT c.eid, c.vin, c.provider, c.account, " +
        "(SELECT COUNT(*) FROM cars v WHERE v.provider = 'volvo') AS volvo_cars FROM cars c WHERE c.id = ?",
    )
      .bind(carId)
      .first<CarRow>();
  }

  private volvo(): VolvoPoller {
    return new VolvoPoller(this.storage, this.env);
  }

  /** Idempotent: registers the car and makes sure it is on one of the clocks. */
  async ensureRunning(carId: number): Promise<void> {
    await this.storage.put("carId", carId);
    const armed = (await this.storage.getAlarm()) !== null;
    const due = await this.storage.get<number>("nextDueAt");
    if (armed || due !== undefined) return;
    await this.schedule(carId, 1_000);
  }

  /** Poll a Volvo car now, forgetting why it stopped — the owner just acted. */
  async restartVolvo(carId: number): Promise<void> {
    await this.storage.put("carId", carId);
    await this.volvo().restart();
    await this.storage.delete("lastError");
    await this.schedule(carId, 1_000);
  }

  /**
   * The cron's entry point: poll a car whose deadline has come round. The cron
   * reads those deadlines from D1 precisely so it does not have to wake every
   * object to ask, so this is only called when there is work to do.
   */
  async pollDue(carId: number): Promise<void> {
    await this.storage.put("carId", carId);
    const alarm = await this.storage.getAlarm();
    // A live alarm means the fast loop owns this car — driving, charging, or
    // mid-wake. The cron's deadline is only a watchdog there; do not poll twice.
    if (alarm !== null && alarm - Date.now() < CRON_PERIOD_MS) return;
    await this.alarm();
  }

  /**
   * Stop polling (car disabled in settings). Takes the id rather than reading
   * it back from storage: the deadline to clear lives in D1, and an object that
   * has never run — or was reset — would otherwise have no idea which row it is.
   */
  async stop(carId: number): Promise<void> {
    await this.unschedule(carId);
  }

  /**
   * Arm the next poll on whichever clock is cheaper. Below the cron's period an
   * alarm is the only thing precise enough, and the object stays resident for
   * the gap — which is correct while a car is actually driving or charging. At
   * or beyond it the deadline goes to D1 with no alarm behind it, so the object
   * is evicted and costs nothing until the cron calls back. A parked car lives
   * entirely on the second branch.
   */
  private async schedule(carId: number, delayMs: number): Promise<void> {
    const at = Date.now() + Math.max(0, delayMs);
    if (delayMs >= CRON_PERIOD_MS) {
      await this.storage.deleteAlarm();
      await this.setNextDue(carId, at, true);
    } else {
      await this.storage.setAlarm(at);
      await this.setNextDue(carId, at + WATCHDOG_GRACE_MS, false);
    }
  }

  /**
   * Publish the deadline the cron reads. `exact` for the deadline the cron is
   * actually expected to act on; without it the write is skipped while the
   * stored value is still close enough to serve as a watchdog.
   */
  private async setNextDue(carId: number, at: number, exact: boolean): Promise<void> {
    const written = await this.storage.get<number>("nextDueAt");
    if (!exact && written !== undefined && Math.abs(at - written) < NEXT_DUE_WRITE_SLACK_MS) return;
    await this.env.DB.prepare("UPDATE cars SET next_due_at = ? WHERE id = ?").bind(at, carId).run();
    await this.storage.put("nextDueAt", at);
  }

  /** Off both clocks: no alarm, and nothing for the cron to pick up. */
  private async unschedule(carId: number): Promise<void> {
    await this.storage.deleteAlarm();
    await this.storage.delete("nextDueAt");
    await this.env.DB.prepare("UPDATE cars SET next_due_at = NULL WHERE id = ?").bind(carId).run();
  }

  async getSummary(): Promise<CarSummaryDto | null> {
    const carId = await this.carId();
    if (carId === null) return null;
    const data = await this.fsm();
    const settings = await this.repo(carId).getCarSettings();
    const summary = this.buildSummary(carId, data, settings);
    summary.lastFetchAt = (await this.storage.get<number>("lastFetchAt")) ?? null;
    summary.lastError = (await this.storage.get<string>("lastError")) ?? null;
    const car = await this.carRow(carId);
    if (car?.provider === "volvo") await this.volvoSummary(summary);
    summary.healthy = summary.lastError === null;
    return summary;
  }

  /** Manual suspend — TeslaMate's PUT /api/car/:id/logging/suspend. */
  async suspendLogging(): Promise<{ ok: boolean; reason?: string }> {
    const carId = await this.carId();
    if (carId === null) return { ok: false, reason: "Car is not being logged" };
    const data = await this.fsm();

    if (data.state.name === "suspended") return { ok: true };
    if (data.state.name === "asleep" || data.state.name === "offline") return { ok: true };
    if (data.state.name !== "online") {
      return { ok: false, reason: `Car is ${stateLabel(data.state)}` };
    }
    if (!data.lastResponse) return { ok: false, reason: "No vehicle data yet" };

    const settings = await this.repo(carId).getCarSettings();
    const blocker = canFallAsleep(data.lastResponse, settings);
    if (blocker) return { ok: false, reason: BLOCKER_MESSAGES[blocker] };

    const repo = this.repo(carId);
    await repo.insertPositions([{ driveId: null, attrs: createPosition(data.lastResponse) }]);
    const next: FsmState = { name: "suspended", prev: data.state };
    await this.storage.put("fsm", {
      ...data,
      state: next,
      lastStateChangeAt: Date.now(),
    } satisfies FsmData);
    await this.schedule(carId, settings.suspend_min * 60_000);
    return { ok: true };
  }

  async resumeLogging(): Promise<{ ok: boolean }> {
    const carId = await this.carId();
    if (carId === null) return { ok: false };
    const data = await this.fsm();
    const settings = await this.repo(carId).getCarSettings();
    const decision = handle(data, { type: "resume" }, settings, Date.now());
    await this.applyDecision(carId, data, decision, null);
    return { ok: true };
  }

  /**
   * User-commanded wake. One of the two commands the Owner API accepts without
   * the signed command protocol, so the one place EVBook deliberately wakes
   * the car rather than avoiding it.
   */
  async wake(): Promise<{ ok: boolean; reason?: string }> {
    const carId = await this.carId();
    if (carId === null) return { ok: false, reason: "Car is not being logged" };
    if ((await this.carRow(carId))?.provider === "volvo") return { ok: false, reason: VOLVO_NO_COMMANDS };
    const data = await this.fsm();
    // Anything but asleep/offline means the car is already awake.
    if (data.state.name !== "asleep" && data.state.name !== "offline" && data.state.name !== "start") {
      return { ok: true };
    }

    const cmd = await this.commandContext(carId);
    if (!cmd.ok) return { ok: false, reason: cmd.reason };
    const result = await cmd.api.wakeUp(cmd.token, cmd.eid);
    if (!result.ok) {
      if (result.error.kind === "unauthorized") await this.storage.delete("authCache");
      return { ok: false, reason: commandErrorReason(result.error) };
    }

    // The fake-wake guard exists to avoid *spending* a wake on an hourly MCU
    // blip; this wake is already spent, and on the user's say-so. Credit the
    // streak so the next tick fetches data instead of probing twice more.
    if (data.state.name !== "start") {
      await this.storage.put("fsm", { ...data, onlineProbeStreak: 1 } satisfies FsmData);
    }
    await this.schedule(carId, 1_000);
    return { ok: true };
  }

  /** Share a destination to the car's navigation — the other unsigned command. */
  async sendDestination(text: string): Promise<{ ok: boolean; reason?: string }> {
    const destination = text.trim();
    if (!destination) return { ok: false, reason: "Destination is empty" };
    const carId = await this.carId();
    if (carId === null) return { ok: false, reason: "Car is not being logged" };

    const cmd = await this.commandContext(carId);
    if (!cmd.ok) return { ok: false, reason: cmd.reason };
    const result = await cmd.api.navigationRequest(cmd.token, cmd.eid, destination);
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

  /** The client, token and Tesla id a command needs, or the reason there isn't one. */
  private async commandContext(
    carId: number,
  ): Promise<{ ok: true; api: OwnerApi; token: string; eid: number } | { ok: false; reason: string }> {
    const car = await this.carRow(carId);
    if (car?.provider === "volvo") return { ok: false, reason: VOLVO_NO_COMMANDS };
    const auth = await this.accessContext(car?.account ?? "default");
    if (!auth) return { ok: false, reason: "Not signed in to Tesla" };
    if (!car?.eid) return { ok: false, reason: "Car has no Tesla id" };
    return { ok: true, api: new OwnerApi(auth.apiHost), token: auth.token, eid: car.eid };
  }

  async alarm(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.storage.put("lastError", `tick failed: ${message}`);
      const carId = await this.carId();
      if (carId !== null) await this.schedule(carId, INTERVALS.asleep * 1000);
    }
  }

  private async tick(): Promise<void> {
    const carId = await this.carId();
    if (carId === null) return;

    const repo = this.repo(carId);
    const settings = await repo.getCarSettings();
    if (!settings.enabled) {
      await this.unschedule(carId);
      return;
    }

    const car = await this.carRow(carId);
    if (car?.provider === "volvo") {
      await this.volvoTick(carId, car, settings);
      return;
    }

    const account = car?.account ?? "default";
    const auth = await this.accessContext(account);
    if (!auth) {
      await this.storage.put("lastError", "Not signed in to Tesla");
      await this.schedule(carId, 5 * 60_000);
      return;
    }

    const data = await this.fsm();
    if (!car?.eid) {
      await this.storage.put("lastError", "Car has no Tesla id");
      await this.schedule(carId, 10 * 60_000);
      return;
    }

    const api = new OwnerApi(auth.apiHost);
    const outcome = await this.fetchForPlan(api, auth.token, car.eid, data);

    if (outcome.kind === "error") {
      await this.handleFetchError(carId, data, outcome.error, account);
      return;
    }

    await this.storage.delete("lastError");
    await this.storage.put("lastFetchAt", Date.now());
    await this.resetBreaker("apiError");

    await this.dispatch(carId, data, outcome.event, settings);
  }

  /**
   * The access token and Owner API host, cached in this object's own storage
   * so a poll does not wake AuthDO. Every tick used to make two AuthDO calls,
   * which kept a second object resident around the clock for an answer that
   * changes a few times a day. The cache is refreshed after AUTH_CACHE_MS or
   * near the token's expiry, and dropped on a 401 (handleFetchError) so a
   * token revoked early costs one wasted poll, not fifteen minutes of them.
   * Encrypted at rest, as AuthDO's own copy is.
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

  private async fetchForPlan(
    api: OwnerApi,
    token: string,
    eid: number,
    data: FsmData,
  ): Promise<{ kind: "event"; event: FsmEvent } | { kind: "error"; error: TeslaError }> {
    const plan = fetchPlan(data);

    if (plan === "data_with_fallback") {
      const result = await api.getVehicleData(token, eid);
      if (result.ok) {
        const parsed = parseVehicleData(result.value);
        if (!parsed) return { kind: "error", error: { kind: "unknown", message: "unparseable vehicle_data" } };
        return { kind: "event", event: { type: "vehicle_data", data: parsed } };
      }
      // 408 means the car is actually asleep — fall back to the cheap probe.
      if (result.error.kind !== "vehicle_unavailable") return { kind: "error", error: result.error };
      return this.probe(api, token, eid);
    }

    const probed = await this.probe(api, token, eid);
    if (probed.kind === "error") return probed;
    const probeEvent = probed.event;
    if (probeEvent.type !== "probe" || probeEvent.state !== "online") return probed;

    if (plan === "probe_only") return probed; // fake-wake guard: do not spend a wake yet

    const result = await api.getVehicleData(token, eid);
    if (result.ok) {
      const parsed = parseVehicleData(result.value);
      if (!parsed) return { kind: "error", error: { kind: "unknown", message: "unparseable vehicle_data" } };
      return { kind: "event", event: { type: "vehicle_data", data: parsed } };
    }
    if (result.error.kind === "vehicle_unavailable") {
      return { kind: "event", event: { type: "probe", state: "asleep" } };
    }
    return { kind: "error", error: result.error };
  }

  private async probe(
    api: OwnerApi,
    token: string,
    eid: number,
  ): Promise<{ kind: "event"; event: FsmEvent } | { kind: "error"; error: TeslaError }> {
    const result = await api.probeState(token, eid);
    if (!result.ok) return { kind: "error", error: result.error };
    const state = result.value.state;
    const normalized = state === "online" ? "online" : state === "asleep" ? "asleep" : "offline";
    return { kind: "event", event: { type: "probe", state: normalized } };
  }

  /** Run the reducer (following redispatch chains) and apply the result. */
  /**
   * `delayMs` overrides the reducer's cadence: a Volvo's polls are paced by its
   * quota (core/volvo/pace.ts), not by the Owner API intervals the reducer was
   * written for, while its transitions stay exactly the reducer's.
   */
  private async dispatch(
    carId: number,
    initial: FsmData,
    event: FsmEvent,
    settings: CarSettingsLike,
    delayMs?: number,
  ): Promise<void> {
    let data = initial;
    let decision: Decision | null = null;

    for (let i = 0; i < MAX_REDISPATCH; i++) {
      decision = handle(data, event, settings, Date.now());
      const applied = await this.applyDecision(carId, data, decision, event, {
        defer: decision.redispatch === true,
        delayMs,
      });
      data = applied;
      if (!decision.redispatch) break;
    }

    if (decision?.redispatch) {
      // Ran out of redispatch budget — flush and schedule a normal poll.
      await this.flushBuffer(this.repo(carId), true);
      await this.schedule(carId, delayMs ?? INTERVALS.default * 1000);
    }
  }

  private async applyDecision(
    carId: number,
    data: FsmData,
    decision: Decision,
    event: FsmEvent | null,
    opts: { defer?: boolean; delayMs?: number } = {},
  ): Promise<FsmData> {
    const repo = this.repo(carId);
    const now = Date.now();
    const openedId = await this.executeEffects(repo, decision, data);

    let nextState = decision.next;
    if (openedId !== null) nextState = resolvePendingId(nextState, openedId);

    const isVehicleData = event?.type === "vehicle_data";
    const next: FsmData = {
      state: nextState,
      lastUsedAt: decision.resetLastUsed ? now : data.lastUsedAt,
      lastStateChangeAt: decision.stateChanged ? now : data.lastStateChangeAt,
      lastResponse: isVehicleData ? event.data : data.lastResponse,
      onlineProbeStreak: this.nextProbeStreak(data, event),
      ...quietReadings(data, event, now),
    };
    await this.storage.put("fsm", next);

    if (isVehicleData) {
      await this.maybeStorePositionHeartbeat(repo, next, event.data);
      await this.maybeStoreTyreReading(repo, event.data);
    }

    if (!opts.defer) {
      // Only flush when the batch is full or stale — the point of the buffer is
      // that a 2.5 s drive loop does not write to D1 on every tick.
      await this.flushBuffer(repo, false);
      await this.schedule(carId, opts.delayMs ?? Math.max(0, decision.scheduleS) * 1000);
    }
    return next;
  }

  private nextProbeStreak(data: FsmData, event: FsmEvent | null): number {
    if (!event) return data.onlineProbeStreak;
    if (event.type === "vehicle_data") return 0;
    if (event.type === "probe") {
      return event.state === "online" ? data.onlineProbeStreak + 1 : 0;
    }
    return data.onlineProbeStreak;
  }

  /**
   * Executes effects in order. Position inserts are buffered so a 2.5 s drive
   * loop does not hit D1 on every tick; any other effect flushes first so it
   * observes a consistent set of rows.
   */
  private async executeEffects(repo: Repo, decision: Decision, data: FsmData): Promise<number | null> {
    let openedId: number | null = null;

    for (const effect of decision.effects) {
      if (effect.type === "insert_position") {
        const driveId = effect.driveId === PENDING_ID ? openedId : effect.driveId;
        await this.pushBuffer({ driveId, attrs: effect.attrs });
        continue;
      }

      // Any non-position effect must observe a consistent set of rows.
      await this.flushBuffer(repo, true);

      switch (effect.type) {
        case "start_state":
          await repo.startState(effect.state, effect.at);
          break;
        case "update_car":
          await repo.updateCar(effect.attrs);
          break;
        case "open_drive":
          openedId = await repo.openDrive(effect.at, effect.attrs, effect.quietAt);
          break;
        case "close_drive":
          await repo.closeDrive(effect.driveId, effect.seenAt);
          break;
        case "open_charging_process":
          openedId = await repo.openChargingProcess(effect.at, effect.position, effect.quietAt);
          break;
        case "insert_charge": {
          const cprocId = effect.cprocId === PENDING_ID ? openedId : effect.cprocId;
          if (cprocId !== null) await repo.insertCharges(cprocId, [effect.attrs]);
          break;
        }
        case "complete_charging_process":
          await repo.completeChargingProcess(effect.cprocId, effect.seenAt);
          break;
        case "open_update":
          openedId = await repo.openUpdate(effect.at);
          break;
        case "finish_update":
          await repo.finishUpdate(effect.updateId, effect.version, effect.at);
          break;
        case "cancel_update":
          await repo.cancelUpdate(effect.updateId);
          break;
        case "synthesize_charging_process": {
          const at = data.lastResponse ? snapshotDate(data.lastResponse) : Date.now();
          await repo.synthesizeChargingProcess(effect.position, effect.charges, at);
          break;
        }
        case "log":
          console.log(`[car] ${effect.message}`);
          break;
      }
    }

    return openedId;
  }

  // ---- Volvo ----

  /**
   * A Volvo car's poll: the Volvo pass reads whatever is due and answers with a
   * `vehicle_data` payload, which goes through the same reducer and the same
   * effects as a Tesla's. There is no probe and no sleep: Volvo reports neither.
   */
  private async volvoTick(carId: number, car: CarRow, settings: CarSettingsLike): Promise<void> {
    const data = await this.fsm();
    const result = await this.volvo().pass(carId, car.vin, Math.max(1, car.volvo_cars));
    if (result.kind === "wait") {
      await this.storage.put("lastError", result.error);
      await this.schedule(carId, result.untilMs);
      return;
    }
    await this.storage.delete("lastError");
    await this.storage.put("lastFetchAt", Date.now());
    // Never under the cron's period: the pass's own clock started before its
    // calls did, and a delay a few ms short of a minute would arm an alarm.
    const delayMs = Math.max(CRON_PERIOD_MS, result.nextAt - Date.now());
    await this.dispatch(carId, data, { type: "vehicle_data", data: result.data }, settings, delayMs);
    // The buffer exists for a 2.5 s Tesla loop; at a minute or more apart there
    // is nothing to batch, and a parked car's row would wait ten minutes.
    await this.flushBuffer(this.repo(carId), true);
  }

  /**
   * What the summary says differently for a Volvo. "Falling asleep" is the
   * reducer's word for a parked car it polls less often; a Volvo never sleeps
   * as far as anyone can tell, so it is simply online. Tyres come from Volvo's
   * own warnings, since there are no pressures to judge.
   */
  private async volvoSummary(summary: CarSummaryDto): Promise<void> {
    summary.provider = "volvo";
    if (summary.state === "falling_asleep") summary.state = "online";
    summary.sleepBlocker = null;
    const state = await this.volvo().state();
    const tyres = state.view.tyres?.v;
    if (tyres) {
      const byCorner = { fl: tyres.frontLeft, fr: tyres.frontRight, rl: tyres.rearLeft, rr: tyres.rearRight };
      summary.tyres = summary.tyres.map((t) => ({ ...t, status: byCorner[t.corner] ?? "unknown" }));
    }
    summary.maintenance = maintenanceOf(state.view);
    const now = Date.now();
    if (summary.lastError === null && Object.values(state.quotaUntil).some((until) => (until ?? 0) > now)) {
      summary.lastError = FAILURE_TEXT.quota;
    }
  }

  // ---- position write buffer ----

  private async pushBuffer(row: BufferedPosition): Promise<void> {
    const buffer = (await this.storage.get<BufferedPosition[]>("buffer")) ?? [];
    buffer.push(row);
    await this.storage.put("buffer", buffer);
    if (buffer.length === 1) await this.storage.put("bufferStartedAt", Date.now());
  }

  /** Writes buffered positions to D1. `force` bypasses the size/age check. */
  private async flushBuffer(repo: Repo, force: boolean): Promise<void> {
    const buffer = (await this.storage.get<BufferedPosition[]>("buffer")) ?? [];
    if (buffer.length === 0) return;
    const startedAt = (await this.storage.get<number>("bufferStartedAt")) ?? 0;
    const due = force || buffer.length >= BUFFER_MAX_ROWS || Date.now() - startedAt >= BUFFER_MAX_AGE_MS;
    if (!due) return;

    await repo.insertPositions(buffer);
    await this.storage.delete("buffer");
    await this.storage.delete("bufferStartedAt");
  }

  /**
   * TeslaMate stores a position every 5 minutes while online or charging so
   * long idle/charging stretches keep a location trail.
   */
  private async maybeStorePositionHeartbeat(repo: Repo, data: FsmData, v: VehicleData): Promise<void> {
    if (data.state.name !== "online" && data.state.name !== "charging") {
      await this.storage.delete("nextHeartbeatAt");
      return;
    }
    const due = (await this.storage.get<number>("nextHeartbeatAt")) ?? 0;
    const now = Date.now();
    if (due === 0) {
      await this.storage.put("nextHeartbeatAt", now + POSITION_HEARTBEAT_MS);
      return;
    }
    if (now < due) return;
    await repo.insertPositions([{ driveId: null, attrs: createPosition(v) }]);
    await this.storage.put("nextHeartbeatAt", now + POSITION_HEARTBEAT_MS);
  }

  /**
   * Keeps the tyre history: every snapshot already fetched carries the
   * pressures, so this costs no request of its own and runs only when the car
   * was awake to answer. Downsampled to one row per `TYRE_READING_INTERVAL_MS`,
   * except that a change in what the car warns of or recommends is written the
   * moment it is seen.
   */
  private async maybeStoreTyreReading(repo: Repo, v: VehicleData): Promise<void> {
    const reading = createTyreReading(v);
    if (!reading) return;
    const flags = JSON.stringify([
      reading.recommended_front,
      reading.recommended_rear,
      reading.soft_warning_fl,
      reading.soft_warning_fr,
      reading.soft_warning_rl,
      reading.soft_warning_rr,
      reading.hard_warning_fl,
      reading.hard_warning_fr,
      reading.hard_warning_rl,
      reading.hard_warning_rr,
    ]);
    const last = await this.storage.get<TyreMark>("tyreMark");
    const due =
      last == null ||
      last.flags !== flags ||
      reading.date_at - last.at >= TYRE_READING_INTERVAL_MS ||
      // A car clock that went backwards (or a restored object) starts afresh.
      reading.date_at < last.at;
    if (!due) return;
    await repo.insertTyreReading(reading);
    await this.storage.put("tyreMark", { at: reading.date_at, flags } satisfies TyreMark);
  }

  // ---- error handling ----

  private async handleFetchError(carId: number, data: FsmData, error: TeslaError, account: string): Promise<void> {
    let delayMs: number;

    switch (error.kind) {
      case "unauthorized": {
        await this.storage.delete("authCache");
        const refreshed = await this.env.actors.auth(account).forceRefresh();
        await this.storage.put("lastError", refreshed ? "Token refreshed, retrying" : "Tesla tokens are invalid");
        delayMs = refreshed ? 5_000 : 5 * 60_000;
        break;
      }
      case "too_many_requests":
      case "account_rate_limited":
        await this.storage.put("lastError", `Rate limited by Tesla, retrying in ${error.retryAfterS}s`);
        delayMs = error.retryAfterS * 1000;
        break;
      case "vehicle_not_found": {
        const tripped = await this.bumpBreaker("notFound", NOT_FOUND_LIMIT, NOT_FOUND_WINDOW_MS);
        await this.storage.put("lastError", "Vehicle not found on this Tesla account");
        if (tripped) {
          // Back right off rather than unschedule: the cron used to undo a bare
          // deleteAlarm within ten minutes anyway, so say that outright.
          await this.schedule(carId, NOT_FOUND_PAUSE_MS);
          return;
        }
        delayMs = INTERVALS.asleep * 1000;
        break;
      }
      case "vehicle_in_service":
        await this.storage.put("lastError", "Vehicle is in service");
        delayMs = INTERVALS.online * 1000;
        break;
      case "vehicle_unavailable":
        delayMs = INTERVALS.asleep * 1000;
        break;
      case "timeout":
        delayMs = this.errorInterval(data.state) * 1000;
        break;
      default: {
        const tripped = await this.bumpBreaker("apiError", API_ERROR_LIMIT, API_ERROR_WINDOW_MS);
        await this.storage.put("lastError", `Tesla API error: ${error.message}`);
        delayMs = tripped ? API_ERROR_PAUSE_MS : this.errorInterval(data.state) * 1000;
        break;
      }
    }

    await this.schedule(carId, delayMs);
  }

  /** Post-error backoff, matching TeslaMate's per-state intervals. */
  private errorInterval(state: FsmState): number {
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

  // ---- summary ----

  private buildSummary(
    carId: number,
    data: FsmData,
    settings: { free_supercharging: boolean } & CarSettingsLike,
  ): CarSummaryDto {
    const v = data.lastResponse;
    const c = v?.charge_state;
    const cl = v?.climate_state;
    const vs = v?.vehicle_state;
    const d = v?.drive_state;
    const su = vs?.software_update;

    const doorsOpen = [vs?.df, vs?.pf, vs?.dr, vs?.pr].some((n) => typeof n === "number" && n > 0);
    const trunkOpen = [vs?.ft, vs?.rt].some((n) => typeof n === "number" && n > 0);
    const windowsOpen = [vs?.fd_window, vs?.fp_window, vs?.rd_window, vs?.rp_window].some(
      (n) => typeof n === "number" && n > 0,
    );

    const blocker = v && data.state.name === "online" ? canFallAsleep(v, settings) : null;

    const activeRoute = d?.active_route_destination
      ? {
          destination: d.active_route_destination,
          minutesToArrival: d.active_route_minutes_to_arrival ?? null,
          distanceKm: kmOrNull(d.active_route_miles_to_arrival, 1),
          trafficMinutesDelay: d.active_route_traffic_minutes_delay ?? null,
          energyAtArrival: d.active_route_energy_at_arrival ?? null,
        }
      : null;

    return {
      carId,
      provider: "tesla",
      state: stateLabel(data.state),
      since: data.lastStateChangeAt || null,
      healthy: true,
      batteryLevel: c?.battery_level ?? null,
      usableBatteryLevel: c?.usable_battery_level ?? null,
      chargeLimitSoc: c?.charge_limit_soc ?? null,
      idealBatteryRangeKm: kmOrNull(c?.ideal_battery_range),
      ratedBatteryRangeKm: kmOrNull(c?.battery_range),
      estBatteryRangeKm: kmOrNull(c?.est_battery_range),
      odometerKm: kmOrNull(vs?.odometer, 1),
      speedKmh: d?.speed == null ? null : Math.round(d.speed / 0.62137119223733),
      power: d?.power ?? null,
      shiftState: d?.shift_state ?? null,
      latitude: d?.latitude ?? null,
      longitude: d?.longitude ?? null,
      heading: d?.heading ?? null,
      insideTemp: cl?.inside_temp ?? null,
      outsideTemp: cl?.outside_temp ?? null,
      driverTempSetting: cl?.driver_temp_setting ?? null,
      isClimateOn: cl?.is_climate_on ?? null,
      isPreconditioning: cl?.is_preconditioning ?? null,
      locked: vs?.locked ?? null,
      sentryMode: vs?.sentry_mode ?? null,
      isUserPresent: vs?.is_user_present ?? null,
      doorsOpen,
      trunkOpen,
      windowsOpen,
      chargingState: c?.charging_state ?? null,
      chargerPower: c?.charger_power ?? null,
      chargerVoltage: c?.charger_voltage ?? null,
      chargerCurrent: c?.charger_actual_current ?? null,
      chargerPhases: c?.charger_phases ?? null,
      chargeEnergyAdded: c?.charge_energy_added ?? null,
      timeToFullCharge: c?.time_to_full_charge ?? null,
      chargePortDoorOpen: c?.charge_port_door_open ?? null,
      version: vs?.car_version ?? null,
      updateAvailable: su?.status === "available",
      updateVersion: su?.version ?? null,
      tpmsPressureFl: vs?.tpms_pressure_fl ?? null,
      tpmsPressureFr: vs?.tpms_pressure_fr ?? null,
      tpmsPressureRl: vs?.tpms_pressure_rl ?? null,
      tpmsPressureRr: vs?.tpms_pressure_rr ?? null,
      tpmsSoftWarningFl: vs?.tpms_soft_warning_fl ?? null,
      tpmsSoftWarningFr: vs?.tpms_soft_warning_fr ?? null,
      tpmsSoftWarningRl: vs?.tpms_soft_warning_rl ?? null,
      tpmsSoftWarningRr: vs?.tpms_soft_warning_rr ?? null,
      tyres: tyreStatesOf(v),
      dataAt: v ? snapshotDate(v) : null,
      doorDfOpen: openOrNull(vs?.df),
      doorPfOpen: openOrNull(vs?.pf),
      doorDrOpen: openOrNull(vs?.dr),
      doorPrOpen: openOrNull(vs?.pr),
      windowFdOpen: openOrNull(vs?.fd_window),
      windowFpOpen: openOrNull(vs?.fp_window),
      windowRdOpen: openOrNull(vs?.rd_window),
      windowRpOpen: openOrNull(vs?.rp_window),
      chargeRateKmh: kmOrNull(c?.charge_rate, 1),
      // "<invalid>" is what an unplugged car reports, not a cable type.
      connChargeCable: c?.conn_charge_cable && c.conn_charge_cable !== "<invalid>" ? c.conn_charge_cable : null,
      batteryHeater: c?.battery_heater_on ?? cl?.battery_heater ?? null,
      cabinOverheatProtection: cl?.cabin_overheat_protection ?? null,
      copActivelyCooling: cl?.cabin_overheat_protection_actively_cooling ?? null,
      passengerTempSetting: cl?.passenger_temp_setting ?? null,
      autoSeatClimateLeft: cl?.auto_seat_climate_left ?? null,
      autoSeatClimateRight: cl?.auto_seat_climate_right ?? null,
      autoSteeringWheelHeat: cl?.auto_steering_wheel_heat ?? null,
      dashcamState: vs?.dashcam_state ?? null,
      scheduledChargingPending: c?.scheduled_charging_pending ?? null,
      tripCharging: c?.trip_charging ?? null,
      activeRoute,
      sleepBlocker: blocker ? BLOCKER_MESSAGES[blocker] : null,
      lastFetchAt: null,
      lastError: null,
    };
  }
}

/** The tyres in a snapshot; four unknowns when it carries no reading. */
function tyreStatesOf(v: VehicleData | null) {
  const reading = v ? createTyreReading(v) : null;
  return tyreStates(reading ? tyreReadingOf(reading) : null);
}

/** Tesla reports door/window positions as numbers; anything above 0 is open. */
function openOrNull(n: number | null | undefined): boolean | null {
  return n == null ? null : n > 0;
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

function kmOrNull(miles: number | null | undefined, precision = 2): number | null {
  if (miles == null) return null;
  const f = 10 ** precision;
  return Math.round((miles / 0.62137119223733) * f) / f;
}
