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
