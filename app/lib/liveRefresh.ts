import type { CarSummaryDto } from "@shared/api-types";

/**
 * How often the overview asks for live summaries.
 *
 * Every ask is a Worker request plus one Durable Object request per car, so a
 * flat 5 s cadence spent ~17k of each per car per day on a tab left open —
 * mostly re-reading a parked car the actor itself only refreshes every
 * 15–60 s. The interval follows the busiest car instead: fast only while
 * something on the card actually moves.
 */
export const LIVE_REFRESH_MS = {
  /** Speed, power and position change every actor poll (2.5–5 s). */
  active: 5_000,
  /** Awake but parked: the actor's default cadence. */
  awake: 15_000,
  /** Asleep or offline: the actor checks once a minute. */
  idle: 30_000,
} as const;

/** How long a Wake or Resume keeps the overview on the fast cadence. */
export const BOOST_MS = 90_000;

const ACTIVE = new Set(["driving", "charging"]);
const IDLE = new Set(["asleep", "offline"]);

let boostUntil = 0;

/**
 * A command was just sent that should show on the card within seconds — a
 * wake, a resume. Poll fast for a while so it does, whatever state the car is
 * still reported in.
 */
export function boostLiveRefresh(now = Date.now()): void {
  boostUntil = now + BOOST_MS;
}

export function liveRefreshInterval(summaries: CarSummaryDto[] | undefined, now = Date.now()): number {
  if (now < boostUntil) return LIVE_REFRESH_MS.active;
  if (!summaries || summaries.length === 0) return LIVE_REFRESH_MS.awake;
  if (summaries.some((s) => ACTIVE.has(s.state))) return LIVE_REFRESH_MS.active;
  if (summaries.every((s) => IDLE.has(s.state))) return LIVE_REFRESH_MS.idle;
  return LIVE_REFRESH_MS.awake;
}
