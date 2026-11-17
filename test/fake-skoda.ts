/**
 * A fake MySkoda Public API behind one `fetch`. Specs install it with
 * `spyOn(globalThis, "fetch")` and move the car by calling `set`.
 *
 * It holds EVBook to the contract the real service publishes
 * (https://public.api.connect.skoda-auto.cz/v3/api-docs): the key in
 * `X-API-Key`, one GET of `/api/v1/vehicles/{vin}` with a known `include`
 * list, 20 requests an hour per key with the RateLimit headers, the key's
 * expiry on every answer, problem+json errors, and every command path refused
 * (a spec that sees `commands` grow has found a bug). Shapes follow the
 * contract and the reported Elroq payload of 7 Nov 2026; the VIN is invented.
 */

export const FAKE_SKODA_HOST = "https://public.api.connect.skoda-auto.cz";
export const FAKE_SKODA_VIN = "TMBJC7NY0SF000001";
export const FAKE_SKODA_KEY = "skoda-test-key-ABCD";

export interface FakeSkodaCar {
  vin: string;
  name: string;
  soc: number | null;
  rangeKm: number;
  /** null leaves `state` out, as Škoda does for a combination it has no name for. */
  state: "CONNECT_CABLE" | "CHARGING" | "CONSERVING" | "READY_FOR_CHARGING" | "CHARGING_INTERRUPTED" | null;
  plug: "CONNECTED" | "DISCONNECTED";
  chargeType: "AC" | "DC" | "OFF";
  powerKw: number | null;
  targetSoc: number;
  minutesToFull: number | null;
  odometerKm: number;
  parking: "PARKED" | "IN_MOTION";
  lat: number;
  lon: number;
  at: number;
}

export function elroq(overrides: Partial<FakeSkodaCar> = {}): FakeSkodaCar {
  return {
    vin: FAKE_SKODA_VIN,
    name: "Elroq",
    soc: 52,
    rangeKm: 248,
    state: "CONNECT_CABLE",
    plug: "DISCONNECTED",
    chargeType: "OFF",
    powerKw: 0,
    targetSoc: 80,
    minutesToFull: null,
    odometerKm: 8_412,
    parking: "PARKED",
    lat: 50.0755,
    lon: 14.4378,
    at: Date.now(),
    ...overrides,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const ALLOWED_INCLUDES = new Set([
  "info",
  "status",
  "fuelStatus",
  "odometer",
  "parkingPosition",
  "airConditioning",
  "auxiliaryHeating",
  "activeVentilation",
  "charging",
  "chargingProfiles",
  "operations",
]);

export function vehicleResponse(car: FakeSkodaCar, include: Set<string>, sectionErrors: string[] = []): unknown {
  const vehicle: Record<string, unknown> = { vin: car.vin };
  if (include.has("info")) {
    vehicle.name = car.name;
    vehicle.renderUrl = "https://example.test/render.png";
  }
  if (include.has("charging") && !sectionErrors.some((e) => e.startsWith("CHARGING_"))) {
    vehicle.charging = {
      isVehicleInSavedLocation: false,
      carCapturedTimestamp: iso(car.at),
      status: {
        battery: {
          remainingCruisingRangeInMeters: car.rangeKm * 1000,
          ...(car.soc === null ? {} : { stateOfChargeInPercent: car.soc }),
        },
        ...(car.powerKw === null ? {} : { chargePowerInKw: car.powerKw }),
        ...(car.state === null ? {} : { state: car.state }),
        chargeType: car.chargeType,
        plugConnectionState: car.plug,
        plugLockState: car.plug === "CONNECTED" ? "LOCKED" : "UNLOCKED",
        ...(car.minutesToFull === null ? {} : { remainingTimeToFullyChargedInMinutes: car.minutesToFull }),
      },
      settings: { targetStateOfChargeInPercent: car.targetSoc, preferredChargeMode: "MANUAL" },
    };
  }
  if (include.has("odometer") && !sectionErrors.some((e) => e.startsWith("ODOMETER_"))) {
    vehicle.odometer = { mileageInKm: car.odometerKm, carCapturedTimestamp: iso(car.at) };
  }
  if (include.has("parkingPosition") && !sectionErrors.some((e) => e.startsWith("PARKING_POSITION_"))) {
    vehicle.parkingPosition =
      car.parking === "PARKED"
        ? { state: "PARKED", gpsCoordinates: { latitude: car.lat, longitude: car.lon }, formattedAddress: "Praha" }
        : { state: "IN_MOTION" };
  }
  if (include.has("status")) {
    vehicle.status = {
      carCapturedTimestamp: iso(car.at),
      overall: { doors: "CLOSED", doorsLocked: "YES", locked: "YES", windows: "CLOSED", lights: "OFF" },
      detail: { bonnet: "CLOSED", sunroof: "UNSUPPORTED", trunk: "CLOSED" },
    };
  }
  return { vehicle, errors: sectionErrors.map((type) => ({ type, description: "fake" })) };
}

function problem(status: number, type: string, title: string, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ type: `https://public.api.connect.skoda-auto.cz/problems/${type}`, title, status }),
    { status, headers: { "content-type": "application/problem+json", ...headers } },
  );
}

export class FakeSkoda {
  /** Keys the fake accepts, each for one VIN, with its expiry. */
  readonly keys = new Map<string, { vin: string; expiresAt: number }>();
  readonly cars = new Map<string, FakeSkodaCar>();
  /** Every request, in order. */
  readonly requests: { method: string; path: string; include: string[] }[] = [];
  /** Anything that was not the one allowed read. */
  readonly commands: string[] = [];
  /** Per-key send times inside the window. */
  private readonly sent = new Map<string, number[]>();
  /** The next answer, once, instead of the car's: a status and a problem type. */
  failNext: { status: number; type: string; retryAfter?: string } | null = null;
  /** Section errors to report, and the sections they hide. */
  sectionErrors: string[] = [];
  /** Answer for this VIN instead of the one asked for (a key bound to a different car). */
  answerAsVin: string | null = null;
  limit = 20;

  constructor(car: FakeSkodaCar = elroq(), key: string = FAKE_SKODA_KEY) {
    this.cars.set(car.vin, car);
    this.keys.set(key, { vin: car.vin, expiresAt: Date.now() + 80 * 24 * 60 * 60_000 });
  }

  set(vin: string, patch: Partial<FakeSkodaCar>): void {
    const car = this.cars.get(vin)!;
    this.cars.set(vin, { ...car, ...patch, at: Date.now() });
  }

  get reads(): number {
    return this.requests.filter((r) => r.method === "GET").length;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== FAKE_SKODA_HOST) throw new Error(`fake Škoda: unexpected host ${url.origin}`);
    const include = (url.searchParams.get("include") ?? "").split(",").filter(Boolean);
    this.requests.push({ method: request.method, path: url.pathname, include });

    const read = /^\/api\/v1\/vehicles\/([A-Z0-9]{17})$/.exec(url.pathname);
    if (request.method !== "GET" || !read) {
      this.commands.push(`${request.method} ${url.pathname}`);
      return problem(405, "about:blank", "Not allowed in this fake");
    }
    const key = request.headers.get("x-api-key") ?? "";
    const held = this.keys.get(key);
    if (!held) return problem(401, "api-key-expired", "API key expired");
    const headers = {
      "ratelimit-limit": String(this.limit),
      "x-api-key-expires-at": iso(held.expiresAt),
    };
    if (held.expiresAt <= Date.now()) return problem(401, "api-key-expired", "API key expired");
    if (held.vin !== read[1]) return problem(403, "api-key-not-authorized", "API key not authorized", headers);

    const now = Date.now();
    const window = (this.sent.get(key) ?? []).filter((t) => t > now - 3_600_000);
    if (window.length >= this.limit) {
      const reset = Math.ceil((window[0]! + 3_600_000 - now) / 1000);
      return problem(429, "rate-limit-exceeded", "Rate limit exceeded", {
        ...headers,
        "ratelimit-remaining": "0",
        "ratelimit-reset": String(reset),
        "retry-after": String(reset),
      });
    }
    window.push(now);
    this.sent.set(key, window);
    const quota = {
      ...headers,
      "ratelimit-remaining": String(this.limit - window.length),
      "ratelimit-reset": String(Math.ceil((window[0]! + 3_600_000 - now) / 1000)),
    };

    if (this.failNext) {
      const fail = this.failNext;
      this.failNext = null;
      return problem(fail.status, fail.type, "Failure", {
        ...quota,
        ...(fail.retryAfter ? { "retry-after": fail.retryAfter } : {}),
      });
    }
    if (include.some((i) => !ALLOWED_INCLUDES.has(i))) return problem(400, "about:blank", "Unknown include", quota);
    const car = this.cars.get(read[1]!);
    if (!car) return problem(404, "about:blank", "Vehicle not found", quota);
    const body = vehicleResponse(
      this.answerAsVin ? { ...car, vin: this.answerAsVin } : car,
      new Set(include.length ? include : ALLOWED_INCLUDES),
      this.sectionErrors,
    );
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...quota },
    });
  };
}
