import { decodePolyline } from "@shared/polyline";

/**
 * The density map's arithmetic, kept apart from Leaflet so it can be tested: how
 * many drives crossed each pixel, and what colour that many is.
 *
 * Tracks are held in Web Mercator "world" units — both axes 0 to 1 across the
 * whole map — which every zoom level is a plain multiple of.
 */

/** One drive's track, projected once, with the box it fits in. */
export interface DensityTrack {
  /** x, y pairs. */
  xy: Float64Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A rectangle of pixels over the world: where it starts, and how big a pixel is. */
export interface DensityView {
  /** World pixels across the whole map at this zoom and pixel density. */
  scale: number;
  /** The view's top-left corner, in those pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
}

const MAX_LATITUDE = 85.0511287798;

function worldX(longitude: number): number {
  return (longitude + 180) / 360;
}

function worldY(latitude: number): number {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

/** Decodes and projects the tracks the API sent. A track with no points is dropped. */
export function projectTracks(encoded: readonly string[]): DensityTrack[] {
  const tracks: DensityTrack[] = [];
  for (const text of encoded) {
    const points = decodePolyline(text);
    if (points.length === 0) continue;
    const xy = new Float64Array(points.length * 2);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach(([latitude, longitude], i) => {
      const x = worldX(longitude);
      const y = worldY(latitude);
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    tracks.push({ xy, minX, minY, maxX, maxY });
  }
  return tracks;
}

/** The latitude/longitude box around every track, or null when there are none. */
export function tracksBounds(
  tracks: readonly DensityTrack[],
): { south: number; west: number; north: number; east: number } | null {
  if (tracks.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const track of tracks) {
    if (track.minX < minX) minX = track.minX;
    if (track.maxX > maxX) maxX = track.maxX;
    if (track.minY < minY) minY = track.minY;
    if (track.maxY > maxY) maxY = track.maxY;
  }
  const latitude = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
  return { south: latitude(maxY), north: latitude(minY), west: minX * 360 - 180, east: maxX * 360 - 180 };
}

/**
 * How many drives crossed each pixel of the view. A drive counts once for a
 * pixel however often it passes through — out and back along the same street,
 * or a dozen samples at one junction — so the figure is drives, not samples.
 */
export function countDrives(tracks: readonly DensityTrack[], view: DensityView): Uint16Array {
  const { scale, left, top, width, height } = view;
  const counts = new Uint16Array(width * height);
  // Which track last marked each pixel, so no track marks one twice.
  const marked = new Int32Array(width * height);

  const x0 = left / scale;
  const y0 = top / scale;
  const x1 = (left + width) / scale;
  const y1 = (top + height) / scale;

  const mark = (px: number, py: number, id: number) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const at = py * width + px;
    if (marked[at] === id) return;
    marked[at] = id;
    if (counts[at]! < 0xffff) counts[at]!++;
  };

  tracks.forEach((track, index) => {
    if (track.maxX < x0 || track.minX > x1 || track.maxY < y0 || track.minY > y1) return;
    const id = index + 1;
    const { xy } = track;
    let ax = xy[0]! * scale - left;
    let ay = xy[1]! * scale - top;
    if (xy.length === 2) mark(Math.floor(ax), Math.floor(ay), id);

    for (let i = 2; i < xy.length; i += 2) {
      const bx = xy[i]! * scale - left;
      const by = xy[i + 1]! * scale - top;
      const dx = bx - ax;
      const dy = by - ay;

      // The stretch of this segment that lies inside the view (Liang–Barsky), so
      // a leg that crosses the country costs only the pixels of it that show.
      let from = 0;
      let to = 1;
      let inside = true;
      const clip = (p: number, q: number) => {
        if (p === 0) {
          if (q < 0) inside = false;
          return;
        }
        const t = q / p;
        if (p < 0) {
          if (t > from) from = t;
        } else if (t < to) to = t;
      };
      clip(-dx, ax);
      clip(dx, width - ax);
      clip(-dy, ay);
      clip(dy, height - ay);

      if (inside && from <= to) {
        // Stepped from the segment's own start, not from where it enters the
        // view: two neighbouring tiles then mark the very same pixels of it, and
        // the picture has no seam where they meet.
        // Always a little under a pixel a step: at exactly one, a rounding
        // error on a pixel's edge lands two steps in one pixel and none in the next.
        const steps = Math.floor(Math.max(Math.abs(dx), Math.abs(dy))) + 1;
        const first = Math.ceil(from * steps);
        const last = Math.floor(to * steps);
        for (let step = first; step <= last; step++) {
          const t = step / steps;
          mark(Math.floor(ax + dx * t), Math.floor(ay + dy * t), id);
        }
      }
      ax = bx;
      ay = by;
    }
  });

  return counts;
}

/** The busiest pixel of a count. */
export function peakOf(counts: Uint16Array): number {
  let peak = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i]! > peak) peak = counts[i]!;
  return peak;
}

/** What a road driven once is drawn at: dim, but plainly there. */
const ONCE = 0.36;

/**
 * The fewest drives the top of the scale may stand for. Without it a selection
 * of two drives would paint the one street they share white-hot.
 */
const MIN_PEAK = 6;

/**
 * How hot a count is, 0 to 1. Logarithmic, because the counts are: the road out
 * of the garage is on every drive and a holiday route on one, and a linear scale
 * would show the first and nothing else.
 */
export function heatOf(count: number, peak: number): number {
  if (count <= 0) return 0;
  const top = Math.log(Math.max(peak, MIN_PEAK));
  return Math.min(1, ONCE + (1 - ONCE) * (Math.log(count) / top));
}

/** Dark red through orange to near white, with the faint end see-through. */
const STOPS: [at: number, r: number, g: number, b: number, a: number][] = [
  [0, 120, 20, 40, 0],
  [0.12, 140, 22, 44, 0.3],
  [0.36, 214, 40, 40, 0.82],
  [0.6, 250, 110, 24, 0.95],
  [0.82, 255, 200, 60, 1],
  [1, 255, 252, 226, 1],
];

/** The colour scale as 256 RGBA entries. */
export const HEAT_PALETTE: Uint8ClampedArray = (() => {
  const palette = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const at = i / 255;
    let upper = STOPS.findIndex((stop) => stop[0] >= at);
    if (upper <= 0) upper = 1;
    const a = STOPS[upper - 1]!;
    const b = STOPS[upper]!;
    const t = (at - a[0]) / (b[0] - a[0]);
    palette[i * 4] = a[1] + (b[1] - a[1]) * t;
    palette[i * 4 + 1] = a[2] + (b[2] - a[2]) * t;
    palette[i * 4 + 2] = a[3] + (b[3] - a[3]) * t;
    palette[i * 4 + 3] = (a[4] + (b[4] - a[4]) * t) * 255;
  }
  return palette;
})();

/** Each pixel becomes the largest value within `radius` of it along one axis. */
function widen(source: Float32Array, width: number, height: number, radius: number, vertical: boolean): Float32Array {
  const out = new Float32Array(source.length);
  const stride = vertical ? width : 1;
  const length = vertical ? height : width;
  const lines = vertical ? width : height;
  for (let line = 0; line < lines; line++) {
    const base = vertical ? line : line * width;
    for (let i = 0; i < length; i++) {
      let best = 0;
      const lo = Math.max(0, i - radius);
      const hi = Math.min(length - 1, i + radius);
      for (let j = lo; j <= hi; j++) {
        const value = source[base + j * stride]!;
        if (value > best) best = value;
      }
      out[base + i * stride] = best;
    }
  }
  return out;
}

/** Each pixel becomes the mean of those within `radius` of it along one axis. */
function soften(source: Float32Array, width: number, height: number, radius: number, vertical: boolean): Float32Array {
  const out = new Float32Array(source.length);
  const stride = vertical ? width : 1;
  const length = vertical ? height : width;
  const lines = vertical ? width : height;
  const span = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const base = vertical ? line : line * width;
    let sum = 0;
    for (let j = 0; j <= Math.min(radius, length - 1); j++) sum += source[base + j * stride]!;
    for (let i = 0; i < length; i++) {
      out[base + i * stride] = sum / span;
      const entering = i + radius + 1;
      const leaving = i - radius;
      if (entering < length) sum += source[base + entering * stride]!;
      if (leaving >= 0) sum -= source[base + leaving * stride]!;
    }
  }
  return out;
}

/**
 * A diagonal line comes out of the softening a little under the heat it went in
 * with, where a level one keeps all of it; this evens the two out.
 */
const GAIN = 1.12;

/**
 * The picture of a count: RGBA, one pixel per count. A track one pixel wide is
 * widened to `radius` either side and then softened by the same amount, which
 * leaves the middle of a road at its full heat and lets it fall away through
 * the dim end of the scale — the glow, and the smooth edge a line stepped out
 * pixel by pixel does not have on its own.
 */
export function heatImage(
  counts: Uint16Array,
  width: number,
  height: number,
  peak: number,
  radius: number,
): Uint8ClampedArray {
  let heat: Float32Array = new Float32Array(counts.length);
  for (let i = 0; i < counts.length; i++) heat[i] = heatOf(counts[i]!, peak);

  heat = widen(heat, width, height, radius, false);
  heat = widen(heat, width, height, radius, true);
  heat = soften(heat, width, height, radius, false);
  heat = soften(heat, width, height, radius, true);

  const image = new Uint8ClampedArray(counts.length * 4);
  for (let i = 0; i < heat.length; i++) {
    const value = heat[i]! * GAIN;
    const entry = Math.min(255, Math.round(value * 255)) * 4;
    image[i * 4] = HEAT_PALETTE[entry]!;
    image[i * 4 + 1] = HEAT_PALETTE[entry + 1]!;
    image[i * 4 + 2] = HEAT_PALETTE[entry + 2]!;
    image[i * 4 + 3] = HEAT_PALETTE[entry + 3]!;
  }
  return image;
}
