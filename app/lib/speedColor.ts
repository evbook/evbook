/**
 * The colour of a speed, for the route on the drive detail map: the slower the
 * bluer, the faster the redder.
 *
 * The scale is fixed rather than stretched over each drive's own range, so red
 * means the same thing on every map — a run to the shops that tops out at 50 is
 * not painted like a stretch of motorway just because 50 was its fastest.
 */

/** Where the scale stops rising; anything faster is the same red. */
export const SPEED_SCALE_TOP_KMH = 120;

/** A stretch whose speed nobody read. */
export const SPEED_UNKNOWN_COLOR = "#868e96";

const STOPS: [at: number, r: number, g: number, b: number][] = [
  [0, 59, 91, 219],
  [0.25, 21, 170, 191],
  [0.45, 47, 158, 68],
  [0.65, 245, 159, 0],
  [0.82, 247, 103, 7],
  [1, 224, 49, 49],
];

/**
 * How many colours the scale is cut into. Neighbouring samples a few km/h apart
 * then share one, and the route is drawn as a few dozen runs rather than as one
 * line per sample.
 */
const STEPS = 26;

const hex = (value: number) => Math.round(value).toString(16).padStart(2, "0");

/** The colour at a point of the scale, 0 (standing) to 1 (the top of it). */
function colorAt(position: number): string {
  let upper = STOPS.findIndex((stop) => stop[0] >= position);
  if (upper <= 0) upper = 1;
  const a = STOPS[upper - 1]!;
  const b = STOPS[upper]!;
  const t = (position - a[0]) / (b[0] - a[0]);
  return `#${hex(a[1] + (b[1] - a[1]) * t)}${hex(a[2] + (b[2] - a[2]) * t)}${hex(a[3] + (b[3] - a[3]) * t)}`;
}

/** The colour a speed is drawn in. */
export function speedColor(kmh: number | null): string {
  if (kmh == null) return SPEED_UNKNOWN_COLOR;
  const position = Math.max(0, Math.min(1, kmh / SPEED_SCALE_TOP_KMH));
  return colorAt(Math.round(position * STEPS) / STEPS);
}

/** The scale as a CSS gradient, for the legend. */
export const SPEED_GRADIENT = `linear-gradient(to right, ${STOPS.map(
  ([at]) => `${colorAt(at)} ${Math.round(at * 100)}%`,
).join(", ")})`;

interface Sample {
  latitude: number;
  longitude: number;
  speedKmh: number | null;
}

/** A stretch of the route drawn in one colour. */
export interface SpeedRun {
  color: string;
  coords: [number, number][];
}

/**
 * The route cut into stretches of one colour each. A segment takes the mean of
 * the speeds at its two ends — the car was doing neither for the whole of it —
 * or the one that is known; neighbouring segments of the same colour join into
 * one run, and each run starts on the last point of the one before, so the line
 * has no gaps.
 */
export function speedRuns(samples: readonly Sample[]): SpeedRun[] {
  const runs: SpeedRun[] = [];
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1]!;
    const to = samples[i]!;
    const speed =
      from.speedKmh != null && to.speedKmh != null ? (from.speedKmh + to.speedKmh) / 2 : (from.speedKmh ?? to.speedKmh);
    const color = speedColor(speed);
    const last = runs[runs.length - 1];
    if (last?.color === color) last.coords.push([to.latitude, to.longitude]);
    else {
      runs.push({
        color,
        coords: [
          [from.latitude, from.longitude],
          [to.latitude, to.longitude],
        ],
      });
    }
  }
  return runs;
}
