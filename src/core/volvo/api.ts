import { isTimeout, withDeadline } from "../deadline";
import { classify, type VolvoError } from "./errors";

/**
 * The read-only slice of the Volvo Cars API EVBook uses: Connected Vehicle v2,
 * Energy v2 and Location v1. Every call carries two credentials — the Volvo ID
 * access token and the application's `vcc-api-key` — and every call is a GET.
 * The command endpoints are never called: there is no function here that could.
 */

export const DEFAULT_API_HOST = "https://api.volvocars.com";

/** The three separately metered APIs. Each has its own daily quota per key. */
export type VolvoApi = "connected-vehicle" | "energy" | "location";

export type Endpoint =
  | "details"
  | "engine-status"
  | "odometer"
  | "statistics"
  | "diagnostics"
  | "brakes"
  | "engine"
  | "tyres"
  | "warnings"
  | "doors"
  | "windows"
  | "energy-state"
  | "energy-capabilities"
  | "location";

export function apiOf(endpoint: Endpoint): VolvoApi {
  if (endpoint === "energy-state" || endpoint === "energy-capabilities") return "energy";
  if (endpoint === "location") return "location";
  return "connected-vehicle";
}

export function pathOf(endpoint: Endpoint, vin: string): string {
  const v = encodeURIComponent(vin);
  switch (endpoint) {
    case "details":
      return `/connected-vehicle/v2/vehicles/${v}`;
    case "energy-state":
      return `/energy/v2/vehicles/${v}/state`;
    case "energy-capabilities":
      return `/energy/v2/vehicles/${v}/capabilities`;
    case "location":
      return `/location/v1/vehicles/${v}/location`;
    default:
      return `/connected-vehicle/v2/vehicles/${v}/${endpoint}`;
  }
}

export interface Credentials {
  token: string;
  apiKey: string;
}

export type ApiResult<T> = { ok: true; value: T; raw: string } | { ok: false; error: VolvoError };

/** Observed bodies are under 4 KiB; anything near this is not an answer. */
const MAX_BODY = 1 << 20;
const TIMEOUT_MS = 30_000;
/** A key minutes old is refused at random for its first hour: try it again. */
const KEY_ATTEMPTS = 3;

export class VolvoClient {
  /** Calls made, by API, including retries — what the quota counts. */
  readonly calls: Record<VolvoApi, number> = { "connected-vehicle": 0, energy: 0, location: 0 };

  constructor(
    private readonly host: string = DEFAULT_API_HOST,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async get(endpoint: Endpoint, vin: string, creds: Credentials): Promise<ApiResult<unknown>> {
    return this.request(apiOf(endpoint), pathOf(endpoint, vin), creds);
  }

  /** The VINs the grant can read: `{"data":[{"vin":"…"}]}`. */
  async listVins(creds: Credentials): Promise<ApiResult<string[]>> {
    const result = await this.request("connected-vehicle", "/connected-vehicle/v2/vehicles", creds);
    if (!result.ok) return result;
    const data = (result.value as { data?: unknown }).data;
    const vins = Array.isArray(data)
      ? data
          .map((row) => (row && typeof row === "object" ? (row as { vin?: unknown }).vin : null))
          .filter((vin): vin is string => typeof vin === "string" && vin.length > 0)
      : [];
    return { ok: true, value: vins, raw: result.raw };
  }

  private async request(api: VolvoApi, path: string, creds: Credentials): Promise<ApiResult<unknown>> {
    let last: ApiResult<unknown> | null = null;
    for (let attempt = 0; attempt < KEY_ATTEMPTS; attempt++) {
      last = await this.once(api, path, creds);
      if (last.ok || last.error.kind !== "key_refused") return last;
    }
    return last!;
  }

  private async once(api: VolvoApi, path: string, creds: Credentials): Promise<ApiResult<unknown>> {
    this.calls[api] += 1;
    try {
      return await withDeadline(TIMEOUT_MS, async (signal) => {
        const res = await this.fetchImpl(`${this.host}${path}`, {
          headers: {
            authorization: `Bearer ${creds.token}`,
            "vcc-api-key": creds.apiKey,
            accept: "application/json",
          },
          signal,
        });
        const body = await res.text();
        if (body.length > MAX_BODY) {
          return { ok: false, error: { kind: "unavailable", status: res.status, message: "response too large" } };
        }
        if (!res.ok) return { ok: false, error: classify(res.status, body, res.headers.get("retry-after")) };
        try {
          return { ok: true, value: JSON.parse(body) as unknown, raw: body };
        } catch {
          return { ok: false, error: { kind: "unavailable", status: res.status, message: "response is not JSON" } };
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
      };
    }
  }
}
