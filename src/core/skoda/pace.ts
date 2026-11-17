/**
 * How often a Škoda is read, inside a quota of 20 requests an hour.
 *
 * Every read is the same single request, so pacing is one clock per car:
 *
 * - every 5 minutes while the car is moving or charging (12 an hour, what Home
 *   Assistant and ioBroker use),
 * - every 5 minutes for three reads after either ends, so the end is caught,
 * - every 30 minutes while parked (2 an hour).
 *
 * Under all of that sits a rolling one-hour guard of 18 requests, two short of
 * Škoda's 20: the two left over cover a key check from Settings and a retry.
 * Škoda's own headers can only make it stricter: no requests left means wait
 * for the window to refill.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export type Mode = "parked" | "driving" | "charging";

export const PACE_MS = { active: 5 * MIN, parked: 30 * MIN } as const;
/** Reads at the active pace after a drive or a charge ends. */
export const SETTLE_READS = 3;
/** Requests EVBook allows itself per rolling hour. Škoda allows 20. */
export const HOURLY_CAP = 18;

/** The send times still inside the last hour, oldest first. */
export function prune(sent: readonly number[], now: number): number[] {
  return sent.filter((t) => t > now - HOUR && t <= now).sort((a, b) => a - b);
}

/** How long until another request fits under the cap: 0 when one does now. */
export function budgetWaitMs(sent: readonly number[], now: number): number {
  const recent = prune(sent, now);
  if (recent.length < HOURLY_CAP) return 0;
  // The oldest of the last HOURLY_CAP leaves the window first.
  return recent[recent.length - HOURLY_CAP]! + HOUR - now;
}

export function intervalFor(mode: Mode, settleLeft: number): number {
  if (mode !== "parked" || settleLeft > 0) return PACE_MS.active;
  return PACE_MS.parked;
}

export interface NextRead {
  mode: Mode;
  settleLeft: number;
  sent: readonly number[];
  now: number;
  /** Škoda's own word: no requests left until then (RateLimit-Remaining 0 + RateLimit-Reset). */
  serverWaitMs?: number | null;
}

/** Milliseconds until the next read: the pace, held back by the guard and by Škoda. */
export function nextDelayMs({ mode, settleLeft, sent, now, serverWaitMs }: NextRead): number {
  const pace = intervalFor(mode, settleLeft);
  // The guard is measured from the moment the paced read would go out.
  const guard = budgetWaitMs(sent, now + pace);
  return Math.max(pace + guard, serverWaitMs ?? 0);
}
