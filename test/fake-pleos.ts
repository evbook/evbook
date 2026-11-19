/**
 * A fake Pleos Vehicle Data API behind one `fetch`, for a personal key. Specs
 * install it with `spyOn(globalThis, "fetch")` (or pass `fake.fetch` to a
 * client) and move a car by calling `set`.
 *
 * It holds EVBook to the contract Pleos documents, and to what independent
 * clients observed on the live personal route where the documentation is
 * silent or wrong (tmp/ plan §8.1a, §8.6a, §8.7a):
 *
 * - `POST /v1/auth/personal-token` with `clientId` and `clientSecret` and a
 *   `Brand` header gives `data.accessToken` and nothing else: a JWT whose
 *   `exp` is an hour on. **A new token replaces the key's previous one**, which
 *   is then refused with HTTP 403 and a numeric `error.code` 403.
 * - A key covers the cars it was issued for, and only for its make.
 * - Four reads per car and the consent list, each `{data, meta}`, with the
 *   car's upload time in `data.timestamp`; `meta.success` a boolean.
 * - Errors as `{error: {code, message, requestId, details, timestamp}}`.
 * - Every other method or path is refused and recorded in `commands`: a spec
 *   that sees it grow has found a bug.
 *
 * The shapes follow Pleos's examples and the traces posted in public issues;
 * every value and VIN here is invented.
 */

export const FAKE_PLEOS_HOST = "https://api.pleos.ai";
export const FAKE_PLEOS_VIN = "KMHKM81CPNU000001";
export const FAKE_PLEOS_CLIENT_ID = "pleos-client-0001";
export const FAKE_PLEOS_SECRET = "pleos-secret-WXYZ";

export type Brand = "hyundai" | "kia" | "genesis";

export interface FakePleosCar {
  vin: string;
  type: "EV" | "PE" | "HV" | "GN" | "FV" | "UNKNOWN";
  name: string;
  sellname: string;
  nickname: string | null;
  soc: number | null;
  plugin: "connected" | "disconnected" | "invalid";
  status:
    | "notCharging"
    | "charging"
    | "fastCharging"
    | "reservedCharging"
    | "v2lOperating"
    | "v2lStop"
    | "v2xOperating"
    | "wirelessCharging";
  charging: boolean;
  targetStandard: number;
  targetQuick: number;
  remainTime: number;
  ignition: "on" | "off";
  ign3: "on" | "off";
  parked: boolean;
  odometerKm: number;
  lat: number;
  lon: number;
  heading: number;
  speedKph: number;
  /** A string, as Pleos sends it: "261", or "-" when the car has none. */
  rangeKm: string;
  /** When the car last uploaded: `data.timestamp` of every read. */
  sentAt: number;
}

export function ioniq5(overrides: Partial<FakePleosCar> = {}): FakePleosCar {
  return {
    vin: FAKE_PLEOS_VIN,
    type: "EV",
    name: "NE",
    sellname: "IONIQ 5",
    nickname: null,
    soc: 64,
    plugin: "disconnected",
    status: "notCharging",
    charging: false,
    targetStandard: 80,
    targetQuick: 90,
    remainTime: 0,
    ignition: "off",
    ign3: "off",
    parked: true,
    odometerKm: 23_418.6,
    lat: 52.3702,
    lon: 4.8952,
    heading: 90,
    speedKph: 0,
    rangeKm: "301",
    sentAt: Date.now(),
    ...overrides,
  };
}

/** UTC to the second, as Pleos writes `data.timestamp`. */
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A token shaped like Pleos's: a JWT, `exp` an hour after `iat`, `rev` the issue instant in ms. */
export function fakeJwt(issuedAt: number, lifetimeMs = 3_600_000): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor((issuedAt + lifetimeMs) / 1000),
      rev: issuedAt + Math.floor(Math.random() * 1000),
    }),
  );
  return `${header}.${claims}.fake-signature`;
}

let requestCounter = 0;

function meta(status = 200) {
  requestCounter += 1;
  return {
    code: status,
    message: "Success",
    success: true,
    timestamp: new Date().toISOString(),
    requestId: `req-${requestCounter}`,
  };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data, meta: meta() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function pleosError(
  status: number,
  code: string | number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  requestCounter += 1;
  return new Response(
    JSON.stringify({
      error: { code, message, requestId: `req-${requestCounter}`, details: [], timestamp: new Date().toISOString() },
    }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

export function readResponse(endpoint: string, car: FakePleosCar): unknown {
  const timestamp = iso(car.sentAt);
  switch (endpoint) {
    case "batteries":
      return {
        charge: {
          plugin: car.plugin,
          status: car.status,
          charging: car.charging,
          stateOfCharge: car.soc,
          batteryCapacity: 260_640,
          targetStateOfCharge: { standard: car.targetStandard, quick: car.targetQuick },
          remainTime: car.remainTime,
        },
        timestamp,
      };
    case "driving":
      return {
        ignition: {
          status: car.ignition,
          ignitionDetails: [
            { type: "ign1", status: car.ignition },
            { type: "ign3", status: car.ign3 },
            { type: "acc", status: "off" },
          ],
        },
        sleepMode: car.ignition === "on" ? "off" : "on",
        odometer: { value: car.odometerKm, unit: "km" },
        transmission: { parkingPosition: car.parked },
        timestamp,
      };
    case "locations":
      return {
        location: {
          latitude: car.lat,
          longitude: car.lon,
          altitude: 2,
          heading: car.heading,
          speed: { value: car.speedKph, unit: "kph" },
          type: 0,
        },
        timestamp,
      };
    case "powertrains":
      return {
        engine: { fuelLevel: null },
        batteries: [{ type: "main", remainRatio: car.soc }],
        distanceToEmpties: [{ type: "EV", value: car.rangeKm, unit: "km" }],
        timestamp,
      };
  }
  throw new Error(`fake Pleos: no read ${endpoint}`);
}

interface FakeKey {
  brand: Brand;
  secret: string;
  vins: string[];
  /** Revoked, reissued or expired: `personal-token` refuses it. */
  revoked: boolean;
  /** The one live token; minting another replaces it. */
  token: string | null;
}

export interface FakeRequest {
  method: string;
  path: string;
  brand: string | null;
}

export class FakePleos {
  readonly keys = new Map<string, FakeKey>();
  readonly cars = new Map<string, FakePleosCar>();
  /** Every request, in order. */
  readonly requests: FakeRequest[] = [];
  /** Anything that was not one of the allowed calls. */
  readonly commands: string[] = [];
  /** The next answer to a read of `endpoint` (any read when absent), once, instead of the car's. */
  failNext: { endpoint?: string; status: number; code: string | number; retryAfter?: string } | null = null;
  /** Reads that answer 404 / 4045 "no data" until cleared. */
  readonly noData = new Set<string>();
  /** Cars whose sharing was withdrawn: 400 / 5006. */
  readonly unshared = new Set<string>();

  constructor(car: FakePleosCar = ioniq5(), brand: Brand = "hyundai", clientId = FAKE_PLEOS_CLIENT_ID) {
    this.cars.set(car.vin, car);
    this.keys.set(clientId, { brand, secret: FAKE_PLEOS_SECRET, vins: [car.vin], revoked: false, token: null });
  }

  /** Another car on the same key. */
  addCar(car: FakePleosCar, clientId = FAKE_PLEOS_CLIENT_ID): void {
    this.cars.set(car.vin, car);
    this.keys.get(clientId)!.vins.push(car.vin);
  }

  /** The car uploads: `patch` applied, and `data.timestamp` moves to now (unless the patch sets it). */
  set(vin: string, patch: Partial<FakePleosCar>): void {
    const car = this.cars.get(vin)!;
    this.cars.set(vin, { ...car, sentAt: Date.now(), ...patch });
  }

  /** Another program mints a token for the same key: the token EVBook holds stops working. */
  evict(clientId = FAKE_PLEOS_CLIENT_ID): void {
    this.keys.get(clientId)!.token = fakeJwt(Date.now());
  }

  revoke(clientId = FAKE_PLEOS_CLIENT_ID): void {
    const key = this.keys.get(clientId)!;
    key.revoked = true;
    key.token = null;
  }

  count(predicate: (r: FakeRequest) => boolean): number {
    return this.requests.filter(predicate).length;
  }

  get tokensMinted(): number {
    return this.count((r) => r.path === "/v1/auth/personal-token");
  }

  get reads(): number {
    return this.count((r) => r.method === "GET" && r.path !== "/v1/vehicles/consent");
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== FAKE_PLEOS_HOST) throw new Error(`fake Pleos: unexpected host ${url.origin}`);
    const brand = request.headers.get("brand");
    this.requests.push({ method: request.method, path: url.pathname, brand });

    if (request.method === "POST" && url.pathname === "/v1/auth/personal-token") {
      return this.mint(brand, await request.text());
    }
    const read = /^\/v1\/vehicles\/([A-Z0-9]{17})\/(batteries|driving|locations|powertrains)$/.exec(url.pathname);
    const consent = url.pathname === "/v1/vehicles/consent";
    if (request.method !== "GET" || (!read && !consent) || url.search !== "") {
      this.commands.push(`${request.method} ${url.pathname}${url.search}`);
      return pleosError(400, "404", "Invalid endpoint");
    }

    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
    if (!bearer) return pleosError(400, "40002", "No auth header");
    const entry = [...this.keys.entries()].find(([, key]) => key.token === bearer);
    // An evicted, expired or unknown token: what the live API answers, not the documented 400 / 4011.
    if (!entry) return pleosError(403, 403, "Forbidden");
    const [, key] = entry;
    if (brand !== key.brand) return pleosError(400, "401", "Brand does not match the token");

    if (consent) {
      return ok({
        vehicles: key.vins.map((vin) => {
          const car = this.cars.get(vin)!;
          return {
            vin,
            name: car.name,
            type: car.type,
            sellname: car.sellname,
            ...(car.nickname ? { nickname: car.nickname } : {}),
          };
        }),
      });
    }

    const [, vin, endpoint] = read!;
    if (this.failNext && (!this.failNext.endpoint || this.failNext.endpoint === endpoint)) {
      const fail = this.failNext;
      this.failNext = null;
      return pleosError(fail.status, fail.code, "Failure", fail.retryAfter ? { "retry-after": fail.retryAfter } : {});
    }
    if (!key.vins.includes(vin!)) return pleosError(410, "4101", "Unregistered vehicle");
    if (this.unshared.has(vin!)) return pleosError(400, "5006", "No data sharing permission");
    if (this.noData.has(endpoint!)) return pleosError(404, "4045", "No data");
    return ok(readResponse(endpoint!, this.cars.get(vin!)!));
  };

  private mint(brand: string | null, body: string): Response {
    let input: { clientId?: unknown; clientSecret?: unknown } = {};
    try {
      input = JSON.parse(body) as typeof input;
    } catch {
      return pleosError(400, "40001", "Invalid parameters");
    }
    const key = typeof input.clientId === "string" ? this.keys.get(input.clientId) : undefined;
    if (!key || key.revoked || key.brand !== brand) return pleosError(404, "40404", "User or key not found");
    // A wrong secret: a 400 whose body is not documented.
    if (input.clientSecret !== key.secret) return pleosError(400, "40001", "Invalid parameters");
    key.token = fakeJwt(Date.now());
    return ok({ accessToken: key.token });
  }
}
