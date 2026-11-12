import type { DatabaseSync } from "node:sqlite";
import { AuthActor } from "../../actors/auth";
import { VOLVO_ACCOUNT, VolvoAuthActor } from "../../actors/volvoAuth";
import { ImportActor } from "../../actors/import";
import { VehicleActor } from "../../actors/vehicle";
import type { AppEnv } from "../env";
import type { Actors, ActorStorage, AuthHandle, ImportHandle, VehicleHandle, VolvoHandle } from "../ports";

/**
 * The in-process actor runtime: what Durable Objects provide on Cloudflare,
 * rebuilt on one Node process from three parts.
 *
 *   - Serialization: every handle call and every alarm firing goes through the
 *     actor's promise-chain mutex, so no two run at once — the guarantee the
 *     vehicle FSM's read-modify-write and the import cursor depend on. Coarser
 *     than workerd's input gates (whole call, not gaps between awaits), which
 *     is strictly safer.
 *   - Storage: `actor_kv` in the same SQLite file as the application data.
 *     JSON values as TEXT, `Uint8Array` values (the import's upload chunks) as
 *     BLOB. These tables are bootstrap DDL, not migrations — they are this
 *     runtime's furniture, and don't belong in a D1 deployment.
 *   - Alarms: `actor_alarms` plus one armed `setTimeout` per actor. The row is
 *     what survives a restart — `recoverAlarms()` re-arms from it at boot, and
 *     it outlives the handler run (consumed only on completion), which is what
 *     lets a half-done import carry on after a redeploy or a crash mid-tick.
 *     A handler that throws without rescheduling is retried with a backoff,
 *     approximating workerd.
 *
 * Actors are created lazily and never evicted: their state lives in storage,
 * so a resident instance is a small object and a mutex.
 */

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS actor_kv (
  actor TEXT NOT NULL,
  key   TEXT NOT NULL,
  kind  TEXT NOT NULL CHECK (kind IN ('json','bytes')),
  value BLOB NOT NULL,
  PRIMARY KEY (actor, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS actor_alarms (
  actor        TEXT PRIMARY KEY,
  scheduled_at INTEGER NOT NULL
);
`;

/** How long `shutdown` waits for in-flight actor work before giving up. */
const DRAIN_TIMEOUT_MS = 10_000;

/** Backoff before re-running an alarm handler that threw, like workerd's retry. */
const ALARM_RETRY_MS = 30_000;

export interface NodeActors extends Actors {
  /** Re-arms timers from `actor_alarms`; call once at boot, after migrations. */
  recoverAlarms(): void;
  /** Stops arming timers and waits (bounded) for in-flight calls to finish. */
  shutdown(): Promise<void>;
}

/** Test seam: the runtime's serialization/alarm/storage plumbing under probes. */
export type ActorFactory = (key: string, storage: ActorStorage, env: AppEnv) => { alarm(): Promise<void> };

export function createNodeActors(
  sqlite: DatabaseSync,
  env: AppEnv,
  options: { createActor?: ActorFactory } = {},
): NodeActors {
  sqlite.exec(BOOTSTRAP);
  const runtime = new Runtime(sqlite, env, options.createActor);
  return {
    auth: (account = "default") => runtime.handle(`auth:${account}`, AUTH_METHODS) as AuthHandle,
    volvo: () => runtime.handle(`auth:${VOLVO_ACCOUNT}`, VOLVO_METHODS) as VolvoHandle,
    vehicle: (carId: number) => runtime.handle(`vehicle:car:${carId}`, VEHICLE_METHODS) as VehicleHandle,
    importer: () => runtime.handle("import:default", IMPORT_METHODS) as ImportHandle,
    recoverAlarms: () => runtime.recoverAlarms(),
    shutdown: () => runtime.shutdown(),
  };
}

const AUTH_METHODS = [
  "signIn",
  "signOut",
  "status",
  "getAccessToken",
  "getAccessContext",
  "getApiHost",
  "forceRefresh",
] as const;
const VOLVO_METHODS = [
  "status",
  "setCredentials",
  "clearCredentials",
  "beginAuthorization",
  "completeAuthorization",
  "getAccessContext",
  "forceRefresh",
  "disconnect",
] as const;
const VEHICLE_METHODS = [
  "ensureRunning",
  "restartVolvo",
  "pollDue",
  "stop",
  "getSummary",
  "suspendLogging",
  "resumeLogging",
  "wake",
  "sendDestination",
] as const;
const IMPORT_METHODS = ["begin", "append", "uploadedBytes", "start", "status", "cancel", "resume", "discard"] as const;

function defaultActor(key: string, storage: ActorStorage, env: AppEnv): { alarm(): Promise<void> } {
  if (key === `auth:${VOLVO_ACCOUNT}`) return new VolvoAuthActor(storage, env);
  if (key.startsWith("auth:")) return new AuthActor(storage, env);
  if (key === "import:default") return new ImportActor(storage, env);
  if (key.startsWith("vehicle:")) return new VehicleActor(storage, env);
  throw new Error(`unknown actor key: ${key}`);
}

class Host {
  /** The mutex: the resolved tail of everything this actor has been asked to do. */
  private tail: Promise<unknown> = Promise.resolve();
  timer: NodeJS.Timeout | null = null;
  readonly actor: { alarm(): Promise<void> };

  constructor(
    readonly key: string,
    runtime: Runtime,
  ) {
    const storage = new SqliteActorStorage(key, runtime, this);
    this.actor = (runtime.createActor ?? defaultActor)(key, storage, runtime.env);
  }

  enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.tail.then(fn);
    // The chain must survive a rejection; the caller still sees it via `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The tail at this moment, for a bounded drain at shutdown. */
  settled(): Promise<unknown> {
    return this.tail;
  }
}

class Runtime {
  private readonly hosts = new Map<string, Host>();
  private readonly handles = new Map<string, object>();
  private draining = false;

  constructor(
    readonly sqlite: DatabaseSync,
    readonly env: AppEnv,
    readonly createActor?: ActorFactory,
  ) {}

  host(key: string): Host {
    let host = this.hosts.get(key);
    if (!host) {
      host = new Host(key, this);
      this.hosts.set(key, host);
    }
    return host;
  }

  /** One memoized handle per actor: each method call runs through the mutex. */
  handle(key: string, methods: readonly string[]): object {
    let handle = this.handles.get(key);
    if (!handle) {
      const host = this.host(key);
      const actor = host.actor as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const method of methods) {
        wrapped[method] = (...args: unknown[]) => host.enqueue(() => actor[method]!(...args));
      }
      handle = wrapped;
      this.handles.set(key, handle);
    }
    return handle;
  }

  armTimer(host: Host, scheduledAt: number): void {
    if (host.timer) clearTimeout(host.timer);
    if (this.draining) return;
    const delay = Math.max(0, scheduledAt - Date.now());
    // Referenced on purpose: an armed alarm (an import slice, a token refresh)
    // is work the process must stay alive for on an otherwise idle server.
    host.timer = setTimeout(() => this.fire(host), delay);
  }

  private fire(host: Host): void {
    host.timer = null;
    void host.enqueue(async () => {
      const row = this.sqlite.prepare("SELECT scheduled_at FROM actor_alarms WHERE actor = ?").get(host.key) as
        { scheduled_at: number } | undefined;
      if (!row) return; // deleted while this was queued behind another call
      if (row.scheduled_at > Date.now() + 500) {
        // Moved while this was queued; fire when it actually falls due.
        this.armTimer(host, row.scheduled_at);
        return;
      }
      // The row stays while the handler runs and is consumed only afterwards,
      // and only if the handler left it untouched. That persistence is the
      // crash story: a process killed mid-handler still has the row, so
      // recoverAlarms() re-runs the tick at the next boot — the same replay a
      // Durable Object gets from workerd retrying a killed alarm. (Handlers
      // must not read getAlarm() and expect null — see the port contract.)
      const firedAt = row.scheduled_at;
      try {
        await host.actor.alarm();
        this.sqlite.prepare("DELETE FROM actor_alarms WHERE actor = ? AND scheduled_at = ?").run(host.key, firedAt);
      } catch (error) {
        console.error(`[actors] ${host.key} alarm failed:`, error);
        const still = this.sqlite.prepare("SELECT scheduled_at FROM actor_alarms WHERE actor = ?").get(host.key) as
          { scheduled_at: number } | undefined;
        // The handler blew up before rescheduling anything: retry the way
        // workerd would, with a short backoff. If it managed to re-arm (the
        // auth and import actors schedule their own retries), leave that be.
        if (still && still.scheduled_at === firedAt) this.armTimer(host, Date.now() + ALARM_RETRY_MS);
      }
    });
  }

  recoverAlarms(): void {
    const rows = this.sqlite.prepare("SELECT actor, scheduled_at FROM actor_alarms").all() as {
      actor: string;
      scheduled_at: number;
    }[];
    for (const row of rows) this.armTimer(this.host(row.actor), row.scheduled_at);
  }

  async shutdown(): Promise<void> {
    this.draining = true;
    for (const host of this.hosts.values()) {
      if (host.timer) clearTimeout(host.timer);
      host.timer = null;
    }
    const drains = [...this.hosts.values()].map((host) => host.settled());
    await Promise.race([Promise.all(drains), new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS))]);
  }
}

/**
 * `ActorStorage` over the `actor_kv` / `actor_alarms` tables. Methods are
 * async in signature and synchronous inside — under the actor mutex that makes
 * every read-modify-write trivially atomic, and a multi-key `put` never
 * interleaves with anything.
 *
 * Values round-trip through JSON rather than the structured clone Durable
 * Objects use. The difference (dropped `undefined` properties, no Map/Set/Date)
 * is inert here: everything the actors store is plain data with `??` defaults
 * at every read.
 */
class SqliteActorStorage implements ActorStorage {
  constructor(
    private readonly key: string,
    private readonly runtime: Runtime,
    private readonly host: Host,
  ) {}

  private get sqlite(): DatabaseSync {
    return this.runtime.sqlite;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.sqlite
      .prepare("SELECT kind, value FROM actor_kv WHERE actor = ? AND key = ?")
      .get(this.key, key) as { kind: string; value: unknown } | undefined;
    return row === undefined ? undefined : (decode(row) as T);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const upsert = this.sqlite.prepare(
      "INSERT INTO actor_kv (actor, key, kind, value) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (actor, key) DO UPDATE SET kind = excluded.kind, value = excluded.value",
    );
    const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry instanceof Uint8Array) upsert.run(this.key, key, "bytes", entry);
      else upsert.run(this.key, key, "json", JSON.stringify(entry));
    }
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const remove = this.sqlite.prepare("DELETE FROM actor_kv WHERE actor = ? AND key = ?");
    if (typeof keyOrKeys === "string") return remove.run(this.key, keyOrKeys).changes > 0;
    let removed = 0;
    for (const key of keyOrKeys) removed += Number(remove.run(this.key, key).changes);
    return removed;
  }

  /** Key-value pairs only — like Cloudflare's, this does NOT clear the alarm. */
  async deleteAll(): Promise<void> {
    this.sqlite.prepare("DELETE FROM actor_kv WHERE actor = ?").run(this.key);
  }

  async list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>> {
    const rows = this.sqlite
      .prepare("SELECT key, kind, value FROM actor_kv WHERE actor = ? AND substr(key, 1, length(?)) = ? ORDER BY key")
      .all(this.key, options.prefix, options.prefix) as { key: string; kind: string; value: unknown }[];
    return new Map(rows.map((row) => [row.key, decode(row) as T]));
  }

  async getAlarm(): Promise<number | null> {
    const row = this.sqlite.prepare("SELECT scheduled_at FROM actor_alarms WHERE actor = ?").get(this.key) as
      { scheduled_at: number } | undefined;
    return row?.scheduled_at ?? null;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.sqlite
      .prepare(
        "INSERT INTO actor_alarms (actor, scheduled_at) VALUES (?, ?) " +
          "ON CONFLICT (actor) DO UPDATE SET scheduled_at = excluded.scheduled_at",
      )
      .run(this.key, scheduledTime);
    this.runtime.armTimer(this.host, scheduledTime);
  }

  async deleteAlarm(): Promise<void> {
    this.sqlite.prepare("DELETE FROM actor_alarms WHERE actor = ?").run(this.key);
    if (this.host.timer) {
      clearTimeout(this.host.timer);
      this.host.timer = null;
    }
  }
}

function decode(row: { kind: string; value: unknown }): unknown {
  if (row.kind === "bytes") {
    const value = row.value as Uint8Array;
    return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
  }
  return JSON.parse(String(row.value));
}
