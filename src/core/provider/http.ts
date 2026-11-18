/**
 * HTTP details every provider's client reads the same way.
 */

/**
 * `Retry-After` in milliseconds from `now`: seconds, or an HTTP date. Null when
 * absent or unreadable.
 */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
