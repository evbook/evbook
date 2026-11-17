import type { CarSummaryDto, Provider } from "@shared/api-types";
import { fingerprint } from "../core/provider/snapshot";
import type { VehicleData } from "../core/tesla/payload";
import type { AppEnv } from "../platform/env";

/**
 * The seam between the VehicleActor and a provider that is polled rather than
 * read through Tesla's Owner API. The actor knows nothing about any one
 * provider: it asks the car's poller for a pass, dispatches the `vehicle_data`
 * the pass returns through the one state machine, and schedules the next pass
 * for when the poller says. Everything vendor-specific (credentials, endpoints,
 * quota, error reactions, what the summary says differently) is behind this
 * interface, in `src/actors/<provider>Poll.ts`.
 *
 * `docs/providers.md` is the guide to adding one.
 */

/** A provider with a poller: every one but Tesla, which the actor reads itself. */
export type PolledProvider = Exclude<Provider, "tesla">;

/** The car a pass is for. */
export interface PolledCar {
  id: number;
  vin: string;
  /** The row in `accounts` whose credentials read this car. */
  account: string;
}

export type PassResult =
  /** Something was read: the car as known now, in Tesla's shape, and when to read next. */
  | { kind: "event"; data: VehicleData; nextAt: number; transition: boolean }
  /** Nothing to hand the state machine: come back in `untilMs`, and show `error` on the car card. */
  | { kind: "wait"; untilMs: number; error: string };

export interface ProviderPoller {
  /** One polling pass. Never throws for a vendor failure: that is a `wait`. */
  pass(car: PolledCar): Promise<PassResult>;
  /** The owner just acted (signed in, pasted a key): forget why the car stopped or waited. */
  restart(): Promise<void>;
  /**
   * What the car summary says differently for this provider, beyond what the
   * actor already does for every polled car (no sleep, no sleep blocker):
   * readings Tesla's payload has no place for, and a standing failure.
   */
  summarize(summary: CarSummaryDto): Promise<void>;
}

/** The last answer stored for one endpoint, kept in the poller's state so a repeat is recognised. */
export interface StoredSnapshot {
  hash: string;
  id: number;
}

export interface SnapshotInput {
  carId: number;
  provider: PolledProvider;
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
