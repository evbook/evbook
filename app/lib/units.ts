import type { GlobalSettingsDto } from "@shared/api-types";
import { DEFAULT_CURRENCY } from "@shared/currency";

/**
 * Everything is stored in SI (km, °C, bar, kW). Display conversion happens here,
 * driven by the user's unit settings.
 */

const KM_FACTOR = 0.62137119223733;

/**
 * Currency rides along with the units: it is the unit money is counted in, and a
 * component handed `units` is a component that has costs to label. The money
 * formatters themselves live in `format.ts` and take the code, not the whole set.
 */
export type Units = Pick<GlobalSettingsDto, "unitOfLength" | "unitOfTemperature" | "unitOfPressure" | "currency">;

export const DEFAULT_UNITS: Units = {
  unitOfLength: "km",
  unitOfTemperature: "C",
  unitOfPressure: "bar",
  currency: DEFAULT_CURRENCY,
};

function fmt(value: number, digits: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function distance(km: number | null | undefined, units: Units, digits = 0): string {
  if (km == null) return "–";
  const value = units.unitOfLength === "mi" ? km * KM_FACTOR : km;
  return `${fmt(value, digits)} ${units.unitOfLength}`;
}

export function speed(kmh: number | null | undefined, units: Units): string {
  if (kmh == null) return "–";
  const value = units.unitOfLength === "mi" ? kmh * KM_FACTOR : kmh;
  return `${Math.round(value)} ${units.unitOfLength === "mi" ? "mph" : "km/h"}`;
}

export function temperature(celsius: number | null | undefined, units: Units): string {
  if (celsius == null) return "–";
  const value = units.unitOfTemperature === "F" ? (celsius * 9) / 5 + 32 : celsius;
  return `${fmt(value, 1)} °${units.unitOfTemperature}`;
}

const PSI_PER_BAR = 14.503773773;

export function pressure(bar: number | null | undefined, units: Units, digits = 1): string {
  if (bar == null) return "–";
  const value = units.unitOfPressure === "psi" ? bar * PSI_PER_BAR : bar;
  return `${fmt(value, digits)} ${units.unitOfPressure}`;
}

/**
 * A tyre pressure as a plain number in the reader's unit, for a chart's data:
 * bar to the hundredth, the step a slow leak shows up in, psi to the tenth.
 */
export function pressureValue(bar: number | null | undefined, units: Units): number | null {
  if (bar == null) return null;
  return units.unitOfPressure === "psi" ? Math.round(bar * PSI_PER_BAR * 10) / 10 : Math.round(bar * 100) / 100;
}

/** A tyre pressure for a label, at the same precision `pressureValue` charts it. */
export function tyrePressure(bar: number | null | undefined, units: Units): string {
  return pressure(bar, units, units.unitOfPressure === "psi" ? 1 : 2);
}

/**
 * Consumption in watt-hours per unit of distance, converted as well as relabelled.
 *
 * A mile is longer than a kilometre, so it takes *more* Wh — the figure goes up,
 * not down. Four pages used to print the per-100-km number under a "kWh/100 mi"
 * label, understating a miles user's consumption by 38 %, which is not a rounding
 * error but a different car. Only Health had it right, with the conversion inline;
 * every caller goes through here now so there is one place for it to be right in.
 *
 * Per single unit rather than per hundred, because "173 Wh/km" is one number and
 * one short label where "17.3 kWh/100 km" is two of each — and the drives table
 * repeats it on every row, which is where the difference is felt.
 */
export function consumption(kwhPer100km: number | null | undefined, units: Units, digits = 0): string {
  const value = consumptionValue(kwhPer100km, units);
  return value == null ? "–" : `${fmt(value, digits)} Wh/${units.unitOfLength}`;
}

/** The same conversion without the label, for chart data and slider handles. */
export function consumptionValue(kwhPer100km: number | null | undefined, units: Units): number | null {
  if (kwhPer100km == null) return null;
  // Per 100 to per 1 is a factor of ten, kWh to Wh a factor of a thousand.
  return (units.unitOfLength === "mi" ? kwhPer100km / KM_FACTOR : kwhPer100km) * 10;
}

export function power(kw: number | null | undefined): string {
  return kw == null ? "–" : `${fmt(kw, 0)} kW`;
}

export function energy(kwh: number | null | undefined): string {
  return kwh == null ? "–" : `${fmt(kwh, 1)} kWh`;
}

/** "3 h 5 min" style, two coarsest non-zero units — matches TeslaMate. */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "–";
  const divisors: [number, string][] = [
    [604800, "wk"],
    [86400, "d"],
    [3600, "h"],
    [60, "min"],
    [1, "s"],
  ];
  let rest = Math.trunc(seconds);
  const parts: string[] = [];
  for (const [divisor, unit] of divisors) {
    const n = Math.trunc(rest / divisor);
    rest %= divisor;
    if (n !== 0) parts.push(`${n} ${unit}`);
  }
  return parts.slice(0, 2).join(" ") || "0 s";
}

/** Humanized time since a timestamp, e.g. "for 12 min". */
export function since(timestamp: number | null | undefined, now = Date.now()): string {
  if (timestamp == null) return "";
  return duration(Math.max(0, Math.round((now - timestamp) / 1000)));
}

/** Hours as reported by Tesla (fractional) into a duration string. */
export function hours(value: number | null | undefined): string {
  return value == null ? "–" : duration(Math.round(value * 3600));
}

const STATE_LABELS: Record<string, string> = {
  driving: "Driving",
  charging: "Charging",
  updating: "Updating",
  falling_asleep: "Falling asleep",
  online: "Online",
  asleep: "Asleep",
  offline: "Offline",
  unknown: "Unknown",
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}
