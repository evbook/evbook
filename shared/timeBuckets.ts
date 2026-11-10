/**
 * Period bucketing in the user's time zone. SQLite has no time-zone database,
 * so buckets are computed here as UTC millisecond ranges and the SQL only ever
 * compares against those bounds. This is what replaces Grafana's
 * `date_trunc(unit, ts, tz)`.
 *
 * Shared rather than worker-only because the date range picker snaps to these
 * same boundaries. If the two ever computed a week differently, a range the user
 * picked and a chart bucketed inside it would disagree at the edges.
 */

export type Period = "day" | "week" | "month" | "year";

/**
 * First day of the week, ISO numbering: 1 = Monday … 7 = Sunday.
 *
 * Defaulted to Monday everywhere, which is what ISO weeks mean and what the
 * server's grouped statistics have always used. The picker passes the value for
 * the viewer's locale instead, so "1W" means the week they'd draw on paper.
 */
export type FirstDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_FIRST_DAY: FirstDay = 1;

/**
 * How far back the statistics page looks when grouping by each period: enough
 * buckets to draw a chart with, without a day-by-day view reaching back a decade.
 *
 * Shared because every card on that page has to agree about it. The grouped table
 * and the roll-ups beside it are separate requests, and when only one of them knew
 * this rule the roll-ups silently answered for the last year while the table above
 * them answered for ten.
 */
export function statsWindow(period: Period, now: number): { from: number; to: number } {
  const days = period === "day" ? 30 : period === "week" ? 365 : period === "month" ? 365 * 2 : 365 * 10;
  return { from: now - days * 86_400_000, to: now };
}

export interface Bucket {
  /** Stable key, e.g. "2026-07" for a month. */
  key: string;
  label: string;
  from: number;
  /** Exclusive. */
  to: number;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(at: number, timeZone: string): Parts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of a zone from UTC, in milliseconds, at a given instant. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const p = partsInZone(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The UTC instant for a wall-clock time in a zone. Resolved iteratively because
 * the offset itself depends on the instant — which is exactly what makes DST
 * boundaries tricky.
 */
export function zonedTimeToUtc(timeZone: string, year: number, month: number, day: number, hour = 0): number {
  const naive = Date.UTC(year, month - 1, day, hour);
  let guess = naive - zoneOffsetMs(naive, timeZone);
  // One correction pass is enough for every real zone offset.
  guess = naive - zoneOffsetMs(guess, timeZone);
  return guess;
}

function startOfPeriod(
  at: number,
  period: Period,
  timeZone: string,
  firstDay: FirstDay = ISO_FIRST_DAY,
): { parts: Parts; key: string } {
  const p = partsInZone(at, timeZone);
  switch (period) {
    case "day":
      return { parts: { ...p, hour: 0 }, key: `${p.year}-${pad(p.month)}-${pad(p.day)}` };
    case "week": {
      // Days back to the start of the week. getUTCDay is 0 = Sunday, so shift it
      // into ISO numbering (1 = Monday … 7 = Sunday) before subtracting.
      const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
      const iso = weekday === 0 ? 7 : weekday;
      const back = (iso - firstDay + 7) % 7;
      const start = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
      return {
        parts: {
          year: start.getUTCFullYear(),
          month: start.getUTCMonth() + 1,
          day: start.getUTCDate(),
          hour: 0,
          minute: 0,
          second: 0,
        },
        // ISO week numbers are only meaningful for Monday-start weeks; anything
        // else is keyed by the date it begins on.
        key:
          firstDay === ISO_FIRST_DAY
            ? `${start.getUTCFullYear()}-W${pad(isoWeek(start))}`
            : `W${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`,
      };
    }
    case "month":
      return { parts: { ...p, day: 1, hour: 0 }, key: `${p.year}-${pad(p.month)}` };
    case "year":
      return { parts: { ...p, month: 1, day: 1, hour: 0 }, key: String(p.year) };
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoWeek(date: Date): number {
  const target = new Date(date.getTime());
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

function advance(parts: Parts, period: Period): Parts {
  switch (period) {
    case "day":
      return { ...parts, day: parts.day + 1 };
    case "week":
      return { ...parts, day: parts.day + 7 };
    case "month":
      return parts.month === 12 ? { ...parts, year: parts.year + 1, month: 1 } : { ...parts, month: parts.month + 1 };
    case "year":
      return { ...parts, year: parts.year + 1 };
  }
}

function retreat(parts: Parts, period: Period): Parts {
  switch (period) {
    case "day":
      return { ...parts, day: parts.day - 1 };
    case "week":
      return { ...parts, day: parts.day - 7 };
    case "month":
      return parts.month === 1 ? { ...parts, year: parts.year - 1, month: 12 } : { ...parts, month: parts.month - 1 };
    case "year":
      return { ...parts, year: parts.year - 1 };
  }
}

function labelFor(
  from: number,
  period: Period,
  timeZone: string,
  key: string,
  firstDay: FirstDay = ISO_FIRST_DAY,
): string {
  const date = new Date(from);
  const shortDate = () =>
    date.toLocaleDateString("en-GB", { timeZone, day: "2-digit", month: "short", year: "numeric" });
  switch (period) {
    case "day":
      return shortDate();
    case "week":
      // "2026-W30" is the ISO week and only means anything for Monday-start weeks.
      // A week starting any other day is named by the date it begins on, which is
      // unambiguous and still reads as a series seven days apart on an axis.
      return firstDay === ISO_FIRST_DAY ? key : shortDate();
    case "month":
      return date.toLocaleDateString("en-GB", { timeZone, month: "long", year: "numeric" });
    case "year":
      return String(partsInZone(from, timeZone).year);
  }
}

/**
 * Local day of week and hour at an instant, for the charge heatmap — the one
 * grouping that is not a contiguous range, so it cannot be expressed as bucket
 * bounds the way everything else here is and has to be resolved per row.
 *
 * ISO numbering for the day, 1 = Monday … 7 = Sunday, matching `FirstDay`.
 */
export function zonedWeekdayHour(at: number, timeZone: string): { weekday: FirstDay; hour: number } {
  const p = partsInZone(at, timeZone);
  // The weekday of the local calendar date rather than of the instant: reading it
  // back out of a UTC date built from the local parts sidesteps the offset entirely.
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { weekday: (day === 0 ? 7 : day) as FirstDay, hour: p.hour };
}

/**
 * Contiguous buckets covering [from, to], aligned to the period in the given
 * zone. Bucket boundaries are exact UTC instants, so DST shifts produce 23- and
 * 25-hour days rather than drifting.
 */
export function buildBuckets(
  from: number,
  to: number,
  period: Period,
  timeZone: string,
  max = 400,
  firstDay: FirstDay = ISO_FIRST_DAY,
): Bucket[] {
  if (to < from) return [];
  const buckets: Bucket[] = [];
  let { parts, key } = startOfPeriod(from, period, timeZone, firstDay);
  let start = zonedTimeToUtc(timeZone, parts.year, parts.month, parts.day, 0);

  while (start <= to && buckets.length < max) {
    const nextParts = advance(parts, period);
    const next = zonedTimeToUtc(timeZone, nextParts.year, nextParts.month, nextParts.day, 0);
    buckets.push({ key, label: labelFor(start, period, timeZone, key, firstDay), from: start, to: next });
    parts = nextParts;
    start = next;
    key = startOfPeriod(start, period, timeZone, firstDay).key;
  }
  return buckets;
}

/**
 * The single calendar period containing an instant, as a half-open `[from, to)`
 * window. This is what a date range preset resolves to: "1M" on any day in July
 * is exactly July, so the bounds are identical on every render and across every
 * viewer in the same zone — which is what lets a bucketed rollup table answer
 * the query later without recomputing anything.
 */
export function windowFor(
  at: number,
  period: Period,
  timeZone: string,
  firstDay: FirstDay = ISO_FIRST_DAY,
): { from: number; to: number } {
  const { parts } = startOfPeriod(at, period, timeZone, firstDay);
  const next = advance(parts, period);
  return {
    from: zonedTimeToUtc(timeZone, parts.year, parts.month, parts.day, 0),
    to: zonedTimeToUtc(timeZone, next.year, next.month, next.day, 0),
  };
}

/**
 * The window `count` periods away from the one containing `at`. Stepping walks
 * the calendar rather than adding a fixed number of milliseconds, so a month step
 * lands on the 1st whatever the month's length and a day step survives DST.
 */
export function shiftWindow(
  at: number,
  period: Period,
  count: number,
  timeZone: string,
  firstDay: FirstDay = ISO_FIRST_DAY,
): { from: number; to: number } {
  let { parts } = startOfPeriod(at, period, timeZone, firstDay);
  const step = count < 0 ? retreat : advance;
  for (let i = 0; i < Math.abs(count); i++) parts = step(parts, period);
  // Landing at midday rather than midnight before re-snapping: a week step can
  // leave a day-of-month past the end of the month (28 + 7), and a zone that
  // shifts its clock at midnight has days where 00:00 does not exist at all.
  // Noon is unambiguous in both cases, and windowFor snaps back down from there.
  return windowFor(zonedTimeToUtc(timeZone, parts.year, parts.month, parts.day, 12), period, timeZone, firstDay);
}
