/**
 * Y-axis scales for the charts. Recharts' own runs from zero to exactly the largest
 * sample, which squashes a series living in a narrow band — a battery between 48 and
 * 75% — into the top third of the panel and presses its peak flat against the
 * ceiling. These give every series its own range with room at both ends, and let two
 * series with nothing in common but an x-axis be read against opposite sides.
 */

/** Tick steps a reader can do arithmetic on, one decade's worth. */
const STEPS = [1, 2, 2.5, 5, 10];

/** The smallest of those steps that is at least `raw`. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / magnitude;
  return (STEPS.find((step) => step >= scaled - 1e-9) ?? 10) * magnitude;
}

const exact = (value: number) => Number(value.toPrecision(12));

/**
 * The range a series should be read against: its own, plus a tenth of its span at
 * each end. The padding never crosses a bound the quantity itself cannot — no
 * negative kilowatt-hours below, no 110% battery above — because that would be a
 * claim about the data rather than about spacing.
 */
export function paddedBounds(values: number[], limit: [number, number]): [number, number] | undefined {
  if (values.length === 0) return undefined;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  // A single sample, or a series that never moved, still needs a band to sit in.
  const pad = span > 0 ? span * 0.1 : Math.max(Math.abs(high) * 0.1, 1);
  return [Math.max(limit[0], low - pad), Math.min(limit[1], high + pad)];
}

/** Those bounds rounded out to whole steps, in exactly `intervals` of them. */
export function roundedDomain([min, max]: [number, number], intervals: number): [number, number] {
  let step = niceStep((max - min) / intervals);
  let from = Math.floor(min / step) * step;
  // Rounding the start down can leave the top short of the data; widen the step
  // until the intervals cover it rather than settling for a clipped line.
  while (from + step * intervals < max) {
    step = niceStep(step * 1.0001);
    from = Math.floor(min / step) * step;
  }
  return [exact(from), exact(from + step * intervals)];
}

/**
 * The tick at every step of the domain. Given only a domain and a count recharts
 * rounds to its own idea of a nice number — 2.5 to 12.5 comes back as 2.5, 5.5,
 * 8.5 — which lands the two axes on different heights and leaves the right one
 * floating between the gridlines.
 */
export function ticksFor([from, to]: [number, number], intervals: number): number[] {
  const step = (to - from) / intervals;
  return Array.from({ length: intervals + 1 }, (_, index) => exact(from + step * index));
}

/**
 * How many intervals every axis on a chart is divided into. One count for all of
 * them, because ticks are spaced evenly: same count, same gridlines, and the right
 * axis reads against the same horizontal rules as the left. Whichever count leaves
 * the worst-fitting axis using the most of its height wins — rounding to nice steps
 * can otherwise leave a line sitting in half the panel.
 */
export function sharedIntervals(bounds: [number, number][]): number {
  let best = 5;
  let bestFill = -1;
  for (const intervals of [4, 5, 6]) {
    const fill = Math.min(
      ...bounds.map(([min, max]) => {
        const [from, to] = roundedDomain([min, max], intervals);
        return to > from ? (max - min) / (to - from) : 0;
      }),
    );
    if (fill > bestFill + 1e-9) {
      bestFill = fill;
      best = intervals;
    }
  }
  return best;
}

/**
 * Below this a tick is written out in full: four digits fit the axis, and a count
 * of 2500 reads better as itself than as 2.5K.
 */
const COMPACT_FROM = 10_000;

/** The most fraction digits a tick is given before the axis is left to recharts. */
const MAX_DIGITS = 4;

/**
 * The notation to write an axis's ticks in, with `digits` after the point —
 * at most that many, or exactly that many once `padded`.
 *
 * Large ticks are compact: the reader's own notation where it shortens thousands to
 * a mark of a character or two (K, k, 万, tn), English where it does not. German
 * only abbreviates from a million up — its 120'500 is wider than the bare number it
 * replaces — and Swiss German's 120.5 Tsg. is no better.
 *
 * Small ones are the reader's own decimals, ungrouped: 2'500 is wider than 2500,
 * and four digits are as far as a tick goes before it turns compact.
 */
function axisFormat(locale: string | undefined, compact: boolean, digits: number, padded = false): Intl.NumberFormat {
  const options: Intl.NumberFormatOptions = {
    maximumFractionDigits: digits,
    ...(padded ? { minimumFractionDigits: digits } : {}),
    ...(compact ? { notation: "compact" } : { useGrouping: false }),
  };
  const own = new Intl.NumberFormat(locale, options);
  if (!compact) return own;
  const mark = own.formatToParts(COMPACT_FROM).find((part) => part.type === "compact");
  const shortens = mark != null && mark.value.trim().length <= 2;
  return shortens ? own : new Intl.NumberFormat("en", options);
}

/**
 * How an axis writes its ticks. Two rules, both about reading the column of labels
 * as one scale (§3.8 of docs/architecture.md):
 *
 * - **Every tick carries the same number of decimals**, the fewest that write all of
 *   them exactly: 70.0, 72.5, 75.0 — never 70, 72.5, 75 — and 120.5K, never 121K,
 *   because a tick is a reading and a rounded one is a wrong one. Whole steps stay
 *   whole: 140, 160, 180.
 * - **Five digits and more are compact**: 120.5K for 120500. The axis keeps one width
 *   for every chart so stacked charts line up, and a six-digit odometer reading in a
 *   proportional font does not fit it — the leading digit is clipped and the reading
 *   silently drops by a hundred thousand.
 *
 * Undefined leaves the ticks to recharts when even the most precise labels would
 * write two of them the same.
 */
export function tickFormatter(ticks: number[], locale?: string): ((value: number) => string) | undefined {
  if (ticks.length === 0) return undefined;
  const compact = Math.max(...ticks.map(Math.abs)) >= COMPACT_FROM;
  const precise = axisFormat(locale, compact, MAX_DIGITS);
  const exact = ticks.map((tick) => precise.format(tick));
  if (new Set(exact).size !== ticks.length) return undefined;
  let digits = 0;
  while (digits < MAX_DIGITS) {
    const format = axisFormat(locale, compact, digits);
    if (ticks.every((tick, index) => format.format(tick) === exact[index])) break;
    digits++;
  }
  const padded = axisFormat(locale, compact, digits, true);
  return (value) => padded.format(value);
}
