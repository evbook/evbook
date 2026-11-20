/**
 * A timed track as text: the encoded polyline format (five decimals, about a
 * metre) for the points, and the same step encoding for the clock along them,
 * in tenths of a second. Kept dependency-free — the VPS seeds with node
 * builtins only — and separate from shared/polyline.ts, which is TypeScript
 * and drops repeated points (a track cannot: each point has its own time).
 */

function encodeStep(step) {
  let value = step < 0 ? ~(step << 1) : step << 1;
  let out = "";
  while (value >= 0x20) {
    out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }
  return out + String.fromCharCode(value + 63);
}

function decodeSteps(encoded) {
  const values = [];
  let index = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let chunk;
    do {
      chunk = encoded.charCodeAt(index++) - 63;
      result |= (chunk & 0x1f) << shift;
      shift += 5;
    } while (chunk >= 0x20);
    values.push(result & 1 ? ~(result >> 1) : result >> 1);
  }
  return values;
}

/** [[lat, lon, seconds]] → { polyline, clock } */
export function encodeTrack(points) {
  let polyline = "";
  let clock = "";
  let lastLat = 0;
  let lastLon = 0;
  let lastT = 0;
  for (const [lat, lon, t] of points) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    const tt = Math.round(t * 10);
    polyline += encodeStep(la - lastLat) + encodeStep(lo - lastLon);
    clock += encodeStep(tt - lastT);
    lastLat = la;
    lastLon = lo;
    lastT = tt;
  }
  return { polyline, clock };
}

/** { polyline, clock } → [[lat, lon, seconds]] */
export function decodeTrack({ polyline, clock }) {
  const coords = decodeSteps(polyline);
  const times = decodeSteps(clock);
  const points = [];
  let lat = 0;
  let lon = 0;
  let t = 0;
  for (let i = 0; i < times.length; i++) {
    lat += coords[2 * i];
    lon += coords[2 * i + 1];
    t += times[i];
    points.push([lat / 1e5, lon / 1e5, t / 10]);
  }
  return points;
}
