/**
 * The currency every cost in this database is counted in.
 *
 * Costs are stored as bare integer minor units (`_cents`) with no currency of their
 * own, so the code is a display setting: one account, one currency, every car. It
 * relabels what is already recorded — nothing is converted, and a rate typed under
 * one currency keeps its number under the next.
 *
 * Euro and US dollar lead the list because they are what most owners pick; the rest
 * follow by code.
 */

const CURRENCY_NAMES = {
  EUR: "Euro",
  USD: "US dollar",
  AED: "UAE dirham",
  AUD: "Australian dollar",
  CAD: "Canadian dollar",
  CHF: "Swiss franc",
  CNY: "Chinese yuan",
  CZK: "Czech koruna",
  DKK: "Danish krone",
  GBP: "Pound sterling",
  HKD: "Hong Kong dollar",
  HUF: "Hungarian forint",
  ILS: "Israeli new shekel",
  INR: "Indian rupee",
  ISK: "Icelandic króna",
  JPY: "Japanese yen",
  KRW: "South Korean won",
  MXN: "Mexican peso",
  NOK: "Norwegian krone",
  NZD: "New Zealand dollar",
  PLN: "Polish złoty",
  RON: "Romanian leu",
  SEK: "Swedish krona",
  SGD: "Singapore dollar",
  TRY: "Turkish lira",
  TWD: "New Taiwan dollar",
  ZAR: "South African rand",
} as const;

export type CurrencyCode = keyof typeof CURRENCY_NAMES;

export const DEFAULT_CURRENCY: CurrencyCode = "EUR";

/** Selection order, and the accepted values for the settings route. */
export const CURRENCY_CODES = Object.keys(CURRENCY_NAMES) as [CurrencyCode, ...CurrencyCode[]];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCY_NAMES, value);
}

/** "Euro (EUR)" — the name people read, the code they may be looking for. */
export function currencyLabel(code: CurrencyCode): string {
  return `${CURRENCY_NAMES[code]} (${code})`;
}
