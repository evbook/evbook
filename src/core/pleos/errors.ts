import type { PleosRefusedReason } from "@shared/api-types";
import { retryAfterMs } from "../provider/http";

/**
 * What a failed Pleos Vehicle Data API call means, and what to do about it.
 *
 * Pleos answers an error with `{"error": {"code", "message", "requestId", …}}`.
 * The status alone does not say enough: the documentation lists an invalid
 * token, a missing permission and a bad parameter all under HTTP 400, told
 * apart only by `error.code`, while the live API answers a token another
 * program has replaced with HTTP 403 and a *numeric* code 403. So the
 * classification reads both, and takes the code as a string or a number.
 *
 * Sources: Pleos's error-code page (business route) and what five independent
 * clients observed on the personal route (tmp/ plan §8.7, §8.7a).
 */

export type PleosErrorKind =
  /** The access token was refused (401, 403, 4011, 40003, 40004). Get a new one once and retry. */
  | "token_refused"
  /** `personal-token` refused the key: revoked, reissued, expired, or not this make's. The owner acts. */
  | "key_refused"
  /** 5006 or 410 / 4101: the car is not shared through this key (any more). */
  | "not_shared"
  /** 4045: no data for the car. Connected services off, data collection not agreed, e-Privacy on, or none yet. */
  | "no_data"
  /** 400 / 4002, 40001, 40002, or an unknown path: EVBook asked for something the contract does not know. */
  | "bad_request"
  /** 429. Pleos publishes no quota; wait as told, or a while. */
  | "rate_limited"
  /** 5xx, a timeout, a body that is not the envelope: transient. */
  | "unavailable";

export interface PleosError {
  kind: PleosErrorKind;
  status: number;
  /** Pleos's `error.code`, as a string; null when the body had none. */
  code: string | null;
  /** How long to stay away, for a rate limit or an outage. */
  retryInMs?: number;
  /**
   * Pleos's words and request id, for logs only. Nothing the owner reads is
   * built from them: the kind is what the UI shows.
   */
  message: string;
}

const MAX_MESSAGE = 200;
/** No Retry-After on a 429: what the more careful of two clients waits. */
const DEFAULT_RATE_WAIT_MS = 15 * 60_000;
/** Never come back sooner than this after a 429, whatever Retry-After says. */
const MIN_RATE_WAIT_MS = 5 * 60_000;
const DEFAULT_UNAVAILABLE_WAIT_MS = 5 * 60_000;

const TOKEN_CODES = new Set(["401", "403", "4011", "40003", "40004"]);
const NOT_SHARED_CODES = new Set(["5006", "4101"]);
const BAD_REQUEST_CODES = new Set(["4002", "40001", "40002", "404"]);

/** `error.code`, the request id and a short message, whatever the body. */
export function errorOf(body: string): { code: string | null; message: string } {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const root = parsed as Record<string, unknown>;
      const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : null;
      const meta = root.meta && typeof root.meta === "object" ? (root.meta as Record<string, unknown>) : null;
      const raw = error?.code ?? meta?.code;
      const code = typeof raw === "number" || (typeof raw === "string" && raw !== "") ? String(raw) : null;
      const words = [error?.message ?? meta?.message, error?.requestId ?? meta?.requestId]
        .filter((p): p is string => typeof p === "string" && p !== "")
        .join(" · ");
      return { code, message: words.slice(0, MAX_MESSAGE) };
    }
  } catch {
    // Not JSON (a gateway's HTML page): fall through to the raw text.
  }
  return { code: null, message: trimmed.slice(0, MAX_MESSAGE) };
}

/** A failed data or consent read. */
export function classify(status: number, body: string, retryAfter: string | null = null): PleosError {
  const { code, message } = errorOf(body);
  const base = { status, code, message };
  if (status === 429) {
    const wait = retryAfterMs(retryAfter);
    return { ...base, kind: "rate_limited", retryInMs: Math.max(wait ?? DEFAULT_RATE_WAIT_MS, MIN_RATE_WAIT_MS) };
  }
  if (code !== null && NOT_SHARED_CODES.has(code)) return { ...base, kind: "not_shared" };
  if (status === 410) return { ...base, kind: "not_shared" };
  if (code === "4045") return { ...base, kind: "no_data" };
  if (code !== null && TOKEN_CODES.has(code)) return { ...base, kind: "token_refused" };
  if (status === 401 || status === 403) return { ...base, kind: "token_refused" };
  if (code !== null && BAD_REQUEST_CODES.has(code)) return { ...base, kind: "bad_request" };
  if (status === 404) return { ...base, kind: "no_data" };
  if (status >= 400 && status < 500) return { ...base, kind: "bad_request" };
  const wait = retryAfterMs(retryAfter);
  return { ...base, kind: "unavailable", retryInMs: wait ?? DEFAULT_UNAVAILABLE_WAIT_MS };
}

/**
 * A failed `personal-token` call. Pleos's own refusal (a 401, or its error
 * envelope with a code: `40404` "user or key not found", a wrong secret's 400)
 * means the key is no good: the owner has to issue a new one, and nothing
 * retries it on a timer. A 4xx that is not Pleos's answer (a gateway's or a
 * firewall's page, a 408) says nothing about the key: it is transient, so a
 * working key is never stopped over it.
 */
export function classifyToken(status: number, body: string, retryAfter: string | null = null): PleosError {
  const { code, message } = errorOf(body);
  if (status === 429 || status >= 500) return classify(status, body, retryAfter);
  const timedOut = status === 408 || status === 425;
  if (status >= 400 && !timedOut && (status === 401 || code !== null)) {
    return { kind: "key_refused", status, code, message };
  }
  return { kind: "unavailable", status, code, message, retryInMs: DEFAULT_UNAVAILABLE_WAIT_MS };
}

/** Everything that can stand between EVBook and a car's readings: Pleos's errors, and EVBook's own. */
export type PleosFailure =
  | Exclude<PleosErrorKind, "token_refused">
  /** No key is stored for the car's account. */
  | "no_key"
  /** Another program keeps replacing EVBook's token for the same key: both fail. */
  | "key_shared"
  /** Refused even with a token just issued: the car or this read is not permitted. */
  | "forbidden"
  /** EVBook's own hourly cap of reads for the car is reached: Pleos said nothing. */
  | "own_cap"
  /** The car's upload time is in the future, so no reading counts as fresh (core/pleos/normalize.ts, `ageMs`). */
  | "clock_ahead";

/** `pleos_keys.refused_reason` as stored; anything this build does not know reads as a refused key. */
export function refusedReasonOf(stored: string | null): PleosRefusedReason | null {
  return stored === null ? null : "key_refused";
}

/**
 * What the owner reads. Never Pleos's own message: the kind decides the words.
 * On the car card and the account row, for a car EVBook is already reading.
 */
export const FAILURE_TEXT: Record<PleosFailure, string> = {
  key_refused:
    "Pleos no longer accepts the key (revoked, reissued or expired) — issue a new one in Pleos Playground and paste it in Settings",
  key_shared:
    "Another program is using the same Pleos key, and each one's token cancels the other's — give EVBook a key of its own",
  not_shared: "This car is no longer shared through the Pleos key — reissue the key in Pleos Playground",
  forbidden: "Pleos refused this car's data even with a fresh token — EVBook will try again in an hour",
  own_cap: "EVBook reached its own hourly limit of reads for this car — it carries on when there is room",
  clock_ahead:
    "The car reports a time in the future, so its drives and charges cannot be recognised — a fault in the maker's data that EVBook does not correct",
  no_data:
    "Pleos has no data from the car yet — check that connected services and data sharing are on in the car and its app",
  bad_request: "Pleos refused EVBook's request — this is a bug in EVBook",
  rate_limited: "Pleos asked EVBook to slow down",
  unavailable: "Pleos's API did not answer",
  no_key: "No Pleos key — add one in Settings",
};

/** On the connect form, for a key that was just pasted and checked. */
export const CHECK_TEXT: Record<"key_refused" | "rate_limited" | "unavailable" | "bad_request", string> = {
  key_refused:
    "Pleos did not accept this key. Check the make, and copy the Client ID and Client Secret again from Pleos Playground → My Vehicle Data API.",
  rate_limited: "Pleos asked EVBook to slow down. Try again in a few minutes.",
  unavailable: "Pleos's API did not answer. Try again in a minute.",
  bad_request: "Pleos refused the request. This is a bug in EVBook.",
};
