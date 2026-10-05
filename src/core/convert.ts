/** Unit conversions — 1:1 port of TeslaMate's lib/teslamate/convert.ex. */

const KM_FACTOR = 0.62137119223733;

function roundTo(value: number, precision: number): number {
  if (precision === 0) return Math.round(value);
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}

export function mphToKmh(mph: number | null | undefined): number | null {
  if (mph == null) return null;
  return Math.round(mph / KM_FACTOR);
}

export function milesToKm(mi: number | null | undefined, precision: number): number | null {
  if (mi == null) return null;
  return roundTo(mi / KM_FACTOR, precision);
}

export function kmToMiles(km: number | null | undefined, precision: number): number | null {
  if (km == null) return null;
  return roundTo(km * KM_FACTOR, precision);
}

export function celsiusToFahrenheit(c: number | null | undefined, precision: number): number | null {
  if (c == null) return null;
  return roundTo((c * 9) / 5 + 32, precision);
}

/** Humanized duration, two coarsest non-zero units (e.g. ["2 h", "5 min"]). */
export function secToStr(sec: number): string[] {
  const divisors = [604800, 86400, 3600, 60, 1];
  const units = ["wk", "d", "h", "min", "s"];
  let rest = Math.trunc(sec);
  const parts: string[] = [];
  for (const [i, divisor] of divisors.entries()) {
    const n = Math.trunc(rest / divisor);
    rest = rest % divisor;
    if (n !== 0) parts.push(`${n} ${units[i]}`);
  }
  return parts.slice(0, 2);
}
