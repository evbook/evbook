import { haversineMeters } from "../../src/core/geo/geofence";

/** A place on the route the cursor marker can stand, and which way it faces. */
export interface RouteCursor {
  latitude: number;
  longitude: number;
  /**
   * Compass bearing of travel in degrees, 0 = north, 90 = east. Null when there is
   * nothing to read a direction from — a drive whose every sample sits on one spot.
   */
  headingDeg: number | null;
}

type MaybePoint = { latitude: number | null; longitude: number | null };
type Point = { latitude: number; longitude: number };

const RAD = Math.PI / 180;

/**
 * Initial great-circle bearing from `a` towards `b`, in compass degrees. Over the
 * few seconds between two drive samples it *is* the direction of travel; the
 * "initial" caveat only matters over distances no two samples are apart.
 */
export function bearingDeg(a: Point, b: Point): number {
  const dLon = (b.longitude - a.longitude) * RAD;
  const y = Math.sin(dLon) * Math.cos(b.latitude * RAD);
  const x =
    Math.cos(a.latitude * RAD) * Math.sin(b.latitude * RAD) -
    Math.sin(a.latitude * RAD) * Math.cos(b.latitude * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/**
 * Where the cursor marker sits and points for the sample at `index` — the bridge
 * from a hovered chart row to a spot on the route map.
 *
 * The samples carry no heading of their own (imported history never will), so the
 * direction is read off the track: the bearing towards the next sample that is
 * somewhere else. A car stopped at a light keeps pointing the way it will leave,
 * and the last sample of the drive — with nothing ahead of it — falls back to the
 * direction it arrived from. Null when the hovered sample has no fix at all:
 * standing the marker on a neighbour's coordinates would draw the car where it
 * wasn't.
 */
export function routeCursorAt(points: MaybePoint[], index: number): RouteCursor | null {
  const p = points[index];
  if (p?.latitude == null || p.longitude == null) return null;
  const here = { latitude: p.latitude, longitude: p.longitude };
  const moved = (q: MaybePoint | undefined): q is Point =>
    q?.latitude != null && q.longitude != null && (q.latitude !== here.latitude || q.longitude !== here.longitude);

  for (let i = index + 1; i < points.length; i++) {
    if (moved(points[i])) return { ...here, headingDeg: bearingDeg(here, points[i] as Point) };
  }
  for (let i = index - 1; i >= 0; i--) {
    if (moved(points[i])) return { ...here, headingDeg: bearingDeg(points[i] as Point, here) };
  }
  return { ...here, headingDeg: null };
}

/**
 * How long a position may go unrefreshed before the next one is a guess. Teslas
 * report every few seconds while driving and a Pleos car about every minute or
 * two; a Volvo refreshes its position about every five minutes, if at all.
 */
export const UNRECORDED_AFTER_MS = 3 * 60_000;

/**
 * How far the car must have moved across such a wait for the straight line to
 * matter. Without it, the few metres after a long red light would be dashed.
 */
export const UNRECORDED_BEYOND_M = 250;

type TimedPoint = Point & { at: number };

/** A run of the track that is either recorded or a straight line across a gap. */
export interface TrackStretch<P extends TimedPoint> {
  /** False where the car reported no position on the way: the line is a guess. */
  recorded: boolean;
  points: P[];
}

/**
 * The track cut into what was recorded and what was not.
 *
 * A jump counts as unrecorded when the car sat on the previous spot for longer
 * than `UNRECORDED_AFTER_MS` — measured from when that spot was *first* seen,
 * because a car polled every minute that answers the same stale position five
 * times has not been seen moving in between — and it lands further away than
 * `UNRECORDED_BEYOND_M`. This reads the samples, not the make: a Volvo that sent
 * nothing between start and end, one that did every five minutes, and a Tesla
 * that lost signal in a tunnel are all told apart by the same rule.
 */
export function trackStretches<P extends TimedPoint>(points: readonly P[]): TrackStretch<P>[] {
  const stretches: TrackStretch<P>[] = [];
  let heldSince = points[0]?.at ?? 0;
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const moved = from.latitude !== to.latitude || from.longitude !== to.longitude;
    const recorded =
      !moved ||
      to.at - heldSince <= UNRECORDED_AFTER_MS ||
      haversineMeters(from.latitude, from.longitude, to.latitude, to.longitude) <= UNRECORDED_BEYOND_M;
    if (moved) heldSince = to.at;
    const last = stretches[stretches.length - 1];
    if (last?.recorded === recorded) last.points.push(to);
    else stretches.push({ recorded, points: [from, to] });
  }
  return stretches;
}

/**
 * How much of the way between start and end the car reported: all of it, some
 * of it (stretches are dashed), or none — two places and a straight line between
 * them, which is not a route and is no use as one in a GPX file.
 */
export function routeCoverage(stretches: readonly TrackStretch<TimedPoint>[]): "full" | "partial" | "none" {
  if (stretches.every((s) => s.recorded)) return "full";
  const places = new Set(stretches.flatMap((s) => s.points.map((p) => `${p.latitude},${p.longitude}`)));
  return places.size <= 2 ? "none" : "partial";
}
