/** Date/money formatting shared by the list and detail pages. */

import type { CurrencyCode } from "@shared/currency";
import { isWide, type NumberRange, type TimeSpan } from "@shared/uncertainty";

function amount(cents: number, currency: CurrencyCode, digits: number): string {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * A cost, in the currency the account is kept in. Nothing in the database records
 * one — costs are bare minor units — so the symbol comes from the setting, and the
 * caller has to hand it over rather than get an unlabelled number by omission.
 */
export function money(cents: number | null | undefined, currency: CurrencyCode): string {
  if (cents == null) return "–";
  return amount(cents, currency, 2);
}

/**
 * What something cost, which is not the same as an amount of money: unknown is a
 * dash, never "0.00" — nothing priced it — and an exact 0 is "Free", because a
 * free supercharger session is a fact worth reading. `max` is the top of a range
 * (bounded inputs, see ChargeDto.costMaxCents), shown "€5.24 – €5.79" when it
 * differs from the bottom.
 */
export function cost(cents: number | null | undefined, currency: CurrencyCode, max?: number | null): string {
  if (cents == null) return "–";
  if (max != null && max !== cents) {
    const [lo, hi] = cents < max ? [cents, max] : [max, cents];
    return `${amount(lo, currency, 2)} – ${amount(hi, currency, 2)}`;
  }
  return cents === 0 ? "Free" : amount(cents, currency, 2);
}

/**
 * The sum of the figures that are known: null when none is, so a total over
 * sessions nobody priced reads as unknown rather than as free.
 */
export function sumKnown(values: Iterable<number | null | undefined>): number | null {
  let total: number | null = null;
  for (const value of values) if (value != null) total = (total ?? 0) + value;
  return total;
}

/**
 * A per-unit price: cost per kWh, per minute. Three decimals because electricity is
 * sold in fractions of a cent, and two would round most tariffs onto each other.
 * Takes minor units like `money`, so a caller that has cents and kWh divides one by
 * the other and passes the result straight in.
 */
export function rate(centsPerUnit: number | null | undefined, currency: CurrencyCode, digits = 3): string {
  if (centsPerUnit == null || !Number.isFinite(centsPerUnit)) return "–";
  return amount(centsPerUnit, currency, digits);
}

/**
 * The zone the band's clock is in, short enough to sit under a chart: "UTC", or the
 * city and its offset ("Moscow, GMT+3"), so a reader can tell at a glance
 * whether it is their own. The offset is the one in force at `at`.
 */
export function zoneLabel(timezone: string, at: number): string {
  let short: string;
  try {
    short =
      new Intl.DateTimeFormat("en-GB", { timeZone: timezone, timeZoneName: "short" })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value ?? timezone;
  } catch {
    return timezone;
  }
  const slash = timezone.lastIndexOf("/");
  // "UTC", "Etc/GMT+3" and the like have no city worth naming.
  if (slash < 0 || timezone.startsWith("Etc/")) return short;
  const city = timezone.slice(slash + 1).replaceAll("_", " ");
  return city === short ? short : `${city}, ${short}`;
}

export function dateTime(at: number | null | undefined, timezone: string): string {
  if (at == null) return "–";
  return new Date(at).toLocaleString(undefined, {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeOnly(at: number | null | undefined, timezone: string): string {
  if (at == null) return "–";
  return new Date(at).toLocaleTimeString(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
}

export function dateOnly(at: number | null | undefined, timezone: string): string {
  if (at == null) return "–";
  return new Date(at).toLocaleDateString(undefined, {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

/** "Wed, 2 Sept 2026": a day as a list row leads with it, the weekday first. */
export function weekdayDate(at: number | null | undefined, timezone: string): string {
  if (at == null) return "–";
  return new Date(at).toLocaleDateString(undefined, {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Value for a datetime-local input, in the given time zone. */
export function toDateInput(at: number | null, timezone: string): string {
  if (at == null) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function number(value: number | null | undefined, digits = 1): string {
  if (value == null) return "–";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * When something last happened, the way you would say it: "Today, 08:12",
 * "Yesterday, 17:41", or the date once it is further back than that. Days are the
 * account's calendar days, so a drive just after midnight in Berlin is today in
 * Berlin wherever the browser happens to be.
 */
export function dayAndTime(at: number | null | undefined, timezone: string, now = Date.now()): string {
  if (at == null) return "–";
  const day = toDateInput(at, timezone);
  const time = timeOnly(at, timezone);
  if (day === toDateInput(now, timezone)) return `Today, ${time}`;
  if (day === toDateInput(now - 86_400_000, timezone)) return `Yesterday, ${time}`;
  return dateOnly(at, timezone);
}

/**
 * One end of an event as polling knows it: the time, or "06:55–07:01" when the
 * readings either side of it are further apart than COLLAPSE_MS.
 */
export function timeSpan(at: number | null | undefined, span: TimeSpan | null | undefined, timezone: string): string {
  if (at == null) return "–";
  if (!isWide(span)) return timeOnly(at, timezone);
  const from = timeOnly(span.after, timezone);
  const to = timeOnly(span.before, timezone);
  if (toDateInput(span.after, timezone) === toDateInput(span.before, timezone)) return `${from}–${to}`;
  return `${dateTime(span.after, timezone)} – ${dateTime(span.before, timezone)}`;
}

/** The same with its date, for the head of a detail page. */
export function dateTimeSpan(
  at: number | null | undefined,
  span: TimeSpan | null | undefined,
  timezone: string,
): string {
  if (at == null) return "–";
  if (!isWide(span)) return dateTime(at, timezone);
  if (toDateInput(span.after, timezone) === toDateInput(span.before, timezone)) {
    return `${dateOnly(span.after, timezone)}, ${timeOnly(span.after, timezone)}–${timeOnly(span.before, timezone)}`;
  }
  return `${dateTime(span.after, timezone)} – ${dateTime(span.before, timezone)}`;
}

/**
 * When an event nobody saw took place: "Happened between 12:00 and 13:00", with
 * dates once the gap crosses midnight. `withDate` puts the day in front of a
 * same-day span too, for a page that shows nothing else to date it by.
 */
export function happenedBetween(span: TimeSpan, timezone: string, withDate = false): string {
  const sameDay = toDateInput(span.after, timezone) === toDateInput(span.before, timezone);
  if (sameDay) {
    const day = withDate ? `${dateOnly(span.after, timezone)}, ` : "";
    return `Happened between ${day}${timeOnly(span.after, timezone)} and ${timeOnly(span.before, timezone)}`;
  }
  return `Happened between ${dateTime(span.after, timezone)} and ${dateTime(span.before, timezone)}`;
}

/** "38–45 min" for a bounded duration; the caller formats an exact one as before. */
export function durationRangeText(range: NumberRange, format: (seconds: number) => string): string {
  const lo = format(range.min * 60);
  const hi = format(range.max * 60);
  // "38 min–45 min" reads as two durations; share the unit when they share one.
  const unit = /\s(\S+)$/u.exec(lo)?.[1];
  if (unit && hi.endsWith(` ${unit}`) && /^\d+ \S+$/u.test(lo) && /^\d+ \S+$/u.test(hi)) {
    return `${lo.slice(0, -unit.length - 1)}–${hi}`;
  }
  return `${lo} – ${hi}`;
}

/** What a drive, charge or log event carries about its own uncertainty. */
interface Bounded {
  startAt: number;
  endAt: number | null;
  startSpan: TimeSpan | null;
  endSpan: TimeSpan | null;
  reconstructed: boolean;
}

/**
 * A row's times: "06:55–07:01 → 07:40", or "Happened between …" for an event
 * nobody saw, which has no start or end of its own to give.
 */
export function eventTimes(event: Bounded, timezone: string): string {
  const times = eventTimeEnds(event, timezone);
  return typeof times === "string" ? times : `${times[0]} → ${times[1]}`;
}

/**
 * The same, with the two ends kept apart for a caller that draws its own
 * separator between them — or the one string when there are no ends to give.
 */
export function eventTimeEnds(event: Bounded, timezone: string): string | [start: string, end: string] {
  if (event.reconstructed)
    return happenedBetween(event.startSpan ?? { after: event.startAt, before: event.endAt ?? event.startAt }, timezone);
  const end = event.endAt == null ? "now" : timeSpan(event.endAt, event.endSpan, timezone);
  return [timeSpan(event.startAt, event.startSpan, timezone), end];
}

/** A detail page's dateline: the same, with the date. */
export function eventDateline(event: Bounded, timezone: string): string {
  if (event.reconstructed) {
    return happenedBetween(
      event.startSpan ?? { after: event.startAt, before: event.endAt ?? event.startAt },
      timezone,
      true,
    );
  }
  return `${dateTimeSpan(event.startAt, event.startSpan, timezone)} – ${timeSpan(event.endAt, event.endSpan, timezone)}`;
}

/**
 * How long it took: the measured duration, "38–45 min" when its ends are
 * spans, and a dash for an event nobody saw — which has no duration, not one
 * of zero.
 */
export function eventDuration(
  event: { durationMin: number | null; durationRangeMin?: NumberRange | null; reconstructed: boolean },
  format: (seconds: number | null) => string,
): string {
  if (event.reconstructed) return "–";
  if (event.durationRangeMin) return durationRangeText(event.durationRangeMin, format);
  return format(event.durationMin != null ? event.durationMin * 60 : null);
}
