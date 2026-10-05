import { describe, expect, it } from "vitest";
import { detectSources, getSource, listSources, registerSource } from "./registry";
import { memoryBundle } from "./bundle";
import "./index"; // registers the built-in adapters
import type { ImportSourceAdapter } from "./types";

/** A stand-in vendor, to prove the registry is the only thing adding one costs. */
const fake: ImportSourceAdapter = {
  id: "zz-fake",
  label: "Fake",
  describe: "a spec fixture",
  async detect(bundle) {
    const entries = await bundle.entries();
    const match = entries.some((entry) => entry.name === "fake.csv");
    return { confidence: match ? 0.6 : 0, vin: null, recognised: [], missing: [], notes: [] };
  },
  async *snapshots() {},
};

describe("source registry", () => {
  it("has the built-in adapters", () => {
    expect(listSources().map((source) => source.id)).toContain("tessie");
    expect(getSource("tessie")?.label).toBe("Tessie");
    expect(getSource("nope")).toBeNull();
  });

  it("takes a new adapter and offers it for detection", async () => {
    registerSource(fake);
    expect(getSource("zz-fake")).toBe(fake);

    const detected = await detectSources(memoryBundle("x.zip", { "fake.csv": "a\n" }));
    expect(detected.map((result) => result.source.id)).toEqual(["zz-fake"]);
  });

  it("ranks by confidence, best first", async () => {
    registerSource(fake);
    const tessieLike = {
      "driving_states.csv": "Timestamp (UTC),Latitude,Longitude,Shift State,Odometer (mi),Speed (mph)\n",
      "charging_states.csv": "Timestamp (UTC),Charging State,Usable Battery Level (%)\n",
      "fake.csv": "a\n",
    };
    const detected = await detectSources(memoryBundle("LRW3F7EB9MC123456.zip", tessieLike));
    expect(detected[0]!.source.id).toBe("tessie");
    expect(detected[0]!.detection.confidence).toBeGreaterThan(detected[1]!.detection.confidence);
  });

  it("keeps going when one adapter throws", async () => {
    registerSource({
      id: "zz-broken",
      label: "Broken",
      describe: "throws on sight",
      detect() {
        throw new Error("boom");
      },
      async *snapshots() {},
    });
    const detected = await detectSources(memoryBundle("x.zip", { "fake.csv": "a\n" }));
    const broken = detected.find((result) => result.source.id === "zz-broken");
    expect(broken!.detection.notes[0]).toMatch(/boom/);
    expect(detected.some((result) => result.source.id === "zz-fake")).toBe(true);
  });
});
