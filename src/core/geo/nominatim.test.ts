import { afterEach, describe, expect, it, vi } from "vitest";
import { POI_RADIUS_M, ownPoiCategory, poiLookup, reverseLookup } from "./nominatim";

/**
 * The two questions asked of Nominatim, and the guards on the second one.
 *
 * The POI layer answers with the nearest point of interest at *any* distance, so
 * every check here is really about what must be refused: something unnamed,
 * something unclassified, something down the road.
 */

/** A reverse response, with the fields the parser actually reads. */
function answer(over: Record<string, unknown> = {}) {
  return {
    osm_id: 100,
    osm_type: "way",
    lat: "34.704226",
    lon: "33.003258",
    name: "",
    display_name: "Pano Polemidia, Cyprus",
    address: { city: "Pano Polemidia Community", country: "Cyprus" },
    ...over,
  };
}

function stub(body: unknown, init: { ok?: boolean } = {}) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(String(url));
    return Promise.resolve({ ok: init.ok ?? true, json: () => Promise.resolve(body) } as Response);
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("reverseLookup", () => {
  it("stores an absent name as null, not as the empty string Nominatim sends", async () => {
    // The whole bug: "" is not NULL, so COALESCE(street, name, region) stopped at
    // it and a place whose town was known rendered as a dash.
    stub(answer({ name: "" }));
    const address = await reverseLookup(34.704226, 33.003258);
    expect(address?.name).toBeNull();
    expect(address?.city).toBe("Pano Polemidia Community");
  });

  it("treats whitespace as absent too", async () => {
    stub(answer({ name: "   ", display_name: "  " }));
    const address = await reverseLookup(34.704226, 33.003258);
    expect(address?.name).toBeNull();
    expect(address?.display_name).toBeNull();
  });

  it("keeps a real name", async () => {
    stub(answer({ name: "Esso" }));
    expect((await reverseLookup(34.704226, 33.003258))?.name).toBe("Esso");
  });

  it("refuses an answer with no OSM identity, which cannot be deduplicated", async () => {
    stub({ error: { code: 404, message: "Unable to geocode" } });
    expect(await reverseLookup(34.704226, 33.003258)).toBeNull();
  });
});

describe("ownPoiCategory", () => {
  /** The classification the address-layer answer with these fields carries. */
  const from = async (over: Record<string, unknown>) => {
    stub(answer(over));
    return ownPoiCategory((await reverseLookup(34.704226, 33.003258))!);
  };

  it("classifies an answer that is itself a POI — the airport car park case", async () => {
    // The coordinate fell inside the footprint, so the address layer answered
    // with the thing itself. No second request needed, and no radius to fail.
    const category = await from({
      name: "Larnaca Airport Short Parking P2",
      category: "amenity",
      type: "parking",
      address: { amenity: "Larnaca Airport Short Parking P2", road: "Arrival", city: "Dromolaxia" },
    });
    expect(category).toBe("amenity/parking");
  });

  it("refuses the address fabric, which also arrives named", async () => {
    expect(await from({ name: "Torstraße", category: "highway", type: "residential" })).toBeNull();
    expect(await from({ name: "Mitte", category: "place", type: "suburb" })).toBeNull();
    expect(await from({ name: "Berlin", category: "boundary", type: "administrative" })).toBeNull();
  });

  it("refuses an unnamed POI — the classification exists to promote a name", async () => {
    expect(await from({ name: "", category: "amenity", type: "parking" })).toBeNull();
  });

  it("refuses an unclassified answer", async () => {
    expect(await from({ name: "Somewhere", category: null, type: null })).toBeNull();
    expect(await from({ name: "Somewhere", category: "amenity", type: "" })).toBeNull();
  });

  it("shrugs at a raw column that is not a geocoder response", async () => {
    stub(answer({ name: "Esso" }));
    const address = (await reverseLookup(34.704226, 33.003258))!;
    expect(ownPoiCategory({ ...address, raw: "not json" })).toBeNull();
  });
});

describe("poiLookup", () => {
  const look = (within: number = POI_RADIUS_M.loose) => poiLookup(34.704226, 33.003258, within);

  it("asks the POI layer, and returns it shaped as an address row", async () => {
    const urls = stub(answer({ name: "Esso", category: "amenity", type: "fuel" }));
    const result = await look();

    expect(urls[0]).toContain("layer=poi");
    expect(result).toMatchObject({
      asked: true,
      poi: {
        name: "Esso",
        poi_category: "amenity/fuel",
        // An OSM object of its own, so it deduplicates like any other address
        // rather than hanging off the road's row.
        osm_id: 100,
        osm_type: "way",
        city: "Pano Polemidia Community",
      },
    });
  });

  it("refuses a POI beyond the radius", async () => {
    // ~474 m north — the school that a probe at this coordinate really returns.
    stub(answer({ name: "Grammar School", category: "amenity", type: "school", lat: "34.708500" }));
    expect(await look()).toEqual({ asked: true, poi: null });
  });

  it("accepts one inside the radius", async () => {
    // ~30 m away: inside the loose radius, outside the tight one.
    stub(answer({ name: "Esso", category: "amenity", type: "fuel", lat: "34.704496" }));
    expect((await look(POI_RADIUS_M.loose)) as { poi: unknown }).toHaveProperty("poi.name", "Esso");
    expect(await look(POI_RADIUS_M.tight)).toEqual({ asked: true, poi: null });
  });

  it("refuses an unnamed POI — a car park with no name names nothing", async () => {
    stub(answer({ name: "", category: "amenity", type: "parking" }));
    expect(await look()).toEqual({ asked: true, poi: null });
  });

  it("refuses one with no classification, which could not be told from a street", async () => {
    stub(answer({ name: "Somewhere", category: null, type: null }));
    expect(await look()).toEqual({ asked: true, poi: null });
  });

  it("refuses one with no position, which cannot be held to the radius", async () => {
    stub(answer({ name: "Esso", category: "amenity", type: "fuel", lat: null, lon: null }));
    expect(await look()).toEqual({ asked: true, poi: null });
  });

  it("reports an empty layer as answered — there is genuinely nothing there", async () => {
    stub({ error: { code: 404, message: "Unable to geocode" } });
    expect(await look()).toEqual({ asked: true, poi: null });
  });

  it("reports a declining service as unasked, so the sweep comes back to it", async () => {
    // The distinction that matters: a 429 is not the same fact as "no POI here",
    // and recording it as one retires the row on the strength of a bad minute.
    stub(answer(), { ok: false });
    expect(await look()).toEqual({ asked: false });

    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    expect(await look()).toEqual({ asked: false });
  });

  it("keeps the tight radius meaningfully shorter than the loose one", () => {
    // The probes: station at 14 m, unnamed car park at 81 m. Tight must reject a
    // POI that is merely nearby when a real street address is being displaced.
    expect(POI_RADIUS_M.tight).toBeLessThan(POI_RADIUS_M.loose);
    expect(POI_RADIUS_M.loose).toBeLessThan(81);
  });
});
