import { isTimeout, withDeadline } from "../deadline";
import { classify, type SkodaError } from "./errors";

/**
 * The read-only slice of the MySkoda Public API EVBook uses: one composite GET,
 * `GET /api/v1/vehicles/{vin}`, with the owner's key in `X-API-Key`.
 *
 * The same host also takes charging, climate and heating commands. None of them
 * is called, and there is no function here that could: `read` is the only
 * request this module builds, and `READ_PATH` is the only path it builds it for.
 *
 * Contract: https://public.api.connect.skoda-auto.cz/v3/api-docs (OpenAPI 3.1,
 * 83,120 bytes, SHA-256 9702fbc6…a60 on 16 Nov 2026). Personal use only: Škoda
 * points commercial users to its Charging Data API.
 */

export const API_HOST = "https://public.api.connect.skoda-auto.cz";

/** The one path EVBook reads. Exported so the tests can hold the client to it. */
export const READ_PATH = /^\/api\/v1\/vehicles\/[A-Z0-9]{17}$/;

/**
 * The sections asked for, explicitly: a section asked for and not available
 * comes back as a named error (`CHARGING_UNAVAILABLE`), where one left to the
 * default would simply be missing. `airConditioning` and `operations` are not
 * mapped yet; they are asked for so the raw snapshot keeps them.
 */
export const INCLUDE = ["info", "status", "charging", "odometer", "parkingPosition", "airConditioning"] as const;

/** What the response headers say about the key and its quota. */
export interface RateInfo {
  /** The quota per window (20 an hour today). */
  limit: number | null;
  remaining: number | null;
  /** Milliseconds until the window refills (Škoda sends seconds, not a timestamp). */
  resetInMs: number | null;
  /** When the key lapses, epoch ms. */
  keyExpiresAt: number | null;
}

export type ReadResult =
  { ok: true; value: unknown; raw: string; rate: RateInfo } | { ok: false; error: SkodaError; rate: RateInfo };

/** Observed answers are a few KiB; anything near this is not an answer. */
const MAX_BODY = 1 << 20;
const TIMEOUT_MS = 30_000;

function int(value: string | null): number | null {
  if (value == null || !/^\s*\d+\s*$/.test(value)) return null;
  return Number(value.trim());
}

export function rateOf(headers: Headers): RateInfo {
  const reset = int(headers.get("ratelimit-reset"));
  const expires = headers.get("x-api-key-expires-at");
  const expiresAt = expires ? Date.parse(expires) : NaN;
  return {
    limit: int(headers.get("ratelimit-limit")),
    remaining: int(headers.get("ratelimit-remaining")),
    resetInMs: reset === null ? null : reset * 1000,
    keyExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
}

const NO_RATE: RateInfo = { limit: null, remaining: null, resetInMs: null, keyExpiresAt: null };

/** A VIN as Škoda's path takes it: 17 letters and digits, upper case. Null when it is not one. */
export function normalizeVin(vin: string): string | null {
  const v = vin.trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(v) ? v : null;
}

export class SkodaClient {
  /** Requests sent: what the quota counts, failures included. */
  calls = 0;

  constructor(
    private readonly host: string = API_HOST,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async read(vin: string, apiKey: string): Promise<ReadResult> {
    const path = `/api/v1/vehicles/${encodeURIComponent(vin)}`;
    if (!READ_PATH.test(path)) {
      return { ok: false, error: { kind: "bad_request", status: 0, message: "not a VIN" }, rate: NO_RATE };
    }
    this.calls += 1;
    try {
      return await withDeadline(TIMEOUT_MS, async (signal) => {
        const res = await this.fetchImpl(`${this.host}${path}?include=${INCLUDE.join(",")}`, {
          method: "GET",
          headers: { "x-api-key": apiKey, accept: "application/json", "accept-encoding": "gzip" },
          signal,
        });
        const rate = rateOf(res.headers);
        const body = await res.text();
        if (body.length > MAX_BODY) {
          return {
            ok: false,
            error: { kind: "unavailable", status: res.status, message: "response too large" },
            rate,
          };
        }
        if (!res.ok) return { ok: false, error: classify(res.status, body, res.headers.get("retry-after")), rate };
        try {
          return { ok: true, value: JSON.parse(body) as unknown, raw: body, rate };
        } catch {
          return {
            ok: false,
            error: { kind: "unavailable", status: res.status, message: "response is not JSON" },
            rate,
          };
        }
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          status: 0,
          message: isTimeout(error) ? "timed out" : error instanceof Error ? error.message : String(error),
        },
        rate: NO_RATE,
      };
    }
  }
}
