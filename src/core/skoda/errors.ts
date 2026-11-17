/**
 * What a failed MySkoda Public API call means, and what to do about it.
 *
 * Škoda answers errors as RFC 9457 `application/problem+json`, and two causes
 * can share a status: a 429 is either the key's hourly quota or the car
 * declining requests (a weak battery, or too many in a row). The problem `type`
 * tells them apart, so the classification reads it, not only the status.
 */

export type SkodaErrorKind =
  /** 401: the key lapsed or was revoked. Nothing works until the owner pastes a new one. */
  | "key_expired"
  /** 403: the key does not cover this car (or this operation). The owner reviews the key. */
  | "not_authorized"
  /** 404: no car with this VIN on the key. */
  | "not_found"
  /** 400: EVBook asked for something the contract does not know. A bug, not a retry. */
  | "bad_request"
  /** 429 rate-limit-exceeded: the hourly quota is spent; wait for it. */
  | "rate_limited"
  /** 429 vehicle-not-accepting-requests, or 504: the car said no. Back off. */
  | "vehicle_refused"
  /** 5xx, a timeout, a body that is not JSON: transient. */
  | "unavailable";

export interface SkodaError {
  kind: SkodaErrorKind;
  status: number;
  /** For rate limits, refusals and 503: how long to stay away. */
  retryInMs?: number;
  /**
   * Škoda's words, for logs only. They can carry the VIN, so nothing the owner
   * sees is built from them: the kind is what the UI shows.
   */
  message: string;
}

const MAX_MESSAGE = 200;
/** 503 "the API key could not be validated" with no Retry-After: Škoda's own client waits ten seconds. */
const DEFAULT_UNAVAILABLE_WAIT_MS = 10_000;
const DEFAULT_RATE_WAIT_MS = 15 * 60_000;
const DEFAULT_REFUSED_WAIT_MS = 15 * 60_000;

interface Problem {
  type: string;
  message: string;
}

/** The problem's type (its last path segment) and a human message, whatever the body. */
export function problemOf(body: string): Problem {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      const type = typeof o.type === "string" ? (o.type.split("/").pop() ?? "") : "";
      const parts = [o.title, o.detail].filter((p): p is string => typeof p === "string" && p !== "");
      return { type, message: parts.join(": ").slice(0, MAX_MESSAGE) };
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return { type: "", message: trimmed.slice(0, MAX_MESSAGE) };
}

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

export function classify(status: number, body: string, retryAfter: string | null = null): SkodaError {
  const { type, message } = problemOf(body);
  const wait = retryAfterMs(retryAfter);
  if (status === 401) return { kind: "key_expired", status, message };
  if (status === 403) return { kind: "not_authorized", status, message };
  if (status === 404) return { kind: "not_found", status, message };
  if (status === 400) return { kind: "bad_request", status, message };
  if (status === 429) {
    // The car declining is told apart by type; an untyped 429 is taken as the
    // quota, which is the cautious reading (it waits for the window).
    if (type === "vehicle-not-accepting-requests") {
      return { kind: "vehicle_refused", status, message, retryInMs: wait ?? DEFAULT_REFUSED_WAIT_MS };
    }
    return { kind: "rate_limited", status, message, retryInMs: wait ?? DEFAULT_RATE_WAIT_MS };
  }
  if (status === 504) return { kind: "vehicle_refused", status, message, retryInMs: wait ?? DEFAULT_REFUSED_WAIT_MS };
  if (status === 503) return { kind: "unavailable", status, message, retryInMs: wait ?? DEFAULT_UNAVAILABLE_WAIT_MS };
  return { kind: "unavailable", status, message, ...(wait !== null ? { retryInMs: wait } : {}) };
}

/** Whether the key itself is the problem: polling stops until the owner acts. */
export function isKeyRefusal(kind: SkodaErrorKind): kind is "key_expired" | "not_authorized" | "not_found" {
  return kind === "key_expired" || kind === "not_authorized" || kind === "not_found";
}
