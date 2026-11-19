import { describe, expect, it } from "bun:test";
import {
  FAKE_PLEOS_CLIENT_ID,
  FAKE_PLEOS_SECRET,
  FAKE_PLEOS_VIN,
  FakePleos,
  fakeJwt,
  ioniq5,
} from "../../../test/fake-pleos";
import { PATHS, PleosClient, READS, consentVehicles, dataOf, isLoggable, tokenExpiry } from "./api";

function client(fake: FakePleos) {
  return new PleosClient(undefined, fake.fetch);
}

describe("PleosClient", () => {
  it("gets a token with the make in the Brand header, and reads its expiry from the JWT", async () => {
    const fake = new FakePleos();
    const result = await client(fake).token("hyundai", FAKE_PLEOS_CLIENT_ID, FAKE_PLEOS_SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expiresAt).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(result.value.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(fake.requests[0]).toEqual({ method: "POST", path: "/v1/auth/personal-token", brand: "hyundai" });
  });

  it("refuses a key for the wrong make, a wrong secret and a revoked key as the key's fault", async () => {
    const fake = new FakePleos();
    const kia = await client(fake).token("kia", FAKE_PLEOS_CLIENT_ID, FAKE_PLEOS_SECRET);
    expect(!kia.ok && kia.error.kind).toBe("key_refused");
    const wrong = await client(fake).token("hyundai", FAKE_PLEOS_CLIENT_ID, "nope");
    expect(!wrong.ok && wrong.error.kind).toBe("key_refused");
    fake.revoke();
    const revoked = await client(fake).token("hyundai", FAKE_PLEOS_CLIENT_ID, FAKE_PLEOS_SECRET);
    expect(!revoked.ok && revoked.error.kind).toBe("key_refused");
  });

  it("lists the key's cars, and reads each of the four endpoints", async () => {
    const fake = new FakePleos();
    const c = client(fake);
    const token = await c.token("hyundai", FAKE_PLEOS_CLIENT_ID, FAKE_PLEOS_SECRET);
    if (!token.ok) throw new Error("no token");
    const cars = await c.vehicles("hyundai", token.value.token);
    expect(cars.ok && cars.value).toEqual([
      { vin: FAKE_PLEOS_VIN, type: "EV", model: "NE", sellName: "IONIQ 5", nickname: null },
    ]);
    for (const endpoint of READS) {
      const read = await c.read("hyundai", token.value.token, FAKE_PLEOS_VIN, endpoint);
      expect(read.ok).toBe(true);
    }
    expect(fake.commands).toEqual([]);
  });

  it("is refused with a 403 once another program has minted a token for the same key", async () => {
    const fake = new FakePleos();
    const c = client(fake);
    const token = await c.token("hyundai", FAKE_PLEOS_CLIENT_ID, FAKE_PLEOS_SECRET);
    if (!token.ok) throw new Error("no token");
    fake.evict();
    const read = await c.read("hyundai", token.value.token, FAKE_PLEOS_VIN, "batteries");
    expect(!read.ok && read.error).toMatchObject({ kind: "token_refused", status: 403, code: "403" });
  });

  it("builds no path but the allowed ones, and puts nothing that is not a VIN into one", async () => {
    const fake = new FakePleos();
    const c = client(fake);
    const result = await c.read("hyundai", "t", "../../consent", "batteries");
    expect(!result.ok && result.error.kind).toBe("bad_request");
    expect(fake.requests).toEqual([]);
    expect(PATHS.read.test(`/v1/vehicles/${FAKE_PLEOS_VIN}/status`)).toBe(false);
    expect(PATHS.read.test(`/v1/vehicles/${FAKE_PLEOS_VIN}/batteries`)).toBe(true);
  });

  it("takes a timeout or a body that is not the envelope as unavailable", async () => {
    const c = new PleosClient(undefined, async () => new Response("<html>", { status: 200 }));
    const result = await c.read("kia", "t", FAKE_PLEOS_VIN, "driving");
    expect(!result.ok && result.error.kind).toBe("unavailable");
    const failing = new PleosClient(undefined, async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    const timedOut = await failing.read("kia", "t", FAKE_PLEOS_VIN, "driving");
    expect(!timedOut.ok && timedOut.error).toMatchObject({ kind: "unavailable", message: "timed out" });
  });
});

describe("helpers", () => {
  it("reads a JWT's exp, and nothing from a token that is not one", () => {
    const at = 1_800_000_000_000;
    expect(tokenExpiry(fakeJwt(at))).toBe(Math.floor((at + 3_600_000) / 1000) * 1000);
    expect(tokenExpiry("opaque")).toBeNull();
    expect(tokenExpiry("a.b.c")).toBeNull();
  });

  it("takes meta.success as a boolean or the documented string, and refuses an error envelope", () => {
    expect(dataOf({ data: { a: 1 }, meta: { success: "true" } })).toEqual({ a: 1 });
    expect(dataOf({ data: { a: 1 }, meta: { success: true } })).toEqual({ a: 1 });
    expect(dataOf({ data: { a: 1 }, meta: { success: false } })).toBeNull();
    expect(dataOf({ error: { code: 4045 } })).toBeNull();
  });

  it("keeps cars with a VIN, and logs the electric and plug-in ones", () => {
    const cars = consentVehicles({
      vehicles: [
        { vin: "kmhkm81cpnu000001", name: "NE", type: "EV", sellname: "IONIQ 5", nickname: "Blue" },
        { vin: "not a vin", type: "EV" },
        { vin: "KNAB2512345678901", type: "GN", sellname: "Picanto" },
        { vin: "KNAB2512345678902", type: "PE" },
        { vin: "KNAB2512345678903" },
      ],
    });
    expect(cars.map((c) => [c.vin, c.type, isLoggable(c)])).toEqual([
      ["KMHKM81CPNU000001", "EV", true],
      ["KNAB2512345678901", "GN", false],
      ["KNAB2512345678902", "PE", true],
      ["KNAB2512345678903", "UNKNOWN", false],
    ]);
    expect(cars[0]!.nickname).toBe("Blue");
    expect(ioniq5().vin).toBe(FAKE_PLEOS_VIN);
  });
});
