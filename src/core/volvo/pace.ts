import type { Endpoint, VolvoApi } from "./api";

/**
 * When each Volvo endpoint is due, and the quota that limits all of them.
 *
 * Volvo has no push and no sleep signal, so everything is polled, and a poll
 * spends quota: 10 000 calls a day per API per application key. The cadence is
 * adaptive — engine and charging state decide a mode, the mode decides each
 * endpoint's interval:
 *
 * - parked: battery and engine state every 10 minutes, to notice a departure or
 *   a plug-in; everything else hourly;
 * - driving: engine, battery, odometer and position every minute — the drive's
 *   samples;
 * - charging: battery every minute — the session's curve.
 *
 * A minute is exactly the cron's period, so a Volvo car never needs an armed
 * Durable Object alarm: it lives entirely on the minute cron, and a parked one
 * costs nothing between polls (docs/architecture.md §3.9).
 */

export type Mode = "parked" | "driving" | "charging";

const MIN = 60_000;
export const PACE_MS = {
  active: 1 * MIN,
  parked: 10 * MIN,
  rare: 60 * MIN,
  details: 24 * 60 * MIN,
} as const;

type Pace = keyof typeof PACE_MS;

/**
 * Calls run in this order, battery first: it is the one API that tells a market
 * Volvo does not serve from an unknown VIN, and with the engine status it sets
 * the mode the rest of the pass is paced by.
 */
export const ORDER: readonly Endpoint[] = [
  "energy-state",
  "engine-status",
  "odometer",
  "location",
  "statistics",
  "doors",
  "windows",
  "tyres",
  "details",
];

const PACE: Record<Endpoint, Record<Mode, Pace> | null> = {
  "energy-state": { parked: "parked", driving: "active", charging: "active" },
  "engine-status": { parked: "parked", driving: "active", charging: "parked" },
  odometer: { parked: "rare", driving: "active", charging: "rare" },
  location: { parked: "rare", driving: "active", charging: "rare" },
  statistics: { parked: "rare", driving: "rare", charging: "rare" },
  doors: { parked: "rare", driving: "rare", charging: "rare" },
  windows: { parked: "rare", driving: "rare", charging: "rare" },
  tyres: { parked: "rare", driving: "rare", charging: "rare" },
  details: { parked: "details", driving: "details", charging: "details" },
  // Known to the client, not polled yet.
  diagnostics: null,
  brakes: null,
  engine: null,
  warnings: null,
  "energy-capabilities": null,
};

/**
 * Read at once when a drive or a charge begins or ends, whatever their pace:
 * without them a drive's end position would be up to an hour stale.
 */
export const SETTLE: readonly Endpoint[] = ["odometer", "location", "statistics"];

export function intervalMs(endpoint: Endpoint, mode: Mode): number | null {
  const pace = PACE[endpoint]?.[mode];
  return pace ? PACE_MS[pace] : null;
}

/**
 * Slack so an endpoint fetched a few seconds late last time is not skipped this
 * time: the cron runs on the minute, and calls take a moment.
 */
const DUE_SLACK_MS = 15_000;

export function dueEndpoints(
  lastFetched: Partial<Record<Endpoint, number>>,
  mode: Mode,
  now: number,
  skip: ReadonlySet<Endpoint> = new Set(),
): Endpoint[] {
  return ORDER.filter((endpoint) => {
    if (skip.has(endpoint)) return false;
    const interval = intervalMs(endpoint, mode);
    if (interval === null) return false;
    const last = lastFetched[endpoint];
    return last === undefined || now - last >= interval - DUE_SLACK_MS;
  });
}

/** When the next endpoint falls due, at the earliest. */
export function nextDueAt(lastFetched: Partial<Record<Endpoint, number>>, mode: Mode, now: number): number {
  let next = now + PACE_MS.parked;
  for (const endpoint of ORDER) {
    const interval = intervalMs(endpoint, mode);
    if (interval === null) continue;
    const last = lastFetched[endpoint];
    next = Math.min(next, last === undefined ? now : last + interval);
  }
  return Math.max(next, now + PACE_MS.active);
}

// ---- quota ----

export const DAILY_QUOTA = 10_000;
/** Kept back for listing vehicles at connection time and calls lost to a restart. */
const RESERVE = 0.1;
const DAY_MS = 24 * 60 * MIN;
const HOUR_MS = 60 * MIN;

export interface Bucket {
  tokens: number;
  at: number;
}

export type Budget = Record<VolvoApi, Bucket>;

/**
 * A token bucket per API, so a busy morning can spend an hour's worth at once
 * and a day can never spend more than the usable quota — instead of polling
 * flat out until the counter hits 10 000 and leaving the car dark until
 * midnight. A car's share is the usable quota divided among the instance's
 * Volvo cars, which all spend the one key.
 */
export function bucketShape(cars: number): { capacity: number; ratePerMs: number } {
  const usable = (DAILY_QUOTA * (1 - RESERVE)) / Math.max(1, cars);
  const capacity = Math.max(1, usable * (HOUR_MS / DAY_MS));
  return { capacity, ratePerMs: (usable - capacity) / DAY_MS };
}

export function freshBudget(cars: number, now: number): Budget {
  const { capacity } = bucketShape(cars);
  return {
    "connected-vehicle": { tokens: capacity, at: now },
    energy: { tokens: capacity, at: now },
    location: { tokens: capacity, at: now },
  };
}

function refill(bucket: Bucket, cars: number, now: number): Bucket {
  const { capacity, ratePerMs } = bucketShape(cars);
  const elapsed = Math.max(0, now - bucket.at);
  return { tokens: Math.min(capacity, bucket.tokens + elapsed * ratePerMs), at: now };
}

/** Take one call's token, or say no. A refused call stays due: it is late, not dropped. */
export function take(budget: Budget, api: VolvoApi, cars: number, now: number): boolean {
  const bucket = refill(budget[api], cars, now);
  if (bucket.tokens < 1) {
    budget[api] = bucket;
    return false;
  }
  budget[api] = { tokens: bucket.tokens - 1, at: now };
  return true;
}

/** Charge calls the client made beyond the one `take` paid for (key retries). */
export function spend(budget: Budget, api: VolvoApi, calls: number): void {
  if (calls > 0) budget[api] = { ...budget[api], tokens: budget[api].tokens - calls };
}
