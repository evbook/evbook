/**
 * Geofence matching without PostGIS. TeslaMate uses Postgres `earthdistance`
 * (`earth_box` prefilter + `earth_distance` exact test); we use a bounding-box
 * prefilter plus an exact haversine distance, and the nearest match wins.
 */

const EARTH_RADIUS_M = 6_371_008.8;

export interface GeofenceLike {
  id: number;
  latitude: number;
  longitude: number;
  /** Metres. */
  radius: number;
}

export interface Point {
  latitude: number | null;
  longitude: number | null;
}

/** Great-circle distance in metres. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Degrees of latitude/longitude covering `radius` metres at a given latitude. */
export function boundingBox(latitude: number, longitude: number, radiusM: number) {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cos = Math.cos((latitude * Math.PI) / 180);
  // Near the poles longitude degrees collapse; fall back to the whole range.
  const lonDelta = Math.abs(cos) < 1e-6 ? 180 : latDelta / Math.abs(cos);
  return {
    minLat: latitude - latDelta,
    maxLat: latitude + latDelta,
    minLon: longitude - lonDelta,
    maxLon: longitude + lonDelta,
  };
}

/** Nearest geofence containing the point, or null. */
export function findGeofence(point: Point, geofences: GeofenceLike[]): GeofenceLike | null {
  const { latitude, longitude } = point;
  if (latitude == null || longitude == null) return null;

  let best: GeofenceLike | null = null;
  let bestDistance = Infinity;
  for (const g of geofences) {
    const box = boundingBox(g.latitude, g.longitude, g.radius);
    if (latitude < box.minLat || latitude > box.maxLat) continue;
    if (longitude < box.minLon || longitude > box.maxLon) continue;
    const distance = haversineMeters(g.latitude, g.longitude, latitude, longitude);
    if (distance < g.radius && distance < bestDistance) {
      best = g;
      bestDistance = distance;
    }
  }
  return best;
}
