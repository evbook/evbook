import type { PleosBrand } from "@shared/api-types";
import { isTimeout, withDeadline } from "../deadline";
import { normalizeVin } from "../provider/vin";
import { classify, classifyToken, type PleosError } from "./errors";

/**
 * The read-only slice of the Pleos Vehicle Data API EVBook uses, for a
 * personal key ("My Vehicle Data API" in Pleos Playground): Hyundai, Kia and
 * Genesis in Europe.
 *
 *   POST /v1/auth/personal-token        the key → an access token (about an hour)
 *   GET  /v1/vehicles/consent           the cars on the key
 *   GET  /v1/vehicles/{vin}/batteries   state of charge, plug, charging, targets
 *   GET  /v1/vehicles/{vin}/driving     ignition, high-voltage system, park, odometer
 *   GET  /v1/vehicles/{vin}/locations   position, heading, speed
 *   GET  /v1/vehicles/{vin}/powertrains range
 *
 * Every request carries the make in a `Brand` header; the token, the header
 * and the VIN must agree. The API has no commands, and none of these reads
 * wakes the car: each answers with what the car last uploaded. The business
 * route's consent and revocation calls (`POST /v1/vehicles/selections`,
 * `DELETE /v1/vehicles/consent`) are not here, and neither is anything else:
 * `PATHS` is the whole list, and the fake holds the client to it.
 *
 * Contract: developers.pleos.ai, Vehicle Data API (read 15-16 Nov 2026), and
 * what independent clients observed on the live personal route (tmp/ plan
 * §8.1a, §8.6a). No sandbox exists; nothing here has been run against Pleos.
 */

export const API_HOST = "https://api.pleos.ai";

export const READS = ["batteries", "driving", "locations", "powertrains"] as const;
export type Endpoint = (typeof READS)[number];

/** Every path this client builds. Exported so the fake and the tests can hold it to them. */
export const PATHS = {
  token: /^\/v1\/auth\/personal-token$/,
  consent: /^\/v1\/vehicles\/consent$/,
  read: /^\/v1\/vehicles\/[A-HJ-NPR-Z0-9]{17}\/(batteries|driving|locations|powertrains)$/,
} as const;

/** Observed answers are a few KiB; anything near this is not an answer. */
const MAX_BODY = 1 << 20;
const TIMEOUT_MS = 30_000;
/** An access token whose expiry cannot be read is taken to last this long (the observed hour, less a margin). */
const FALLBACK_TOKEN_MS = 50 * 60_000;

export type Result<T> = { ok: true; value: T; raw: string } | { ok: false; error: PleosError };

export interface Token {
  token: string;
  /** When Pleos stops accepting it: the JWT's `exp`. */
  expiresAt: number;
}

/** A car on the key, as the consent list names it. */
export interface ConsentVehicle {
  vin: string;
  /** Pleos's powertrain code: EV, PE (plug-in), HV, GN, FV, UNKNOWN. */
  type: string;
  /** The model code ("AEEV"). */
  model: string | null;
  /** The sales name ("IONIQ 5"). */
  sellName: string | null;
  /** What the owner called the car in the maker's app. */
  nickname: string | null;
}

/**
 * When a token expires, from its `exp` claim. The signature is not checked:
 * Pleos publishes no key, and the claim only schedules the next token. Null
 * when the token is not a JWT with a numeric `exp`.
 */
export function tokenExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(part.length / 4) * 4, "=");
    const claims = JSON.parse(atob(base64)) as { exp?: unknown };
    return typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Pleos's `meta.success` is a boolean on the wire and the string "true" in its documentation. */
function failedMeta(root: Record<string, unknown>): boolean {
  const meta = root.meta && typeof root.meta === "object" ? (root.meta as Record<string, unknown>) : null;
  const success = meta?.success;
  return success === false || success === "false";
}

/** The `data` of a successful answer, or null when the body is not one. */
export function dataOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;
  if (failedMeta(root) || root.error) return null;
  const data = root.data;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** The consent list's cars, each checked; anything that is not a car is dropped. */
export function consentVehicles(data: Record<string, unknown>): ConsentVehicle[] {
  const list = Array.isArray(data.vehicles) ? data.vehicles : [];
  const out: ConsentVehicle[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const vin = typeof v.vin === "string" ? normalizeVin(v.vin) : null;
    if (vin === null) continue;
    const text = (x: unknown) => (typeof x === "string" && x.trim() !== "" ? x.trim().slice(0, 60) : null);
    out.push({
      vin,
      type: text(v.type)?.toUpperCase() ?? "UNKNOWN",
      model: text(v.name),
      sellName: text(v.sellname),
      nickname: text(v.nickname),
    });
  }
  return out;
}

/** Whether EVBook logs a car of this type: electric and plug-in hybrid. */
export function isLoggable(vehicle: ConsentVehicle): boolean {
  return vehicle.type === "EV" || vehicle.type === "PE";
}

export class PleosClient {
  /** Requests sent, failures included. */
  calls = 0;

  constructor(
    private readonly host: string = API_HOST,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** A new access token for the key. Each one replaces the key's previous token. */
  async token(brand: PleosBrand, clientId: string, clientSecret: string): Promise<Result<Token>> {
    const result = await this.send("POST", "/v1/auth/personal-token", brand, null, { clientId, clientSecret }, true);
    if (!result.ok) return result;
    const data = dataOf(result.value);
    const token = data && typeof data.accessToken === "string" && data.accessToken !== "" ? data.accessToken : null;
    if (!token) {
      return { ok: false, error: { kind: "unavailable", status: 200, code: null, message: "no accessToken" } };
    }
    // The answer is not kept: it holds the token.
    return { ok: true, value: { token, expiresAt: tokenExpiry(token) ?? Date.now() + FALLBACK_TOKEN_MS }, raw: "" };
  }

  /** The cars on the key: fixed when the key was issued. */
  async vehicles(brand: PleosBrand, token: string): Promise<Result<ConsentVehicle[]>> {
    const result = await this.send("GET", "/v1/vehicles/consent", brand, token);
    if (!result.ok) return result;
    const data = dataOf(result.value);
    if (!data) return { ok: false, error: { kind: "unavailable", status: 200, code: null, message: "not an answer" } };
    return { ok: true, value: consentVehicles(data), raw: result.raw };
  }

  /** One of the car's readings. The value is the whole answer, `data` and `meta`, as it came. */
  async read(brand: PleosBrand, token: string, vin: string, endpoint: Endpoint): Promise<Result<unknown>> {
    const path = `/v1/vehicles/${encodeURIComponent(vin)}/${endpoint}`;
    if (!PATHS.read.test(path)) {
      return { ok: false, error: { kind: "bad_request", status: 0, code: null, message: "not a VIN" } };
    }
    const result = await this.send("GET", path, brand, token);
    if (result.ok && !dataOf(result.value)) {
      return { ok: false, error: { kind: "unavailable", status: 200, code: null, message: "not an answer" } };
    }
    return result;
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    brand: PleosBrand,
    token: string | null,
    body: unknown = null,
    isToken = false,
  ): Promise<Result<unknown>> {
    this.calls += 1;
    const headers: Record<string, string> = { Brand: brand, accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== null) headers["content-type"] = "application/json";
    try {
      return await withDeadline(TIMEOUT_MS, async (signal) => {
        const res = await this.fetchImpl(`${this.host}${path}`, {
          method,
          headers,
          body: body === null ? undefined : JSON.stringify(body),
          signal,
        });
        const text = await res.text();
        const fail = (message: string): Result<unknown> => ({
          ok: false,
          error: { kind: "unavailable", status: res.status, code: null, message },
        });
        if (text.length > MAX_BODY) return fail("response too large");
        if (!res.ok) {
          const retryAfter = res.headers.get("retry-after");
          const error = isToken ? classifyToken(res.status, text, retryAfter) : classify(res.status, text, retryAfter);
          return { ok: false, error };
        }
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          return fail("response is not JSON");
        }
        // A 200 can still carry an error in its body; classify it by its code.
        if (value && typeof value === "object" && (value as Record<string, unknown>).error) {
          const error = isToken ? classifyToken(400, text) : classify(400, text);
          return { ok: false, error };
        }
        return { ok: true, value, raw: text };
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "unavailable",
          status: 0,
          code: null,
          message: isTimeout(error) ? "timed out" : error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
