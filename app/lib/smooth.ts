/**
 * The trend under a noisy measurement. Usable capacity is never read off the pack —
 * it is fitted from whichever charging sessions happened to be logged, so a cold
 * morning or a session that stopped a percent early moves an estimate by a
 * kilowatt-hour in either direction. Joining those estimates point to point draws
 * every one of those wobbles as if the battery were ageing and un-ageing week by
 * week, which is not a thing packs do.
 *
 * So the line the eye follows is a fit, and the samples stay on the chart behind it.
 */

/**
 * Roughly how many samples each fit leans on. A count rather than a share of the
 * axis, because what a window has to cancel is measurement error, and how much of
 * that a stretch of axis holds depends on how many sessions were logged along it. A
 * fixed share of a three-year axis is a fortnight on a car that charges rarely and a
 * season on one that charges nightly — and a window a season wide takes the seasons
 * out, which is the one thing this chart is worth reading for.
 *
 * Ten is about where the jitter stops reading as a signal, and the fit still turns
 * inside a winter.
 */
const NEIGHBOURS = 10;

/**
 * However few samples there are, the window stops here. A fit leaning on most of the
 * axis at once is one straight line with a bend, and it would report that whatever
 * the samples did.
 */
const WIDEST = 0.3;

/**
 * Below this there is no trend to speak of, only points — and a fit through four
 * samples mostly draws the four samples, with a confident-looking line implying
 * more than they say.
 */
const MIN_SAMPLES = 5;

/** The middle value, or zero when there is nothing to take the middle of. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

interface Sample {
  x: number;
  y: number;
}

/**
 * A straight line fitted to the samples *around* `x`, weighted by how near they are,
 * and read off at `x` itself.
 *
 * Weighting by distance rather than by count is what lets an axis with a three-month
 * hole in it stay honest: a fit has as much to say about a stretch as there are
 * samples in it. Fitting a slope rather than averaging is what keeps the ends
 * usable — an average only has samples on one side there, so it bends the line flat
 * exactly where the reader is looking for today's capacity.
 */
function fitAt(sample: Sample[], weights: number[], x: number, width: number): number | null {
  // Everything is accumulated relative to x, in bandwidths. Absolute x here can be
  // an epoch second, and summing its square loses the precision the fit is made of.
  let sw = 0;
  let st = 0;
  let sy = 0;
  let stt = 0;
  let sty = 0;
  for (let i = 0; i < sample.length; i++) {
    const t = (sample[i]!.x - x) / width;
    const w = Math.exp(-0.5 * t * t) * weights[i]!;
    if (!(w > 0)) continue;
    const y = sample[i]!.y;
    sw += w;
    st += w * t;
    sy += w * y;
    stt += w * t * t;
    sty += w * t * y;
  }
  if (!(sw > 0)) return null;
  const meanT = st / sw;
  const meanY = sy / sw;
  const varT = stt / sw - meanT * meanT;
  const covTY = sty / sw - meanT * meanY;
  // A neighbourhood that is one x repeated has a level but no slope to speak of.
  const slope = varT > 1e-12 ? covTY / varT : 0;
  return meanY + slope * (0 - meanT);
}

/**
 * The fitted value at every x. Nulls in `ys` are gaps to be filled from the
 * neighbours rather than holes in the line, and an x that is not a number gets
 * nothing — there is nowhere to put it.
 *
 * Returns all nulls when there is too little to fit, which draws no line at all:
 * better than a fit that is really just the samples with a smooth name.
 */
export function trendLine(xs: number[], ys: (number | null)[], neighbours = NEIGHBOURS): (number | null)[] {
  const sample: Sample[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const y = ys[i];
    if (Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) sample.push({ x, y });
  }
  if (sample.length < MIN_SAMPLES) return xs.map(() => null);

  let low = Infinity;
  let high = -Infinity;
  for (const point of sample) {
    low = Math.min(low, point.x);
    high = Math.max(high, point.x);
  }
  // Samples into a share of the axis: as many of them as `neighbours` asks for, on
  // average, which is exact where they are evenly spread and about right where they
  // are not — a cluster gets a fit with more to go on, which is what a cluster is.
  const width = (high - low) * Math.min(WIDEST, neighbours / sample.length);
  // Everything measured at the same instant is one reading, however many rows it is.
  if (!(width > 0)) return xs.map(() => null);

  const weights = sample.map(() => 1);
  /*
    A single session that came out a kilowatt-hour high is not evidence of anything,
    but it pulls an ordinary fit toward itself in proportion to how wrong it is — the
    worse the sample, the more of the line it owns. Refitting with each sample
    discounted by its own residual takes that back: six times the typical miss is
    where a point stops counting, which is the usual bisquare cut.

    Twice, because one pass measures the residual against a line the outlier has
    already bent. At the end of a series, where there are only samples on one side to
    argue with it, that first line can be dragged far enough that the outlier looks
    ordinary and keeps its weight — and the end of the line is the part being read.
  */
  for (let pass = 0; pass < 2; pass++) {
    const fitted = sample.map((point) => fitAt(sample, weights, point.x, width) ?? point.y);
    const residuals = sample.map((point, index) => Math.abs(point.y - fitted[index]!));
    const scale = median(residuals) * 6;
    // Nothing missed the line, or half the samples are on it: no one to discount.
    if (!(scale > 0)) break;
    for (let i = 0; i < sample.length; i++) {
      const miss = residuals[i]! / scale;
      weights[i] = miss >= 1 ? 0 : (1 - miss * miss) ** 2;
    }
  }

  return xs.map((x) => (Number.isFinite(x) ? fitAt(sample, weights, x, width) : null));
}
