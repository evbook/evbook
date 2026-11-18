import type { SkodaRefusedReason } from "@shared/api-types";
import { retryAfterMs } from "../provider/http";

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

/** Everything that can stand between EVBook and a Škoda's readings: Škoda's errors, and two of EVBook's own. */
export type SkodaFailure =
  | SkodaErrorKind
  /** No key is stored for the car's account. */
  | "no_key"
  /** The key answered for a different VIN than it was saved for. */
  | "wrong_car";

const REFUSED_REASONS: readonly SkodaRefusedReason[] = ["key_expired", "not_authorized", "not_found", "wrong_car"];

/** `skoda_keys.refused_reason` as stored; a value this build does not know reads as a lapsed key. */
export function refusedReasonOf(stored: string | null): SkodaRefusedReason | null {
  if (stored === null) return null;
  return (REFUSED_REASONS as readonly string[]).includes(stored) ? (stored as SkodaRefusedReason) : "key_expired";
}

/**
 * What the owner reads, in the two places a failure is shown. Never Škoda's
 * own message, which can carry the VIN. The reasons a key is refused for
 * (`SkodaRefusedReason`) are failure kinds, so both tables answer for them.
 */

/** On the car card and the account row, for a car EVBook is already reading. */
export const FAILURE_TEXT: Record<SkodaFailure, string> = {
  key_expired: "Škoda no longer accepts the API key — create a new one in the MySkoda app and paste it in Settings",
  not_authorized: "Škoda's API key does not cover this car — check the key in Settings",
  not_found: "Škoda knows no car with this VIN on the key — check the key in Settings",
  bad_request: "Škoda refused EVBook's request — this is a bug in EVBook",
  rate_limited: "Škoda's hourly request quota is used up",
  vehicle_refused: "The car is not accepting requests right now (often a low 12 V battery)",
  unavailable: "Škoda's API did not answer",
  no_key: "No Škoda API key — add one in Settings",
  wrong_car: "Škoda answered for a different car than this key was saved for — check the key in Settings",
};

/** On the connect form, for a key that was just pasted and checked. */
export const CHECK_TEXT: Record<Exclude<SkodaFailure, "no_key">, string> = {
  key_expired: "Škoda says this key has expired or was revoked. Create a new one in the MySkoda app.",
  not_authorized: "This key does not cover this car. Check that the key was created for this VIN.",
  not_found: "Škoda knows no car with this VIN on this key. Check the VIN.",
  bad_request: "Škoda refused the request. Check the VIN.",
  rate_limited: "Škoda's hourly quota for this key is used up. Try again later.",
  vehicle_refused: "The car is not accepting requests right now (often a low 12 V battery). Try again later.",
  unavailable: "Škoda's API did not answer. Try again in a minute.",
  wrong_car: "Škoda answered for a different car than this VIN.",
};
