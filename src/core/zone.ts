/**
 * Wall-clock arithmetic in an IANA time zone, for the tariffs (core/tariff.ts):
 * which local day and minute an instant falls on, and which instants a local
 * time names.
 *
 * The second question has zero, one or two answers. On the night clocks go
 * forward an hour of wall time never happens (02:30 does not exist in Berlin
 * on the last Sunday of March); on the night they go back it happens twice.
 * Pricing slices the session at every instant a window could begin or end, so
 * both answers matter, and so does the moment of the change itself.
 *
 * One `Intl.DateTimeFormat` per zone, cached: constructing one is by far the
 * dearest part, and a session is sliced with a few hundred lookups.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO, 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** Whether the runtime knows this zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at an instant. */
export function localParts(at: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(at));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
    }
  }
  return { year, month, day, hour, minute, second, weekday: isoWeekday(year, month, day) };
}

/** ISO weekday of a calendar date, 1 = Monday … 7 = Sunday. */
export function isoWeekday(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The zone's offset from UTC at an instant, in ms (Berlin in summer: +2 h). */
export function offsetMs(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** "YYYY-MM-DD" of the local day an instant falls on. */
export function localDate(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return formatDate(p.year, p.month, p.day);
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

/** The calendar date `days` after `date` (negative: before). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Every instant at which the wall clock reads `minuteOfDay` on `date`: none
 * when the clocks jump over it, two when they fall back through it.
 */
export function localToUtc(timeZone: string, date: string, minuteOfDay: number): number[] {
  const { year, month, day } = parseDate(date);
  const naive = Date.UTC(year, month - 1, day) + minuteOfDay * MINUTE_MS;
  // The offsets in force around that wall time: half a day either side brackets
  // any real transition, and each offset proposes one instant.
  const offsets = new Set([offsetMs(naive - DAY_MS / 2, timeZone), offsetMs(naive + DAY_MS / 2, timeZone)]);
  const found: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    // Kept only when it reads back as the wall time asked for.
    if (candidate + offsetMs(candidate, timeZone) === naive && !found.includes(candidate)) found.push(candidate);
  }
  return found.sort((a, b) => a - b);
}

/**
 * The first instant of a local day. Midnight itself, unless the zone skips
 * it (a few move their clocks at 00:00) — then the moment the day begins.
 */
export function startOfLocalDay(date: string, timeZone: string): number {
  const exact = localToUtc(timeZone, date, 0);
  if (exact.length > 0) return exact[0]!;
  const { year, month, day } = parseDate(date);
  // Bisect between a moment surely before and one surely after, to the minute.
  let lo = Date.UTC(year, month - 1, day) - 15 * HOUR_MS;
  let hi = Date.UTC(year, month - 1, day) + 15 * HOUR_MS;
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (localDate(mid, timeZone) >= date) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The instants in [from, to] at which the zone's offset changes. No real zone
 * changes twice within six hours, so sampling at that pace finds every one,
 * and bisection pins each to the minute (offsets change on whole minutes).
 */
export function offsetChanges(from: number, to: number, timeZone: string): number[] {
  const step = 6 * HOUR_MS;
  const changes: number[] = [];
  let prevAt = from;
  let prevOffset = offsetMs(from, timeZone);
  for (let at = Math.min(from + step, to); ; at = Math.min(at + step, to)) {
    const offset = offsetMs(at, timeZone);
    if (offset !== prevOffset) {
      let lo = prevAt;
      let hi = at;
      while (hi - lo > MINUTE_MS) {
        const mid = lo + Math.max(MINUTE_MS, Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS);
        if (mid >= hi) break;
        if (offsetMs(mid, timeZone) === prevOffset) lo = mid;
        else hi = mid;
      }
      // The change is on a whole minute in (lo, hi], and hi - lo <= 1 min: that
      // minute is hi's own.
      changes.push(Math.floor(hi / MINUTE_MS) * MINUTE_MS);
    }
    prevAt = at;
    prevOffset = offset;
    if (at >= to) break;
  }
  return changes;
}
