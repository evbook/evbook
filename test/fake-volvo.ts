/**
 * A fake Volvo: the Volvo Cars API (Connected Vehicle v2, Energy v2, Location
 * v1) and Volvo ID's Keycloak token endpoint, behind one `fetch`. Specs install
 * it with `spyOn(globalThis, "fetch")` and move the car by editing `car`.
 *
 * It holds the real service to the contract EVBook relies on, so a spec that
 * passes here fails for the same reasons production would: both credentials on
 * every call, Basic client auth, PKCE S256 checked, codes single-use, refresh
 * tokens rotated with reuse detected, quota per API, command paths refused.
 * Response shapes follow the samples in the Volvo integration reference; the
 * VIN is invented.
 */

export const FAKE_VIN = "YV1XZK1V8RX000000";
export const FAKE_ISSUER = "https://volvo-id.test/realms/volvocars";
export const FAKE_API_HOST = "https://volvo-api.test";
export const FAKE_CLIENT = { clientId: "vid-dc-evbook-test", clientSecret: "test-secret", apiKey: "test-api-key-1234" };

export interface FakeCar {
  vin: string;
  soc: number | null;
  rangeKm: number;
  engine: "RUNNING" | "STOPPED" | "UNSPECIFIED";
  odometerKm: number;
  lat: number;
  lon: number;
  charging: "IDLE" | "CHARGING" | "DONE" | "SCHEDULED";
  cable: "CONNECTED" | "DISCONNECTED";
  chargeType: "AC" | "DC" | "NONE";
  powerKw: number | null;
  targetSoc: number;
  minutesToTarget: number;
  /** Updated whenever a spec moves the car; what every timestamp says. */
  at: number;
}

export function ex30(overrides: Partial<FakeCar> = {}): FakeCar {
  return {
    vin: FAKE_VIN,
    soc: 62,
    rangeKm: 260,
    engine: "STOPPED",
    odometerKm: 12_345.6,
    lat: 52.52,
    lon: 13.405,
    charging: "IDLE",
    cable: "DISCONNECTED",
    chargeType: "NONE",
    powerKw: 0,
    targetSoc: 90,
    minutesToTarget: 0,
    at: Date.now(),
    ...overrides,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

function ok(value: unknown, unit: string | undefined, at: number) {
  return { status: "OK", value, ...(unit ? { unit } : {}), updatedAt: iso(at) };
}

export function energyState(car: FakeCar): unknown {
  return {
    batteryChargeLevel:
      car.soc === null
        ? { status: "ERROR", code: "PROPERTY_NOT_SUPPORTED", message: "Not supported" }
        : ok(car.soc, "percentage", car.at),
    electricRange: ok(car.rangeKm, "km", car.at),
    chargingStatus: ok(car.charging, undefined, car.at),
    chargerConnectionStatus: ok(car.cable, undefined, car.at),
    chargingType: ok(car.chargeType, undefined, car.at),
    chargingPower:
      car.powerKw === null
        ? { status: "ERROR", code: "PROPERTY_NOT_SUPPORTED", message: "Not supported" }
        : ok(car.powerKw * 1000, "watts", car.at),
    targetBatteryChargeLevel: ok(car.targetSoc, "percentage", car.at),
    estimatedChargingTimeToTargetBatteryChargeLevel: ok(car.minutesToTarget, "minutes", car.at),
    chargingCurrentLimit: ok(16, "ampere", car.at),
  };
}

export function details(car: FakeCar): unknown {
  return {
    data: {
      vin: car.vin,
      modelYear: 2024,
      fuelType: "NONE",
      batteryCapacityKWH: 69,
      externalColour: "Cloud Blue",
      descriptions: { model: "EX30", steering: "LEFT" },
      images: { exteriorImageUrl: "https://cas.volvocars.com/image/test.png" },
    },
  };
}

function cv(key: string, value: unknown, at: number, unit?: string) {
  return { data: { [key]: { value, ...(unit ? { unit } : {}), timestamp: iso(at) } } };
}

export type Api = "connected-vehicle" | "energy" | "location";

export class FakeVolvo {
  car: FakeCar;
  /** Every request, as "METHOD path". */
  readonly calls: string[] = [];
  /** Calls left today per API; undefined = unlimited. */
  quota: Partial<Record<Api, number>> = {};
  /** Answer the next request to a path containing this with the given status and body. */
  readonly failures: { match: string; status: number; body: string; headers?: Record<string, string> }[] = [];
  /** Access token lifetime in seconds; Volvo has been seen at both 1799 and 299. */
  accessTtlS = 1799;
  refreshTtlS: number | null = 7 * 24 * 3600;

  private readonly codes = new Map<string, { challenge: string; redirectUri: string }>();
  private readonly refreshTokens = new Map<string, "live" | "used" | "revoked">();
  private readonly accessTokens = new Set<string>();
  private counter = 0;

  constructor(car: FakeCar = ex30()) {
    this.car = car;
  }

  /** Move the car, stamping its readings with a fresh time. */
  set(change: Partial<FakeCar>): void {
    this.car = { ...this.car, ...change, at: Date.now() };
  }

  /** What a browser consenting at Volvo ID would bring back: a code for this authorization URL. */
  consent(authorizeUrl: string): { code: string; state: string; redirectUri: string } {
    const url = new URL(authorizeUrl);
    if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE is required");
    if (url.searchParams.get("client_id") !== FAKE_CLIENT.clientId) throw new Error("unknown client");
    const code = `code-${++this.counter}`;
    this.codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
    });
    return {
      code,
      state: url.searchParams.get("state") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
    };
  }

  /** An access token the API accepts, for specs that skip the consent. */
  mint(): string {
    const access = `access-${++this.counter}`;
    this.accessTokens.add(access);
    return access;
  }

  /** Expire every refresh token, as Volvo ID would at the end of a grant. */
  revokeAll(): void {
    for (const token of this.refreshTokens.keys()) this.refreshTokens.set(token, "revoked");
    this.accessTokens.clear();
  }

  /** Invalidate access tokens only, so the next call is a 401 and a refresh fixes it. */
  expireAccess(): void {
    this.accessTokens.clear();
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.calls.push(`${request.method} ${url.pathname}`);
    const failure = this.failures.findIndex((f) => url.pathname.includes(f.match));
    if (failure !== -1) {
      const f = this.failures.splice(failure, 1)[0]!;
      return new Response(f.body, { status: f.status, headers: f.headers });
    }
    if (url.origin === new URL(FAKE_ISSUER).origin) return this.identity(request, url);
    if (url.origin === FAKE_API_HOST) return this.api(request, url);
    throw new Error(`fake Volvo: unexpected request to ${url.origin}`);
  };

  private issue(): Response {
    const access = `access-${++this.counter}`;
    const refresh = `refresh-${++this.counter}`;
    this.accessTokens.add(access);
    this.refreshTokens.set(refresh, "live");
    return Response.json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: this.accessTtlS,
      ...(this.refreshTtlS ? { refresh_expires_in: this.refreshTtlS } : {}),
      scope: "openid energy:state:read",
    });
  }

  private async identity(request: Request, url: URL): Promise<Response> {
    const grantError = (description: string) =>
      Response.json({ error: "invalid_grant", error_description: description }, { status: 400 });
    const expected = `Basic ${btoa(`${FAKE_CLIENT.clientId}:${FAKE_CLIENT.clientSecret}`)}`;
    if (request.headers.get("authorization") !== expected) {
      return Response.json(
        { error: "invalid_client", error_description: "Invalid client credentials" },
        { status: 401 },
      );
    }
    const form = new URLSearchParams(await request.text());
    if (url.pathname.endsWith("/protocol/openid-connect/revoke")) {
      const token = form.get("token") ?? "";
      if (this.refreshTokens.has(token)) this.refreshTokens.set(token, "revoked");
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.endsWith("/protocol/openid-connect/token")) return new Response("not found", { status: 404 });
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      if (!code) return grantError("Code not valid");
      if (code.redirectUri !== form.get("redirect_uri")) return grantError("Incorrect redirect_uri");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      if (challenge !== code.challenge) return grantError("PKCE verification failed");
      return this.issue();
    }
    if (form.get("grant_type") === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const state = this.refreshTokens.get(token);
      if (state === undefined) return grantError("unknown refresh token");
      if (state === "used") return grantError("refresh token already used");
      if (state === "revoked") return grantError("grant revoked");
      this.refreshTokens.set(token, "used");
      return this.issue();
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  private api(request: Request, url: URL): Response {
    const path = url.pathname;
    if (request.headers.get("vcc-api-key") !== FAKE_CLIENT.apiKey) {
      return Response.json(
        {
          error: {
            message:
              "Access denied due to invalid VCC-API-KEY. Make sure to provide a valid key for an active application.",
          },
        },
        { status: 401 },
      );
    }
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!this.accessTokens.has(bearer)) {
      return Response.json({ error: { message: "Invalid or expired token" } }, { status: 401 });
    }
    if (/\/commands?|command-accessibility/.test(path)) {
      return Response.json({ error: { message: "FORBIDDEN", description: "Access Denied" } }, { status: 403 });
    }
    if (path.startsWith("/energy/v1/")) {
      return Response.json({ error: { message: "GONE", description: "Version 1 is removed." } }, { status: 410 });
    }
    const api: Api = path.startsWith("/energy/")
      ? "energy"
      : path.startsWith("/location/")
        ? "location"
        : "connected-vehicle";
    const left = this.quota[api];
    if (left !== undefined) {
      if (left <= 0) {
        return Response.json(
          { statusCode: 403, message: "Out of call volume quota. Quota will be replenished in 18:00:00." },
          { status: 403 },
        );
      }
      this.quota[api] = left - 1;
    }

    const car = this.car;
    if (path === "/connected-vehicle/v2/vehicles") return Response.json({ data: [{ vin: car.vin }] });
    const vin = encodeURIComponent(car.vin);
    switch (path) {
      case `/connected-vehicle/v2/vehicles/${vin}`:
        return Response.json(details(car));
      case `/connected-vehicle/v2/vehicles/${vin}/engine-status`:
        return Response.json(cv("engineStatus", car.engine, car.at));
      case `/connected-vehicle/v2/vehicles/${vin}/odometer`:
        return Response.json(cv("odometer", car.odometerKm, car.at, "km"));
      case `/connected-vehicle/v2/vehicles/${vin}/statistics`:
        return Response.json({
          data: {
            tripMeterAutomatic: { value: 12.3, unit: "km", timestamp: iso(car.at) },
            averageEnergyConsumptionAutomatic: { value: 17.1, unit: "kWh/100km", timestamp: iso(car.at) },
          },
        });
      case `/connected-vehicle/v2/vehicles/${vin}/doors`:
        return Response.json({
          data: {
            frontLeftDoor: { value: "CLOSED", timestamp: iso(car.at) },
            frontRightDoor: { value: "CLOSED", timestamp: iso(car.at) },
            rearLeftDoor: { value: "CLOSED", timestamp: iso(car.at) },
            rearRightDoor: { value: "CLOSED", timestamp: iso(car.at) },
            hood: { value: "UNSPECIFIED", timestamp: iso(car.at) },
            tailgate: { value: "CLOSED", timestamp: iso(car.at) },
            centralLock: { value: "LOCKED", timestamp: iso(car.at) },
          },
        });
      case `/connected-vehicle/v2/vehicles/${vin}/windows`:
        return Response.json({
          data: {
            frontLeftWindow: { value: "CLOSED", timestamp: iso(car.at) },
            frontRightWindow: { value: "CLOSED", timestamp: iso(car.at) },
            rearLeftWindow: { value: "CLOSED", timestamp: iso(car.at) },
            rearRightWindow: { value: "CLOSED", timestamp: iso(car.at) },
            sunroof: { value: "UNSPECIFIED", timestamp: iso(car.at) },
          },
        });
      case `/connected-vehicle/v2/vehicles/${vin}/tyres`:
        return Response.json({
          data: {
            frontLeft: { value: "NO_WARNING", timestamp: iso(car.at) },
            frontRight: { value: "NO_WARNING", timestamp: iso(car.at) },
            rearLeft: { value: "LOW_PRESSURE", timestamp: iso(car.at) },
            rearRight: { value: "UNSPECIFIED", timestamp: iso(car.at) },
          },
        });
      case `/energy/v2/vehicles/${vin}/state`:
        return Response.json(energyState(car));
      case `/location/v1/vehicles/${vin}/location`:
        return Response.json({
          data: {
            type: "Feature",
            geometry: { type: "Point", coordinates: [car.lon, car.lat, 34.0] },
            properties: { timestamp: iso(car.at), heading: "90" },
          },
        });
      default:
        return Response.json({ statusCode: 404, message: "NOT_FOUND" }, { status: 404 });
    }
  }
}
