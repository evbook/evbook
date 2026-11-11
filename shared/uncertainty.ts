/**
 * What polling can and cannot know about when something happened.
 *
 * A poller never sees a transition, only readings either side of it. Each end of
 * a drive or a charge is therefore a span: it happened no earlier than `after`
 * and no later than `before`. The server reports spans as recorded; this module
 * is the one place that decides when a span is tight enough to read as a single
 * time, so the list, the detail page and the log agree on it.
 */

/** No earlier than `after`, no later than `before` (epoch ms, `after < before`). */
export interface TimeSpan {
  after: number;
  before: number;
}

/** A quantity known only to lie between two values; `min < max`. */
export interface NumberRange {
  min: number;
  max: number;
}

/**
 * Spans this narrow read as one time. Two readings two minutes apart are what a
 * parked car's probe cadence and the wake guard leave between them anyway, and
 * a range like "07:08–07:09" says less than "07:09" while looking more precise.
 */
export const COLLAPSE_MS = 2 * 60_000;

/**
 * The span an end of an event lies in, from its point estimate and the stored
 * bounds (NULL meaning "the point itself"). Null when there is nothing to say
 * beyond the point — no bounds, or bounds that coincide with it.
 */
export function spanOf(
  at: number | null | undefined,
  after: number | null | undefined,
  before: number | null | undefined,
): TimeSpan | null {
  if (at == null) return null;
  const lo = Math.min(after ?? at, at);
  const hi = Math.max(before ?? at, at);
  return lo === hi ? null : { after: lo, before: hi };
}

/** Whether a span is wide enough to be shown as one. */
export function isWide(span: TimeSpan | null | undefined): span is TimeSpan {
  return span != null && span.before - span.after > COLLAPSE_MS;
}

/**
 * The shortest and longest an event can have lasted, in whole minutes, given its
 * two ends. Null when the ends are exact or tight enough that the duration
 * stands as measured, and when there is no end yet.
 */
export function durationRange(
  start: { at: number; span: TimeSpan | null },
  end: { at: number | null; span: TimeSpan | null },
): NumberRange | null {
  if (end.at == null) return null;
  if (!isWide(start.span) && !isWide(end.span)) return null;
  const shortest = (end.span?.after ?? end.at) - (start.span?.before ?? start.at);
  const longest = (end.span?.before ?? end.at) - (start.span?.after ?? start.at);
  const min = Math.max(0, Math.round(shortest / 60_000));
  const max = Math.round(longest / 60_000);
  return max > min ? { min, max } : null;
}
