import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { MAX_BATCH, keyOf, keyToCoordinate, lookupElevations, terrainKey } from "./elevation";

/** One `fetch` that answers with the given body, and records what it was asked. */
function stubFetch(body: unknown, init: { ok?: boolean } = {}) {
  const calls: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(((url: string) => {
    calls.push(String(url));
    return Promise.resolve({
      ok: init.ok ?? true,
      json: () => Promise.resolve(body),
    } as Response);
  }) as unknown as typeof fetch);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("terrain keys", () => {
  it("rounds a coordinate to about 11 m", () => {
    expect(terrainKey(52.52341, 13.40567)).toEqual({ latE4: 525234, lonE4: 134057 });
  });

  it("gives two points on the same 11 m square one key", () => {
    expect(keyOf(terrainKey(52.523412, 13.405671))).toBe(keyOf(terrainKey(52.523389, 13.405674)));
  });

  it("keeps negative coordinates on the right side of zero", () => {
    const key = terrainKey(-33.8688, -151.2093);
    expect(key).toEqual({ latE4: -338688, lonE4: -1512093 });
    expect(keyToCoordinate(key)).toEqual({ latitude: -33.8688, longitude: -151.2093 });
  });

  it("round-trips a key back to the coordinate that gets asked about", () => {
    expect(keyToCoordinate(terrainKey(52.52341, 13.40567))).toEqual({ latitude: 52.5234, longitude: 13.4057 });
  });
});

describe("lookupElevations", () => {
  it("asks for every coordinate in one request and rounds the answers", async () => {
    const calls = stubFetch({ elevation: [38.4, 39.6, 41] });
    const heights = await lookupElevations([
      { latitude: 52.52, longitude: 13.4 },
      { latitude: 52.53, longitude: 13.41 },
      { latitude: 52.54, longitude: 13.42 },
    ]);
    expect(heights).toEqual([38, 40, 41]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("latitude=52.52,52.53,52.54");
    expect(calls[0]).toContain("longitude=13.4,13.41,13.42");
  });

  it("keeps an unanswerable coordinate as null rather than dropping it", async () => {
    stubFetch({ elevation: [38, null, 41] });
    expect(
      await lookupElevations([
        { latitude: 52.52, longitude: 13.4 },
        { latitude: 0, longitude: 0 },
        { latitude: 52.54, longitude: 13.42 },
      ]),
    ).toEqual([38, null, 41]);
  });

  it("fails the whole batch when the response does not line up with the request", async () => {
    // Two heights for three coordinates: matching them up by position would
    // credit one point with another's altitude.
    stubFetch({ elevation: [38, 39] });
    expect(
      await lookupElevations([
        { latitude: 52.52, longitude: 13.4 },
        { latitude: 52.53, longitude: 13.41 },
        { latitude: 52.54, longitude: 13.42 },
      ]),
    ).toBeNull();
  });

  it("returns null — not zeroes — when the service errors or is unreachable", async () => {
    stubFetch({ elevation: [38] }, { ok: false });
    expect(await lookupElevations([{ latitude: 52.52, longitude: 13.4 }])).toBeNull();

    spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch);
    expect(await lookupElevations([{ latitude: 52.52, longitude: 13.4 }])).toBeNull();
  });

  it("makes no request for an empty list", async () => {
    const calls = stubFetch({ elevation: [] });
    expect(await lookupElevations([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("refuses a batch bigger than the service accepts rather than truncating it", async () => {
    stubFetch({ elevation: [] });
    const tooMany = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ latitude: 52 + i / 1000, longitude: 13 }));
    await expect(lookupElevations(tooMany)).rejects.toThrow(/exceeds 100/);
  });

  it("honours a fixture host so local runs never reach the network", async () => {
    const calls = stubFetch({ elevation: [38] });
    await lookupElevations([{ latitude: 52.52, longitude: 13.4 }], "http://localhost:9099");
    expect(calls[0]?.startsWith("http://localhost:9099/v1/elevation")).toBe(true);
  });
});
