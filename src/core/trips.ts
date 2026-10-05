/**
 * Where one journey ends and the next begins.
 *
 * A road trip is one thing to a person and fourteen rows to this app. Nothing in
 * the data says which rows belong together, so it has to be decided, and the
 * decision is the whole of this module — kept pure and free of SQL so the rules
 * can be read and tested as rules.
 *
 * Two of them, and the first is the one that matters:
 *
 * 1. **You came back.** A stop of a couple of hours at the place the run started
 *    from ends it. This is what makes the commute and the school run come out as
 *    the errands they are, and a fortnight around the Alps come out as one trip
 *    however many hotel nights are inside it — a gap-based rule cannot do both,
 *    because an overnight stop on a road trip is longer than an evening at home.
 * 2. **You stopped moving.** Two days parked ends a run wherever it is. This is
 *    the net under rule 1, for the journey that never returns and for the drive
 *    whose place the geocoder never resolved.
 *
 * Then a run has to be worth calling a trip: far enough, and more than one drive.
 * A single long drive is already a first-class thing here with its own page, map
 * and elevation profile, and listing it again as a trip of one would say nothing
 * new.
 */

/**
 * The identity of somewhere the car stood, in both of the forms the logger gives
 * it: the geofence it fell inside, and the reverse-geocoded address. Two, not one
 * coalesced key, because they do not fail together — the same driveway is `g1`
 * on the day the fix landed inside the fence and only `a2` on the day it did not,
 * and a return rule comparing single keys read that as two different places and
 * kept the journey open. A place matches another when *either* form does.
 */
export interface TripPlace {
  geofence: string | null;
  address: string | null;
}

export interface TripDrive {
  id: number;
  startAt: number;
  /** Closed drives only — an open one has no end to measure a stop from. */
  endAt: number;
  distanceKm: number | null;
  durationMin: number | null;
  energyKwh: number | null;
  startLabel: string | null;
  endLabel: string | null;
  /** The town each end sits in, carried alongside the label so the page can dim it. */
  startRegion: string | null;
  endRegion: string | null;
  /** Stable identity of each end. Both fields null when nothing resolved it. */
  startPlace: TripPlace;
  endPlace: TripPlace;
  /** Where each end sits on the map, for naming the trip after its farthest stop. */
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  startBatteryLevel: number | null;
  endBatteryLevel: number | null;
}

export interface TripOptions {
  /** Used to decide whether the newest run has ended yet. */
  now: number;
  /** A stop this long back where the run began ends it. */
  returnStopMs: number;
  /** A stop this long anywhere ends it. */
  longStopMs: number;
  /** Runs shorter than this are errands. */
  minDistanceKm: number;
  /** Runs of fewer drives than this are one drive, which has its own page. */
  minDrives: number;
}

export const TRIP_DEFAULTS: Omit<TripOptions, "now"> = {
  // An hour, not two: an errand that got home at 12:41 was being glued onto a
  // journey that left at 14:02, because 81 minutes did not count as "back". An
  // hour at home is lunch between two outings; twenty minutes to swap bags —
  // which is what this threshold protects — is still well under it.
  returnStopMs: 3_600_000,
  longStopMs: 48 * 3_600_000,
  // Low enough for an afternoon into the hills and back — a real outing that 100
  // was quietly swallowing — while a 30 km-each-way commute still falls short.
  minDistanceKm: 60,
  minDrives: 2,
};

export interface TripRun {
  drives: TripDrive[];
  /**
   * False while no boundary has been seen after the last drive — the car is still
   * out, or has not been back long enough to say the journey is over.
   */
  closed: boolean;
}

/** Sum that stays null when there is nothing to add, rather than becoming 0. */
function total(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

/**
 * A pause this short between two drives is the recorder pausing, not the car
 * stopping anywhere: a traffic queue, a gate, a moment of lost signal. Long
 * enough to absorb those, short enough that a real errand — even posting a
 * letter — stays a stop.
 */
const SEGMENT_GAP_MS = 3 * 60_000;

/** The two rows joined into one, ends from the later, sums null-aware. */
function joined(a: TripDrive, b: TripDrive): TripDrive {
  return {
    ...a,
    endAt: Math.max(a.endAt, b.endAt),
    distanceKm: total([a.distanceKm, b.distanceKm]),
    durationMin: total([a.durationMin, b.durationMin]),
    energyKwh: total([a.energyKwh, b.energyKwh]),
    endLabel: b.endLabel,
    endRegion: b.endRegion,
    endPlace: b.endPlace,
    endLat: b.endLat,
    endLon: b.endLon,
    endBatteryLevel: b.endBatteryLevel,
  };
}

/**
 * The rows as the drives they were: exact duplicates dropped, and segments the
 * recorder split rejoined.
 *
 * Both shapes are real. An import replayed over live data wrote a batch of
 * drives twice under fresh ids, and each pair rendered as "stayed 0 s" at a
 * street the car passed once — with every leg and kilometre counted double. And
 * a drive the logger loses for a minute comes back as two rows, putting a stop
 * on the itinerary at a traffic light. Exported on its own because the window
 * totals have to be built from the same rows the grouping saw, or the distance
 * a duplicate added would come back as everyday driving.
 */
export function normalizeTripDrives(input: TripDrive[]): TripDrive[] {
  const sorted = [...input].sort((a, b) => a.startAt - b.startAt || a.id - b.id);

  // Dedupe first, as its own pass. Folding it into the merge loop compared each
  // row against the *joined* previous one, whose start had moved — so of a
  // twice-written batch of segments, every copy after the first merge slipped
  // through and the double-counting survived.
  const unique = sorted.filter((drive, i) => {
    const previous = sorted[i - 1];
    // The same drive twice: one car cannot start and end two drives on the same
    // two instants. Keep the first row; they carry the same figures.
    return !(previous != null && previous.startAt === drive.startAt && previous.endAt === drive.endAt);
  });

  const drives: TripDrive[] = [];
  for (const drive of unique) {
    const previous = drives[drives.length - 1];
    // Measured from the furthest end seen, like `endOf`: an overlapping row that
    // is not an exact duplicate must not be folded in, or its distance would be
    // counted on top of the drive it overlaps.
    const gap = previous == null ? NaN : drive.startAt - Math.max(previous.endAt, previous.startAt);
    if (previous != null && gap >= 0 && gap < SEGMENT_GAP_MS) {
      drives[drives.length - 1] = joined(previous, drive);
    } else {
      drives.push(drive);
    }
  }
  return drives;
}

function isKnown(place: TripPlace | null): place is TripPlace {
  return place != null && (place.geofence != null || place.address != null);
}

/** The same ground under the wheels, whichever of its two names resolved today. */
function samePlace(a: TripPlace, b: TripPlace): boolean {
  return (a.geofence != null && a.geofence === b.geofence) || (a.address != null && a.address === b.address);
}

/**
 * Where the run started from, for rule 1.
 *
 * First choice is where the car was *parked* when the run began — the end of the
 * drive before it, which is the stop the previous boundary was drawn across. Not
 * the opening drive's own start place: short hops go unrecorded (sentry off, a
 * fix found mid-street), so a run can open with a drive that starts a kilometre
 * from where the car was left. Taking that stray point as the origin produced a
 * journey whose home was a kindergarten forecourt, which the car never "returned"
 * to — so rule 1 went dead and a week of school runs glued into one open trip.
 *
 * With no drive before it (the edge of what was read), the opening drive's start
 * place, and failing that the place it *ended* — which is where the next drive
 * leaves from, so it is the place a return would come back to.
 */
function originOf(parkedAt: TripPlace | null, first: TripDrive): TripPlace | null {
  return [parkedAt, first.startPlace, first.endPlace].find(isKnown) ?? null;
}

/** A drive row's furthest instant. Clamped to the start, because `drives` has no
 * CHECK forcing end >= start, so a backwards row is storable — one would otherwise
 * read as a gap of days and split a journey into singletons. */
function endOf(drive: TripDrive): number {
  return Math.max(drive.endAt, drive.startAt);
}

/**
 * The drive the car was last seen moving in — the one whose end is furthest, not
 * the last row. Two rows can overlap (an import replaying over live data, or a
 * session recorded twice), and the overlapping one both rewinds the clock and lies
 * about where the car ended up: measuring the stop's *place* from the last row
 * while its *length* came from the furthest end drew a boundary at a place the
 * car had left hours ago.
 */
function lastDrive(run: TripDrive[]): TripDrive {
  return run.reduce((furthest, drive) => (endOf(drive) >= endOf(furthest) ? drive : furthest));
}

function isBoundary(run: TripDrive[], origin: TripPlace | null, nextAt: number, opts: TripOptions): boolean {
  if (run.length === 0) return false;

  const previous = lastDrive(run);
  const gap = nextAt - endOf(previous);
  if (gap >= opts.longStopMs) return true;

  return origin != null && samePlace(previous.endPlace, origin) && gap >= opts.returnStopMs;
}

function qualifies(run: TripDrive[], opts: TripOptions): boolean {
  if (run.length < opts.minDrives) return false;
  return (total(run.map((drive) => drive.distanceKm)) ?? 0) >= opts.minDistanceKm;
}

/**
 * Group drives into the journeys they belong to. Runs that are not trips are
 * dropped rather than returned with a flag, because there is nothing to show for an
 * errand.
 *
 * The input is sorted and normalized here rather than assumed clean: this module
 * is documented as usable on its own, and out-of-order drives produced a run whose
 * end preceded its own start, which every window filter downstream then read
 * wrongly. Normalizing twice costs nothing — a caller that already did it for its
 * own totals hands in rows the second pass leaves alone.
 */
export function detectTrips(input: TripDrive[], opts: TripOptions): TripRun[] {
  const drives = normalizeTripDrives(input);
  const runs: { origin: TripPlace | null; drives: TripDrive[] }[] = [];
  let current: TripDrive[] = [];
  let origin: TripPlace | null = null;
  // Where the car stood before the current run began — carried across the
  // boundary so `originOf` can prefer it over the opening drive's start.
  let parkedAt: TripPlace | null = null;

  for (const drive of drives) {
    if (current.length > 0 && isBoundary(current, origin, drive.startAt, opts)) {
      runs.push({ origin, drives: current });
      parkedAt = lastDrive(current).endPlace;
      current = [];
    }
    if (current.length === 0) origin = originOf(parkedAt, drive);
    current.push(drive);
  }
  if (current.length > 0) runs.push({ origin, drives: current });

  return runs
    .filter((run) => qualifies(run.drives, opts))
    // The trailing gap is measured against now, so a run that ended last month is
    // closed by rule 2 without anything having to follow it.
    .map((run) => ({ drives: run.drives, closed: isBoundary(run.drives, run.origin, opts.now, opts) }));
}
