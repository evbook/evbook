import { READS, type Endpoint } from "./api";

/**
 * How often each of a car's four reads is made.
 *
 * Pleos publishes no quota, and polling faster buys nothing when the car is
 * parked: every answer is the car's last upload, and a parked car uploads
 * little or nothing (one live answer read at 07:14 carried the car's time from
 * 22:18 the evening before). A CCS 2.0 car uploads about once a minute while
 * on, a CCS 1.0 car only at the end of a drive. So:
 *
 * | Read        | Parked | Driving | Charging |
 * |-------------|--------|---------|----------|
 * | batteries   | 10 min | 10 min  | 5 min    |
 * | driving     | 10 min | 2 min   | 10 min   |
 * | locations   | 60 min | 2 min   | 60 min   |
 * | powertrains | 60 min | 10 min  | 10 min   |
 *
 * That is 14 requests an hour parked (336 a day), 72 an hour driving. When a
 * drive or a charge starts or ends, every read is made once more within two
 * minutes, so the car's settled state is caught. Under all of it sits a rolling
 * guard of `HOURLY_CAP` requests a car, and Pleos's own 429 can only make it
 * wait longer. Two independent loggers chose the same 10-minute and 2-minute
 * pace; the 2,000 a day one of them budgets per key is an assumption, not a
 * published quota.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export type Mode = "parked" | "driving" | "charging";

export const PACE_MS: Record<Mode, Record<Endpoint, number>> = {
  parked: { batteries: 10 * MIN, driving: 10 * MIN, locations: 60 * MIN, powertrains: 60 * MIN },
  driving: { batteries: 10 * MIN, driving: 2 * MIN, locations: 2 * MIN, powertrains: 10 * MIN },
  charging: { batteries: 5 * MIN, driving: 10 * MIN, locations: 60 * MIN, powertrains: 10 * MIN },
};

/** After a drive or a charge starts or ends: every read once more, this soon. */
export const SETTLE_MS = 2 * MIN;
/** Requests one car may make in a rolling hour, failures included. */
export const HOURLY_CAP = 80;
/** A read due within this of a pass is made in that pass, rather than waking again for it. */
export const COALESCE_MS = 45_000;
/** Never schedule under the cron's minute. */
export const MIN_DELAY_MS = MIN;

export type Due = Partial<Record<Endpoint, number>>;

/** The send times still inside the last hour, oldest first. */
export function prune(sent: readonly number[], now: number): number[] {
  return sent.filter((t) => t > now - HOUR && t <= now).sort((a, b) => a - b);
}

/** How long until `count` more requests fit under the cap: 0 when they do now. */
export function budgetWaitMs(sent: readonly number[], now: number, count = 1): number {
  const recent = prune(sent, now);
  const over = recent.length + count - HOURLY_CAP;
  if (over <= 0) return 0;
  // The oldest `over` requests have to leave the window first.
  const leaving = recent[Math.min(over, recent.length) - 1];
  return leaving === undefined ? HOUR : leaving + HOUR - now;
}

/** The reads due now: those whose time has come, or comes within `COALESCE_MS`. A read never made is due. */
export function dueNow(due: Due, now: number): Endpoint[] {
  return READS.filter((endpoint) => (due[endpoint] ?? 0) <= now + COALESCE_MS);
}

/** When each read is next due after the reads in `done` were made at `now`, in `mode`. */
export function schedule(due: Due, done: readonly Endpoint[], mode: Mode, now: number): Due {
  const next: Due = { ...due };
  for (const endpoint of done) next[endpoint] = now + PACE_MS[mode][endpoint];
  // A read that is not due for longer than the new mode allows is brought forward.
  for (const endpoint of READS) {
    const limit = now + PACE_MS[mode][endpoint];
    if ((next[endpoint] ?? 0) > limit) next[endpoint] = limit;
  }
  return next;
}

/** A drive or a charge started or ended: every read once more within `SETTLE_MS`. */
export function settle(due: Due, now: number): Due {
  const next: Due = { ...due };
  for (const endpoint of READS) next[endpoint] = Math.min(next[endpoint] ?? Infinity, now + SETTLE_MS);
  return next;
}

/** Milliseconds until the next pass: the earliest read due, held back by the guard and by Pleos. */
export function nextDelayMs(
  due: Due,
  sent: readonly number[],
  now: number,
  serverWaitMs: number | null = null,
): number {
  const earliest = Math.min(...READS.map((endpoint) => due[endpoint] ?? now));
  const pace = Math.max(earliest - now, MIN_DELAY_MS);
  const guard = budgetWaitMs(sent, now + pace);
  return Math.max(pace + guard, serverWaitMs ?? 0);
}
