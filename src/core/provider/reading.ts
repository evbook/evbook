/**
 * A provider's readings, and the small JSON helpers its normalizer reads the
 * maker's answer with. Shared so every normalizer keeps the same two rules
 * (docs/providers.md): absent is not zero, and a value of the wrong type is
 * unknown, never coerced.
 */

/** A value, the car's own time for it (epoch ms, null when the maker gives none), and when EVBook last saw it. */
export interface Reading<T> {
  v: T;
  at: number | null;
  seen: number;
}

/** A reading, or null when the value is unknown. */
export function reading<T>(v: T | null, at: number | null, seen: number): Reading<T> | null {
  return v === null ? null : { v, at, seen };
}

export type Json = Record<string, unknown>;

/** An object, or null for anything else (arrays included). */
export function obj(x: unknown): Json | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : null;
}

/** A finite number, or null. */
export function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** A non-empty string, or null. */
export function str(x: unknown): string | null {
  return typeof x === "string" && x !== "" ? x : null;
}

/** An ISO 8601 / RFC 3339 time, any offset, as epoch ms; null when it is not one. */
export function time(x: unknown): number | null {
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}
