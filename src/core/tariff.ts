/**
 * Time-of-use tariffs: what a place charged at a given local moment.
 *
 * A place's tariff is a list of dated prices. Each applies from its first
 * local day until the next one begins, so a new price leaves the sessions
 * before it alone. A price is a base rate plus time windows with their own
 * rate; a window is a stretch of local wall time on chosen weekdays (and
 * optionally months) and may cross midnight. Where windows overlap, the later
 * one in the list wins — "weekday nights cheap, but not in December" is a
 * night window followed by a December window at the base rate.
 *
 * Everything here works on the place's wall clock. That is what a utility's
 * tariff sheet means by "22:00–06:00", including on the nights clocks change:
 * a 22:00–06:00 window lasts seven hours one night a year and nine on another.
 */

import type { TariffPriceDto, TariffWindowDto } from "@shared/api-types";
import {
  addDays,
  isoWeekday,
  localDate,
  localParts,
  localToUtc,
  offsetChanges,
  parseDate,
  startOfLocalDay,
} from "./zone";

/** The window index that means "no window": the base rate. */
export const BASE = -1;

const DAY_MINUTES = 24 * 60;

/** "HH:MM" to minutes after midnight; "24:00" is accepted as the day's end. */
export function parseTime(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`not a time: ${time}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes > DAY_MINUTES || Number(match[2]) > 59) throw new Error(`not a time: ${time}`);
  return minutes;
}

/** A moment on the place's wall clock, as far as windows care. */
export interface LocalMoment {
  year: number;
  month: number;
  day: number;
  /** ISO, 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Minutes after local midnight. */
  minute: number;
}

export function momentAt(at: number, timeZone: string): LocalMoment {
  const p = localParts(at, timeZone);
  return { year: p.year, month: p.month, day: p.day, weekday: p.weekday, minute: p.hour * 60 + p.minute };
}

function dayMatches(window: TariffWindowDto, weekday: number, month: number): boolean {
  if (!window.days.includes(weekday)) return false;
  return window.months == null || window.months.length === 0 || window.months.includes(month);
}

/**
 * Whether a window covers a local moment. A window belongs to the day it
 * starts on: Monday's 22:00–06:00 covers Monday from 22:00 and Tuesday until
 * 06:00, and only when Monday is one of its days (and Monday's month one of
 * its months). An end equal to the start is a full 24 hours.
 */
export function windowCovers(window: TariffWindowDto, at: LocalMoment): boolean {
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  if (end > start) return dayMatches(window, at.weekday, at.month) && at.minute >= start && at.minute < end;
  // Crosses midnight: the evening part is today's, the morning part yesterday's.
  if (at.minute >= start && dayMatches(window, at.weekday, at.month)) return true;
  if (at.minute < end) {
    const yesterday = new Date(Date.UTC(at.year, at.month - 1, at.day - 1));
    const weekday = isoWeekday(yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate());
    return dayMatches(window, weekday, yesterday.getUTCMonth() + 1);
  }
  return false;
}

/** The window in force at a moment — the last one that covers it — or BASE. */
export function windowAt(price: TariffPriceDto, at: LocalMoment): number {
  for (let i = price.windows.length - 1; i >= 0; i--) {
    if (windowCovers(price.windows[i]!, at)) return i;
  }
  return BASE;
}

export function rateOf(price: TariffPriceDto, window: number): number {
  return window === BASE ? price.rate : price.windows[window]!.rate;
}

/** Prices oldest first, as stored. */
export function sortPrices(tariff: TariffPriceDto[]): TariffPriceDto[] {
  return [...tariff].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
}

/** The price in force on a local day: the latest that began on or before it. Null before the first. */
export function priceOn(tariff: TariffPriceDto[], date: string): TariffPriceDto | null {
  let found: TariffPriceDto | null = null;
  for (const price of tariff) {
    if (price.validFrom <= date && (found == null || price.validFrom >= found.validFrom)) found = price;
  }
  return found;
}

/** A stretch of time at one rate. */
export interface RateSlice {
  from: number;
  to: number;
  window: number;
  rate: number;
}

/**
 * [from, to) cut where the rate changes: at every window's start and end on
 * every local day the span touches, at local midnights (weekday and month
 * filters turn over there), and at the zone's offset changes (a window's edge
 * may fall inside the hour the clocks skip). Each piece then takes the rate in
 * force at its middle, and neighbours at the same window merge.
 */
export function rateSlices(price: TariffPriceDto, timeZone: string, from: number, to: number): RateSlice[] {
  if (to <= from) return [];
  if (price.windows.length === 0) return [{ from, to, window: BASE, rate: price.rate }];

  const marks = new Set<number>();
  for (const w of price.windows) {
    marks.add(parseTime(w.start) % DAY_MINUTES);
    marks.add(parseTime(w.end) % DAY_MINUTES);
  }
  marks.add(0);

  const cuts = new Set<number>([from, to]);
  const last = localDate(to, timeZone);
  for (let date = addDays(localDate(from, timeZone), -1); date <= addDays(last, 1); date = addDays(date, 1)) {
    for (const minute of marks) {
      for (const at of localToUtc(timeZone, date, minute)) if (at > from && at < to) cuts.add(at);
    }
  }
  for (const at of offsetChanges(from, to, timeZone)) if (at > from && at < to) cuts.add(at);

  const ordered = [...cuts].sort((a, b) => a - b);
  const slices: RateSlice[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const start = ordered[i]!;
    const end = ordered[i + 1]!;
    const window = windowAt(price, momentAt(start + (end - start) / 2, timeZone));
    const previous = slices[slices.length - 1];
    if (previous && previous.window === window) previous.to = end;
    else slices.push({ from: start, to: end, window, rate: rateOf(price, window) });
  }
  return slices;
}

/**
 * Which window applies at each hour of a week, for the form's preview strip:
 * `grid[d][h]` for ISO weekday d + 1 at h:00, in `month` (default January,
 * which only matters to windows filtered by month).
 */
export function weekGrid(price: TariffPriceDto, month = 1): number[][] {
  // A week in a fixed year whose Monday is known, in the given month: the
  // first Monday of that month in 2024, a leap year so February has its 29th.
  const firstOfMonth = isoWeekday(2024, month, 1);
  const monday = 1 + ((8 - firstOfMonth) % 7);
  const grid: number[][] = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.UTC(2024, month - 1, monday + d));
    const row: number[] = [];
    for (let h = 0; h < 24; h++) {
      row.push(
        windowAt(price, {
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
          day: date.getUTCDate(),
          weekday: d + 1,
          minute: h * 60,
        }),
      );
    }
    grid.push(row);
  }
  return grid;
}

/** Two prices bill alike — the same rates, windows and fee, whatever day they start on. */
export function samePrice(a: TariffPriceDto | null, b: TariffPriceDto | null): boolean {
  if (a == null || b == null) return a === b;
  const strip = ({ validFrom: _validFrom, ...rest }: TariffPriceDto) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** Local days [from, until), until null: open-ended. */
export interface DateRange {
  from: string;
  until: string | null;
}

/**
 * The local days on which two versions of a tariff bill differently — what an
 * edit has to reprice. Adding a price changes only the days from its start on;
 * correcting one changes only the days it is in force; moving the first price
 * earlier changes only the days it now newly covers.
 */
export function changedDays(before: TariffPriceDto[], after: TariffPriceDto[]): DateRange[] {
  const bounds = [...new Set([...before, ...after].map((p) => p.validFrom))].sort();
  const ranges: DateRange[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const from = bounds[i]!;
    if (samePrice(priceOn(before, from), priceOn(after, from))) continue;
    const until = bounds[i + 1] ?? null;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.until === from) previous.until = until;
    else ranges.push({ from, until });
  }
  return ranges;
}

/** The instant a local day begins, for turning a DateRange into a query. */
export function dayStart(date: string, timeZone: string): number {
  return startOfLocalDay(date, timeZone);
}

/** Rejects what the matching above cannot read; the API's schema calls it. */
export function tariffProblem(tariff: TariffPriceDto[]): string | null {
  const seen = new Set<string>();
  for (const price of tariff) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(price.validFrom)) return `not a date: ${price.validFrom}`;
    const { year, month, day } = parseDate(price.validFrom);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return `not a date: ${price.validFrom}`;
    if (seen.has(price.validFrom)) return `two prices start on ${price.validFrom}`;
    seen.add(price.validFrom);
    for (const window of price.windows) {
      try {
        parseTime(window.start);
        parseTime(window.end);
      } catch (error) {
        return (error as Error).message;
      }
      if (window.days.length === 0) return "a window needs at least one weekday";
    }
  }
  return null;
}
