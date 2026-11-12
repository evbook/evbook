/**
 * What a failed Volvo Cars API call means, and what to do about it.
 *
 * Several distinct conditions share a status code — a refused application key
 * and a refused access token are both 401/403, a market Volvo does not serve
 * and an unknown VIN are both 404 — so the classification reads the message,
 * not only the status. Volvo answers in four body shapes, all handled here.
 */

export type VolvoErrorKind =
  /** 403 "Out of call volume quota": block this API (only) until `retryInMs`. */
  | "quota"
  /** The vcc-api-key was refused. New keys flake for their first hour; retry. */
  | "key_refused"
  /** The access token was refused: refresh once, then the grant is likely gone. */
  | "unauthorized"
  /** 429: pause the car until `retryInMs`. */
  | "rate_limited"
  /** 404 "does not belong to allowed markets": permanent for this car. */
  | "market"
  /** Any other 404: unknown VIN, or removed from the account. */
  | "not_found"
  /** A 403 with no message we recognise: this endpoint is refused for this car. */
  | "forbidden"
  /** 5xx, a non-JSON 200, a timeout, no answer at all: transient. */
  | "unavailable";

export interface VolvoError {
  kind: VolvoErrorKind;
  status: number;
  /** For quota and rate limits: how long to stay away. */
  retryInMs?: number;
  /**
   * The vendor's message, for logs only. It can carry the VIN from the URL, so
   * nothing user-facing is built from it — the kind is what the UI shows.
   */
  message: string;
}

const MAX_MESSAGE = 200;
const KEY_REFUSED = /(subscription|vcc-api|api)[ -]?key/i;
const QUOTA = /out of call volume quota/i;
const MARKET = /does not belong to allowed markets/i;
const DEFAULT_QUOTA_WAIT_MS = 60 * 60_000;
const DEFAULT_RATE_WAIT_MS = 60_000;

/** The human message in any of the four error bodies Volvo is known to send. */
export function errorMessage(body: string): string {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      const nested = o.error;
      if (nested && typeof nested === "object") {
        const n = nested as Record<string, unknown>;
        const parts = [n.message, n.description].filter((p): p is string => typeof p === "string" && p !== "");
        if (parts.length) return parts.join(": ").slice(0, MAX_MESSAGE);
      }
      if (typeof o.message === "string") return o.message.slice(0, MAX_MESSAGE);
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return trimmed.slice(0, MAX_MESSAGE);
}

/** "Quota will be replenished in 18:00:00." → 18 h, in ms. */
export function quotaWaitMs(message: string): number | null {
  const m = /replenished in (\d+):(\d{2}):(\d{2})/i.exec(message);
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

/** `Retry-After` (seconds) wins, then "in N seconds" in the message. */
export function rateLimitWaitMs(retryAfter: string | null, message: string): number | null {
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) return Number(retryAfter.trim()) * 1000;
  const m = /in (\d+) seconds?/i.exec(message);
  return m ? Number(m[1]) * 1000 : null;
}

export function classify(status: number, body: string, retryAfter: string | null = null): VolvoError {
  const message = errorMessage(body);
  if (status === 403 && QUOTA.test(message)) {
    return { kind: "quota", status, message, retryInMs: quotaWaitMs(message) ?? DEFAULT_QUOTA_WAIT_MS };
  }
  if ((status === 401 || status === 403) && KEY_REFUSED.test(message)) {
    return { kind: "key_refused", status, message };
  }
  if (status === 401) return { kind: "unauthorized", status, message };
  if (status === 429) {
    return {
      kind: "rate_limited",
      status,
      message,
      retryInMs: rateLimitWaitMs(retryAfter, message) ?? DEFAULT_RATE_WAIT_MS,
    };
  }
  if (status === 404 && MARKET.test(message)) return { kind: "market", status, message };
  if (status === 404) return { kind: "not_found", status, message };
  if (status === 403) return { kind: "forbidden", status, message };
  return { kind: "unavailable", status, message };
}
