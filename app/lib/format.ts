/** Date/money formatting shared by the list and detail pages. */

import type { CurrencyCode } from "@shared/currency";

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
