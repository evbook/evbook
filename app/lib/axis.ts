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

/**
 * The compact notation to write ticks in: the reader's own where it shortens
 * thousands, English where it does not. German and Swiss German only abbreviate from
 * a million up — their 120'500 is wider than the bare number it replaces.
 */
function compactFormat(locale: string | undefined, digits: number): Intl.NumberFormat {
  const options: Intl.NumberFormatOptions = { notation: "compact", maximumFractionDigits: digits };
  const own = new Intl.NumberFormat(locale, options);
  const shortens = own.formatToParts(COMPACT_FROM).some((part) => part.type === "compact");
  return shortens ? own : new Intl.NumberFormat("en", options);
}

/**
 * How an axis writes its ticks: `120.5K` for 120500. The axis keeps one width for
 * every chart so stacked charts line up, and a six-digit odometer reading in a
 * proportional font does not fit it — the leading digit is clipped and the reading
 * silently drops by a hundred thousand. Compact labels are short enough and quicker
 * to read than six digits.
 *
 * Fraction digits are added until no tick is rounded: 120500 is 120.5K, never
 * 121K, because a tick is a reading and a rounded one is a wrong one. Undefined
 * leaves the ticks to recharts, as before, when they are small enough to fit, or
 * when even the most precise compact labels would round two of them together.
 */
export function tickFormatter(ticks: number[], locale?: string): ((value: number) => string) | undefined {
  if (ticks.length === 0 || Math.max(...ticks.map(Math.abs)) < COMPACT_FROM) return undefined;
  const MAX_DIGITS = 3;
  const precise = compactFormat(locale, MAX_DIGITS);
  const exact = ticks.map((tick) => precise.format(tick));
  if (new Set(exact).size !== ticks.length) return undefined;
  for (let digits = 0; digits < MAX_DIGITS; digits++) {
    const format = compactFormat(locale, digits);
    if (ticks.every((tick, index) => format.format(tick) === exact[index])) {
      return (value) => format.format(value);
    }
  }
  return (value) => precise.format(value);
}
