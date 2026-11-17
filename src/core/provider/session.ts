/**
 * The charging session under way for a car whose provider reports charging
 * power but no energy figure: the energy is the power integrated over the
 * read times (trapezoids).
 *
 * State of charge times a guessed capacity is never used instead: it would
 * make the Health page's capacity estimate measure its own assumption.
 */

export interface ChargeSession {
  startedAt: number;
  /** Energy into the battery so far, kWh. */
  energyKwh: number;
  /** The power at the last read; null when the provider did not say. */
  powerKw: number | null;
  /** When that read was. */
  at: number;
  /** The closing sample: the read that found the charge over. */
  ended?: boolean;
}

export interface ChargeSample {
  charging: boolean;
  /** The reported charging power, kW; null when unknown. Ignored when not charging. */
  powerKw: number | null;
}

/**
 * The session after one more read.
 *
 * - A gap longer than `maxGapMs` adds nothing rather than a guess, and neither
 *   does a stretch whose power is unknown at either end: unknown is not 0 kW.
 * - The read that finds the charge over adds its last stretch (down to 0 kW)
 *   and is the session's closing sample; the read after that has no session.
 * - Charging seen again after a closing sample is a new session from zero,
 *   never the old one carried on.
 */
export function nextSession(
  session: ChargeSession | null,
  sample: ChargeSample,
  now: number,
  maxGapMs: number,
): ChargeSession | null {
  const power = sample.charging ? sample.powerKw : 0;
  const open = session !== null && !session.ended;
  if (!open) return sample.charging ? { startedAt: now, energyKwh: 0, powerKw: power, at: now } : null;
  const dt = now - session.at;
  let energy = session.energyKwh;
  if (dt > 0 && dt <= maxGapMs && power !== null && session.powerKw !== null) {
    energy += ((session.powerKw + power) / 2) * (dt / 3_600_000);
  }
  return {
    startedAt: session.startedAt,
    energyKwh: Math.round(energy * 1000) / 1000,
    powerKw: power,
    at: now,
    ...(sample.charging ? {} : { ended: true }),
  };
}
