import { z } from "zod";
import { isTimeout, withDeadline } from "../deadline";

/**
 * Tesla Owner API client (port of TeslaMate's lib/tesla_api).
 * Only three REST calls exist in the whole ingestion path.
 */

export const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const ProductVehicle = z.object({
  id: z.number(),
  vehicle_id: z.number(),
  vin: z.string(),
  display_name: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
});
export type ProductVehicle = z.infer<typeof ProductVehicle>;

/** Cheap state probe response — never wakes the car. */
export const VehicleProbe = z.object({
  id: z.number(),
  state: z.string().nullable(),
});
export type VehicleProbe = z.infer<typeof VehicleProbe>;

/** What every `command/*` endpoint returns: did the car take it, and if not why. */
export const CommandResponse = z.object({
  result: z.boolean().nullish(),
  reason: z.string().nullish(),
});
export type CommandResponse = z.infer<typeof CommandResponse>;

export type TeslaError =
  | { kind: "unauthorized" }
  | { kind: "vehicle_not_found" }
  | { kind: "vehicle_in_service" }
  | { kind: "vehicle_unavailable" } // 408: asleep — fall back to the cheap probe
  | { kind: "too_many_requests"; retryAfterS: number }
  | { kind: "account_rate_limited"; retryAfterS: number } // 403 EXCEEDED_LIMIT
  | { kind: "timeout" }
  | { kind: "unknown"; status?: number; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: TeslaError };

const VEHICLE_DATA_ENDPOINTS = [
  "charge_state",
  "climate_state",
  "closures_state",
  "drive_state",
  "gui_settings",
  "location_data",
  "vehicle_config",
  "vehicle_state",
  "vehicle_data_combo",
].join(";");

/**
 * The probe reads one small field of metadata, so an answer that has not come
 * back in ten seconds is not coming. The default 35 s belongs to `vehicle_data`,
 * where a car genuinely waking can take its time.
 *
 * The probe answers in a few hundred milliseconds. Production once showed every
 * probe "running to its abort" (35,012 ms against 35,000) — that was not Tesla
 * hanging but `AbortSignal.timeout`'s timer outliving the answer and keeping
 * the Durable Object billed until it fired. `withDeadline` clears it instead.
 */
const PROBE_TIMEOUT_MS = 10_000;

async function mapError(res: Response): Promise<TeslaError> {
  const body = await res.text().catch(() => "");
  switch (res.status) {
    case 401:
      return { kind: "unauthorized" };
    case 404:
      return { kind: "vehicle_not_found" };
    case 405:
      return { kind: "vehicle_in_service" };
    case 408:
      return { kind: "vehicle_unavailable" };
    case 429: {
      const retryAfter = Number(res.headers.get("retry-after"));
      return {
        kind: "too_many_requests",
        retryAfterS: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 300,
      };
    }
    case 403:
      if (body.includes("EXCEEDED_LIMIT")) return { kind: "account_rate_limited", retryAfterS: 900 };
      return { kind: "unknown", status: 403, message: body.slice(0, 200) };
    case 504:
      return { kind: "timeout" };
    default:
      return { kind: "unknown", status: res.status, message: body.slice(0, 200) };
  }
}

async function requestJson<T>(
  url: string,
  accessToken: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<Result<T>> {
  try {
    return await withDeadline(init.timeoutMs ?? 35_000, async (signal): Promise<Result<T>> => {
      const res = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "user-agent": "EVBook",
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal,
      });
      if (!res.ok) return { ok: false, error: await mapError(res) };
      const json = (await res.json()) as { response?: unknown };
      const parsed = schema.safeParse(json.response);
      if (!parsed.success) {
        return {
          ok: false,
          error: { kind: "unknown", message: `unexpected payload: ${parsed.error.message.slice(0, 200)}` },
        };
      }
      return { ok: true, value: parsed.data };
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: isTimeout(e) ? { kind: "timeout" } : { kind: "unknown", message } };
  }
}

async function getJson<T>(
  url: string,
  accessToken: string,
  schema: z.ZodType<T>,
  timeoutMs = 35_000,
): Promise<Result<T>> {
  return requestJson(url, accessToken, schema, { timeoutMs });
}

export class OwnerApi {
  constructor(private apiHost: string) {}

  /** Vehicle discovery. Filters out Powerwalls/solar (entries without vehicle_id). */
  async listVehicles(accessToken: string): Promise<Result<ProductVehicle[]>> {
    const result = await getJson(`${this.apiHost}/api/1/products`, accessToken, z.array(z.unknown()));
    if (!result.ok) return result;
    const vehicles: ProductVehicle[] = [];
    for (const entry of result.value) {
      if (typeof entry === "object" && entry !== null && "vehicle_id" in entry) {
        const parsed = ProductVehicle.safeParse(entry);
        if (parsed.success) vehicles.push(parsed.data);
      }
    }
    return { ok: true, value: vehicles };
  }

  /** Cheap state probe (`online`/`asleep`/`offline`). Never wakes the car. */
  async probeState(accessToken: string, eid: number): Promise<Result<VehicleProbe>> {
    return getJson(`${this.apiHost}/api/1/vehicles/${eid}`, accessToken, VehicleProbe, PROBE_TIMEOUT_MS);
  }

  /** Full telemetry payload. WAKES the car — only call per the FSM fetch policy. */
  async getVehicleData(accessToken: string, eid: number): Promise<Result<unknown>> {
    return getJson(
      `${this.apiHost}/api/1/vehicles/${eid}/vehicle_data?endpoints=${encodeURIComponent(VEHICLE_DATA_ENDPOINTS)}`,
      accessToken,
      z.unknown(),
    );
  }

  /**
   * Ask Tesla to wake the car. One of the two commands the Owner API still
   * accepts unsigned on cars that otherwise require the signed command
   * protocol. Returns the vehicle summary; `state` is usually still "asleep"
   * or "waking" — the poller observes the actual wake.
   */
  async wakeUp(accessToken: string, eid: number): Promise<Result<VehicleProbe>> {
    return requestJson(`${this.apiHost}/api/1/vehicles/${eid}/wake_up`, accessToken, VehicleProbe, {
      method: "POST",
    });
  }

  /**
   * Share a destination to the car's navigation — the other unsigned command.
   * The body mirrors the mobile app's Android share intent; that shape is what
   * TeslaPy and teslajsonpy send, but it has never been verified against this
   * codebase's real car, so callers must surface `reason` on a false result.
   */
  async navigationRequest(
    accessToken: string,
    eid: number,
    text: string,
    locale = "en-US",
  ): Promise<Result<CommandResponse>> {
    return requestJson(
      `${this.apiHost}/api/1/vehicles/${eid}/command/navigation_request`,
      accessToken,
      CommandResponse,
      {
        method: "POST",
        body: {
          type: "share_ext_content_raw",
          locale,
          timestamp_ms: Date.now(),
          value: { "android.intent.extra.TEXT": text },
        },
      },
    );
  }
}

/** Exchange a refresh token for a fresh token pair at the account's issuer. */
export async function refreshTokens(issuer: string, refreshToken: string): Promise<Result<TokenResponse>> {
  try {
    return await withDeadline(60_000, async (signal): Promise<Result<TokenResponse>> => {
      const res = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "EVBook" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          scope: "openid email offline_access",
          client_id: "ownerapi",
          refresh_token: refreshToken,
        }),
        signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) return { ok: false, error: { kind: "unauthorized" } };
        return { ok: false, error: await mapError(res) };
      }
      const parsed = TokenResponse.safeParse(await res.json());
      if (!parsed.success) return { ok: false, error: { kind: "unknown", message: "unexpected token response" } };
      return { ok: true, value: parsed.data };
    });
  } catch (e) {
    return { ok: false, error: { kind: "unknown", message: e instanceof Error ? e.message : String(e) } };
  }
}
