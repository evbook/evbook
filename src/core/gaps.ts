/**
 * Finds the drives and charges that happened while nothing was reading the car.
 *
 * Between two readings the logger can be blind for many reasons — the car asleep
 * or offline, an expired token, the Worker down, an import that ends where live
 * logging begins later — and the car does not stop living meanwhile. Two facts
 * survive any outage: the odometer only moves when the car is driven, and the
 * state of charge only rises when it is charged. So for each pair of consecutive
 * readings that no recorded event spans, an odometer increase is a drive nobody
 * saw and a state-of-charge rise is a charge nobody saw.
 *
 * What comes back is honest about what it does not know: the event happened
 * somewhere between the two readings — no start, no end, no duration — and a
 * drive's distance is the odometer's difference, which is exact.
 *
 * A gap that ends at a drive's first sample is first the drive-origin
 * reconstruction's to explain (core/driveOrigin.ts): a short pull-away the
 * poller missed is the start of that drive, and once extended over it the
 * drive's first reading carries the parked odometer, leaving no gap here. What
 * it declines — more distance than the quiet span holds — is found here as a
 * drive of its own. The sweep that calls this waits for that one to finish.
 */

export interface Reading {
  at: number;
  /** Odometer, km. */
  km: number | null;
  /** State of charge, %. */
  soc: number | null;
  positionId: number | null;
  /**
   * The recorded event this reading is an end of; a parked reading has none.
   * Readings between an event's start and end are the event's own business.
   */
  event?: { kind: "drive" | "charge"; id: number; end: "start" | "end" };
}

export interface HiddenDrive {
  kind: "drive";
  from: Reading;
  to: Reading;
  km: number;
}

export interface HiddenCharge {
  kind: "charge";
  from: Reading;
  to: Reading;
  socFrom: number;
  socTo: number;
}

export type HiddenEvent = HiddenDrive | HiddenCharge;

/**
 * Less than this is odometer rounding (imports carry tenths of a mile), a car
 * nudged in its spot, or the residue a drive's two ends leave between them.
 */
export const MIN_HIDDEN_KM = 0.5;
/**
 * A state of charge moves a point or two with temperature and BMS rebalancing
 * while parked; three is a charge.
 */
export const MIN_HIDDEN_SOC = 3;
/**
 * A gap longer than this is not an event but a hiatus — logging switched off for
 * weeks, or the seam between an imported history and live logging begun later.
 * Calling a month of driving "a drive" would be the opposite of honest; the
 * odometer series still shows the distance.
 */
export const MAX_HIDDEN_SPAN_MS = 7 * 24 * 3_600_000;
/** Faster than this on average across the whole gap, and the odometer is wrong, not the car. */
const MAX_AVERAGE_KMH = 250;

export function findHiddenEvents(readings: readonly Reading[]): HiddenEvent[] {
  const found: HiddenEvent[] = [];
  const open = new Set<string>();

  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1]!;
    const b = readings[i]!;

    if (a.event?.end === "start") open.add(key(a));
    if (a.event?.end === "end") open.delete(key(a));
    // Inside a recorded event (or two overlapping ones): it saw what happened.
    if (open.size > 0) continue;

    const spanMs = b.at - a.at;
    if (spanMs <= 0 || spanMs > MAX_HIDDEN_SPAN_MS) continue;

    if (a.km != null && b.km != null) {
      const km = b.km - a.km;
      const plausible = km / (spanMs / 3_600_000) <= MAX_AVERAGE_KMH;
      if (km >= MIN_HIDDEN_KM && plausible) {
        found.push({ kind: "drive", from: a, to: b, km });
      }
    }

    if (a.soc != null && b.soc != null && b.soc - a.soc >= MIN_HIDDEN_SOC) {
      found.push({ kind: "charge", from: a, to: b, socFrom: a.soc, socTo: b.soc });
    }
  }

  return found;
}

function key(r: Reading): string {
  return `${r.event!.kind}:${r.event!.id}`;
}
