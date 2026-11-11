import { describe, expect, it } from "bun:test";
import { FAKE_API_HOST, FAKE_CLIENT, FAKE_VIN, FakeVolvo } from "../../../test/fake-volvo";
import { VolvoClient, apiOf, pathOf } from "./api";

describe("paths and metering", () => {
  it("puts each endpoint on its API and path", () => {
    expect(pathOf("details", "A/B")).toBe("/connected-vehicle/v2/vehicles/A%2FB");
    expect(pathOf("odometer", "V")).toBe("/connected-vehicle/v2/vehicles/V/odometer");
    expect(pathOf("energy-state", "V")).toBe("/energy/v2/vehicles/V/state");
    expect(pathOf("location", "V")).toBe("/location/v1/vehicles/V/location");
    expect(apiOf("energy-state")).toBe("energy");
    expect(apiOf("location")).toBe("location");
    expect(apiOf("tyres")).toBe("connected-vehicle");
  });
});

describe("VolvoClient", () => {
  it("sends both credentials and reads the answer", async () => {
    const fake = new FakeVolvo();
    const client = new VolvoClient(FAKE_API_HOST, fake.fetch);
    const creds = { token: fake.mint(), apiKey: FAKE_CLIENT.apiKey };
    const vins = await client.listVins(creds);
    expect(vins.ok && vins.value).toEqual([FAKE_VIN]);
    const odo = await client.get("odometer", FAKE_VIN, creds);
    expect(odo.ok).toBe(true);
    expect(client.calls).toEqual({ "connected-vehicle": 2, energy: 0, location: 0 });
  });

  it("retries a refused key up to three times, counting every call", async () => {
    const fake = new FakeVolvo();
    const client = new VolvoClient(FAKE_API_HOST, fake.fetch);
    const creds = { token: fake.mint(), apiKey: FAKE_CLIENT.apiKey };
    const refused = '{"error":{"message":"Access denied due to invalid VCC-API-KEY."}}';
    fake.failures.push(
      { match: "/odometer", status: 401, body: refused },
      { match: "/odometer", status: 401, body: refused },
    );
    const flaky = await client.get("odometer", FAKE_VIN, creds);
    expect(flaky.ok).toBe(true);
    expect(client.calls["connected-vehicle"]).toBe(3);

    const wrongKey = await client.get("odometer", FAKE_VIN, { ...creds, apiKey: "nope" });
    expect(!wrongKey.ok && wrongKey.error.kind).toBe("key_refused");
    expect(client.calls["connected-vehicle"]).toBe(6);
  });

  it("classifies a spent quota on one API only", async () => {
    const fake = new FakeVolvo();
    fake.quota["connected-vehicle"] = 0;
    const client = new VolvoClient(FAKE_API_HOST, fake.fetch);
    const creds = { token: fake.mint(), apiKey: FAKE_CLIENT.apiKey };
    const cv = await client.get("odometer", FAKE_VIN, creds);
    expect(!cv.ok && cv.error.kind).toBe("quota");
    expect((await client.get("energy-state", FAKE_VIN, creds)).ok).toBe(true);
  });

  it("calls a non-JSON 200 and a dropped connection transient", async () => {
    const html = new VolvoClient(FAKE_API_HOST, async () => new Response("<html>", { status: 200 }));
    const r1 = await html.get("odometer", FAKE_VIN, { token: "t", apiKey: "k" });
    expect(!r1.ok && r1.error.kind).toBe("unavailable");
    const dead = new VolvoClient(FAKE_API_HOST, async () => {
      throw new TypeError("connection reset");
    });
    const r2 = await dead.get("odometer", FAKE_VIN, { token: "t", apiKey: "k" });
    expect(!r2.ok && r2.error).toEqual({ kind: "unavailable", status: 0, message: "connection reset" });
  });
});
