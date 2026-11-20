/**
 * Tracks as text: the encoded polyline format map services use, at five decimals
 * (about a metre). A point costs the few characters its step from the one before
 * takes, rather than the twenty a pair of JSON numbers does — which is the whole
 * difference between a density map of a year of drives being a quick answer and
 * being most of a megabyte.
 */

const PRECISION = 1e5;

export type LatLng = [latitude: number, longitude: number];

function encodeStep(step: number): string {
  // Zigzag, so a small step either way is a small number, then five bits a character.
  let value = step < 0 ? ~(step << 1) : step << 1;
  let out = "";
  while (value >= 0x20) {
    out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  return out + String.fromCharCode(value + 63);
}

/**
 * Encodes a track. Consecutive points that round to the same spot are written
 * once: a car waiting at a light logs the same metre a dozen times over.
 */
export function encodePolyline(points: readonly LatLng[]): string {
  let out = "";
  let lastLat = 0;
  let lastLng = 0;
  let first = true;
  for (const [latitude, longitude] of points) {
    const lat = Math.round(latitude * PRECISION);
    const lng = Math.round(longitude * PRECISION);
    if (!first && lat === lastLat && lng === lastLng) continue;
    out += encodeStep(lat - lastLat) + encodeStep(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
    first = false;
  }
  return out;
}

/** The points of an encoded track. Stops at whatever is malformed rather than throwing. */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (index >= encoded.length) return null;
      const chunk = encoded.charCodeAt(index++) - 63;
      if (chunk < 0 || chunk > 0x3f) return null;
      result |= (chunk & 0x1f) << shift;
      shift += 5;
      if (chunk < 0x20) break;
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat == null || dLng == null) break;
    lat += dLat;
    lng += dLng;
    points.push([lat / PRECISION, lng / PRECISION]);
  }
  return points;
}
