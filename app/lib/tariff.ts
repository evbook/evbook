/**
 * The place form's tariff as it is typed, and the words the app uses for a
 * tariff and for what it made of a session. The matching itself is the
 * server's (src/core/tariff.ts), imported here only for the preview strip.
 */

import type { CostDetailDto, TariffPriceDto, TariffWindowDto } from "@shared/api-types";
import type { CurrencyCode } from "@shared/currency";
import { money, rate } from "./format";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface WindowDraft {
  label: string;
  days: number[];
  start: string;
  end: string;
  /** Empty: every month. */
  months: number[];
  rate: string;
}

export interface PriceDraft {
  validFrom: string;
  billingType: "per_kwh" | "per_minute";
  rate: string;
  sessionFee: string;
  windows: WindowDraft[];
}

export function blankPrice(validFrom: string): PriceDraft {
  return { validFrom, billingType: "per_kwh", rate: "", sessionFee: "", windows: [] };
}

/** The usual off-peak night, as a starting point the owner edits. */
export function blankWindow(): WindowDraft {
  return { label: "Off-peak", days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "06:00", months: [], rate: "" };
}

export function toDraft(price: TariffPriceDto): PriceDraft {
  return {
    validFrom: price.validFrom,
    billingType: price.billingType,
    rate: String(price.rate),
    sessionFee: price.sessionFeeCents != null ? (price.sessionFeeCents / 100).toFixed(2) : "",
    windows: price.windows.map((w) => ({
      label: w.label ?? "",
      days: [...w.days],
      start: w.start,
      end: w.end,
      months: w.months ?? [],
      rate: String(w.rate),
    })),
  };
}

function parseAmount(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

/** A draft as the preview reads it: anything not yet a number counts as 0. */
export function previewPrice(draft: PriceDraft): TariffPriceDto {
  const num = (text: string) => {
    const value = parseAmount(text);
    return value == null || Number.isNaN(value) ? 0 : value;
  };
  return {
    validFrom: draft.validFrom,
    billingType: draft.billingType,
    rate: num(draft.rate),
    sessionFeeCents: null,
    windows: draft.windows
      .filter((w) => w.days.length > 0 && /^\d{2}:\d{2}$/.test(w.start) && /^\d{2}:\d{2}$/.test(w.end))
      .map((w) => windowOf(w, num(w.rate))),
  };
}

function windowOf(w: WindowDraft, value: number): TariffWindowDto {
  return {
    label: w.label.trim() || null,
    days: [...w.days].sort((a, b) => a - b),
    start: w.start,
    end: w.end,
    months: w.months.length === 0 || w.months.length === 12 ? null : [...w.months].sort((a, b) => a - b),
    rate: value,
  };
}

/**
 * The drafts as the API takes them, or the first thing wrong with them. A
 * price with nothing filled in is left out — a place need not have one.
 */
export function fromDrafts(drafts: PriceDraft[]): { tariff: TariffPriceDto[] } | { error: string } {
  const tariff: TariffPriceDto[] = [];
  for (const draft of drafts) {
    const base = parseAmount(draft.rate);
    const fee = parseAmount(draft.sessionFee);
    if (base == null && fee == null && draft.windows.length === 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.validFrom)) return { error: "Each price needs the day it starts on." };
    if (Number.isNaN(base) || Number.isNaN(fee)) return { error: "Rates and fees are amounts, like 0.30." };
    const windows: TariffWindowDto[] = [];
    for (const w of draft.windows) {
      const value = parseAmount(w.rate);
      if (value == null || Number.isNaN(value)) return { error: "Give every time window its price." };
      if (w.days.length === 0) return { error: "A time window needs at least one weekday." };
      if (!/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end)) return { error: "Times are HH:MM." };
      windows.push(windowOf(w, value));
    }
    tariff.push({
      validFrom: draft.validFrom,
      billingType: draft.billingType,
      rate: base ?? 0,
      sessionFeeCents: fee == null ? null : Math.round(fee * 100),
      windows,
    });
  }
  const days = tariff.map((p) => p.validFrom);
  if (new Set(days).size !== days.length) return { error: "Two prices start on the same day." };
  return { tariff: tariff.sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1)) };
}

/** The price in force on a local day, by the same rule as the server. */
export function priceOnDay(tariff: TariffPriceDto[], date: string): TariffPriceDto | null {
  let found: TariffPriceDto | null = null;
  for (const price of tariff)
    if (price.validFrom <= date && (!found || price.validFrom > found.validFrom)) found = price;
  return found;
}

function unit(billingType: "per_kwh" | "per_minute"): string {
  return billingType === "per_kwh" ? "kWh" : "min";
}

/** "€0.300 per kWh, 1 time window + €0.99 fee" — one price at a glance. */
export function describePrice(price: TariffPriceDto, currency: CurrencyCode): string {
  // Rates are stored in major units, unlike every other money column, so they go
  // back into minor ones before the formatter sees them.
  const parts = [`${rate(price.rate * 100, currency)} per ${unit(price.billingType)}`];
  if (price.windows.length > 0) {
    parts[0] += `, ${price.windows.length} time ${price.windows.length === 1 ? "window" : "windows"}`;
  }
  if (price.sessionFeeCents) parts.push(`${money(price.sessionFeeCents, currency)} fee`);
  return parts.join(" + ");
}

function quantity(min: number, max: number, digits: number): string {
  const f = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
  return Math.abs(max - min) < 10 ** -digits ? f(min) : `${f(min)}–${f(max)}`;
}

/**
 * The one line under a charge's cost: how much was billed and at what. "30 kWh
 * billed (estimated), assuming 88% efficiency · Off-peak 23–28 kWh at €0.120 ·
 * base 2–7 kWh at €0.300".
 */
export function explainCost(detail: CostDetailDto, currency: CurrencyCode): string {
  if (detail.free) return "Free supercharging.";
  const pieces: string[] = [];
  const u = detail.billingType === "per_minute" ? "min" : "kWh";
  if (detail.billedKwh) {
    let billed = `${quantity(detail.billedKwh.min, detail.billedKwh.max, 1)} kWh billed`;
    if (detail.estimated) {
      billed += " (estimated)";
      if (detail.efficiency != null) billed += `, assuming ${Math.round(detail.efficiency * 100)}% efficiency`;
      else billed += ", assuming 88–95% efficiency";
    }
    pieces.push(billed);
  }
  for (const part of detail.parts) {
    const name = part.label ?? (detail.parts.length > 1 ? "base" : "at");
    const amount = `${quantity(part.min, part.max, detail.billingType === "per_minute" ? 0 : 1)} ${u}`;
    pieces.push(
      part.label == null && detail.parts.length === 1
        ? `${amount} at ${rate(part.rate * 100, currency)}`
        : `${name} ${amount} at ${rate(part.rate * 100, currency)}`,
    );
  }
  if (detail.sessionFeeCents) pieces.push(`${money(detail.sessionFeeCents, currency)} session fee`);
  if (detail.priceFrom) pieces.push(`price from ${detail.priceFrom}`);
  return pieces.join(" · ");
}
