import { describe, expect, it } from "bun:test";
import { FAKE_SKODA_KEY, FAKE_SKODA_VIN, FakeSkoda } from "../../../test/fake-skoda";
import { INCLUDE, READ_PATH, SkodaClient, normalizeVin, rateOf } from "./api";

describe("SkodaClient", () => {
  it("reads with one GET, the key in X-API-Key and an explicit include list", async () => {
    const fake = new FakeSkoda();
    const client = new SkodaClient(undefined, fake.fetch);
    const result = await client.read(FAKE_SKODA_VIN, FAKE_SKODA_KEY);
    expect(result.ok).toBe(true);
    expect(client.calls).toBe(1);
    expect(fake.requests).toEqual([
      { method: "GET", path: `/api/v1/vehicles/${FAKE_SKODA_VIN}`, include: [...INCLUDE] },
    ]);
    expect(fake.commands).toEqual([]);
    if (result.ok) {
      expect(result.rate.limit).toBe(20);
      expect(result.rate.remaining).toBe(19);
      expect(result.rate.keyExpiresAt).toBeGreaterThan(Date.now());
    }
  });

  it("classifies a refused key and keeps the quota headers of a failure", async () => {
    const fake = new FakeSkoda();
    const client = new SkodaClient(undefined, fake.fetch);
    const wrong = await client.read(FAKE_SKODA_VIN, "not-the-key");
    expect(!wrong.ok && wrong.error.kind).toBe("key_expired");

    fake.failNext = { status: 429, type: "vehicle-not-accepting-requests", retryAfter: "300" };
    const refused = await client.read(FAKE_SKODA_VIN, FAKE_SKODA_KEY);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toMatchObject({ kind: "vehicle_refused", retryInMs: 300_000 });
      expect(refused.rate.remaining).toBe(19);
    }
  });

  it("never builds a request for anything but a VIN", async () => {
    const fake = new FakeSkoda();
    const client = new SkodaClient(undefined, fake.fetch);
    const result = await client.read("../charging/start", FAKE_SKODA_KEY);
    expect(!result.ok && result.error.kind).toBe("bad_request");
    expect(fake.requests).toEqual([]);
    expect(READ_PATH.test("/api/v1/vehicles/TMBJC7NY0SF000001/charging/start")).toBe(false);
  });

  it("calls a network failure unavailable instead of throwing", async () => {
    const client = new SkodaClient(undefined, async () => {
      throw new Error("connection reset");
    });
    const result = await client.read(FAKE_SKODA_VIN, FAKE_SKODA_KEY);
    expect(!result.ok && result.error).toMatchObject({ kind: "unavailable", status: 0 });
  });
});

describe("rateOf and normalizeVin", () => {
  it("reads RateLimit-Reset as seconds from now, not a timestamp", () => {
    const rate = rateOf(new Headers({ "ratelimit-limit": "20", "ratelimit-remaining": "0", "ratelimit-reset": "90" }));
    expect(rate).toEqual({ limit: 20, remaining: 0, resetInMs: 90_000, keyExpiresAt: null });
  });

  it("upper-cases a VIN and refuses anything that is not one", () => {
    expect(normalizeVin(" tmbjc7ny0sf000001 ")).toBe("TMBJC7NY0SF000001");
    expect(normalizeVin("TMBJC7NY0SF00000")).toBeNull();
    // I, O and Q never appear in a VIN.
    expect(normalizeVin("TMBJC7NY0SF00000O")).toBeNull();
  });
});
