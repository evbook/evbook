import type { CarSummaryDto, Provider } from "@shared/api-types";
import type { FsmData } from "../core/fsm";
import { fingerprint } from "../core/provider/snapshot";
import type { VehicleData } from "../core/tesla/payload";
import type { AppEnv } from "../platform/env";

/**
 * The seam between the VehicleActor and the maker's service. The actor knows
 * nothing about any one provider: it asks the car's poller for a pass,
 * dispatches what the pass read through the one state machine, and schedules
 * the next pass for when the poller (or, failing that, the state machine)
 * says. Everything vendor-specific (credentials, endpoints, quota, error
 * reactions and their back-off, what the summary says differently, the
 * commands a provider declares) is behind this interface, in
 * `src/actors/<provider>Poll.ts`.
 *
 * `docs/providers.md` is the guide to adding one.
 */

/**
 * The cron's period, and with it the line between the two clocks a car can be
 * polled on (VehicleActor.schedule): under it an alarm, at or over it the cron.
 */
export const CRON_PERIOD_MS = 60_000;

/** The car a pass is for. */
export interface PolledCar {
  id: number;
  vin: string;
  /** The maker's own id for the car, where its API addresses cars by one (Tesla's `id_s`). */
  eid: number | null;
  /** The account whose credentials read this car: a row in `accounts`, or a Tesla account actor's name. */
  account: string;
}

export type PassResult =
  /**
   * The car was read in full: as known now, in Tesla's shape. `nextAt` is when
   * to read next; without it the state machine's own cadence decides, which is
   * the Owner API's (core/fsm.ts `INTERVALS`). `transition` is the poller's own
   * note that its pace changed mode; the actor does not read it.
   */
  | { kind: "event"; data: VehicleData; nextAt?: number; transition?: boolean }
  /**
   * Only whether the car is awake, from a read that never wakes it: what the
   * state machine's sleep and fake-wake rules run on. The state machine's
   * cadence decides the next pass.
   */
  | { kind: "probe"; state: "online" | "asleep" | "offline" }
  /**
   * Nothing to hand the state machine: come back in `untilMs`, and show
   * `error` on the car card. Without `error` the card keeps what it showed: the
   * failure was routine (a timeout, a car that went to sleep mid-read).
   */
  | { kind: "wait"; untilMs: number; error?: string };

/** A command for the car; sent only where the provider declares it (`shared/capabilities.ts`). */
export type CarCommand = { kind: "wake" } | { kind: "navigate"; destination: string };

export type CommandResult = { ok: true } | { ok: false; reason: string };

export interface ProviderPoller {
  /**
   * The shortest delay this provider's passes may be scheduled at. A minute
   * (the cron's period) for a provider read on the cron's clock only, so that
   * a delay a few ms short of it never arms an alarm; zero for one whose drive
   * loop is faster than the cron (a Tesla's 2.5 s).
   */
  readonly minDelayMs: number;
  /**
   * One polling pass. `fsm` is the state machine as it stands, for a provider
   * whose read depends on it (whether a sleeping car may be asked for data).
   * Never throws for a vendor failure: that is a `wait`.
   */
  pass(car: PolledCar, fsm: FsmData): Promise<PassResult>;
  /** The owner just acted (signed in, pasted a key): forget why the car stopped or waited. */
  restart(): Promise<void>;
  /**
   * What the car summary says differently for this provider, beyond what the
   * actor already does from the provider's capabilities (no sleep and no
   * sleep blocker for a car EVBook cannot let sleep): readings Tesla's payload
   * has no place for, and a standing failure.
   */
  summarize(summary: CarSummaryDto): Promise<void>;
  /**
   * Send a command. Only a provider that declares commands in
   * `shared/capabilities.ts` implements it, and the actor asks only for a
   * declared one. Providers are read-only by default: a new one has no `send`.
   */
  send?(car: PolledCar, command: CarCommand): Promise<CommandResult>;
}

/** The last answer stored for one endpoint, kept in the poller's state so a repeat is recognised. */
export interface StoredSnapshot {
  hash: string;
  id: number;
}

export interface SnapshotInput {
  carId: number;
  provider: Provider;
  /** The provider's own name for what was asked; one constant for a provider with a single read. */
  endpoint: string;
  /** The parsed answer, for the fingerprint. */
  value: unknown;
  /** The answer as it arrived, which is what is stored. */
  raw: string;
  now: number;
  /** Keys that change on every answer without the car changing (core/provider/snapshot.ts). */
  volatile: ReadonlySet<string>;
  last: StoredSnapshot | null | undefined;
}

/**
 * Keep a provider's answer as it came, in `provider_snapshots`. Drives and
 * charges are derived from readings, and a derivation can be wrong: the raw
 * payload is what lets a corrected mapping be run again over history that
 * cannot be collected twice. One row per distinct answer; a repeat of the last
 * one only moves its `checked_at`. Returns what to remember as `last`.
 */
export async function storeSnapshot(db: AppEnv["DB"], snap: SnapshotInput): Promise<StoredSnapshot | null> {
  const hash = await fingerprint(snap.value, snap.volatile);
  const last = snap.last ?? null;
  if (last && last.hash === hash) {
    const res = await db
      .prepare("UPDATE provider_snapshots SET checked_at = ? WHERE id = ?")
      .bind(snap.now, last.id)
      .run();
    if (res.meta.changes > 0) return last;
  }
  const row = await db
    .prepare(
      "INSERT INTO provider_snapshots (car_id, provider, endpoint, fetched_at, checked_at, fingerprint, payload) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(snap.carId, snap.provider, snap.endpoint, snap.now, snap.now, hash, snap.raw)
    .first<{ id: number }>();
  return row ? { hash, id: row.id } : last;
}
