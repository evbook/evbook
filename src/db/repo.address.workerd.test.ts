import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "./repo";
import { repairMissingPois } from "./repair";
import { placeRegion, placeSpot } from "./queries/address";

/**
 * How a stop gets its name, against a real (local) SQLite database.
 *
 * The case this is all built around: a car parked on a petrol station forecourt
 * in Cyprus geocoded to the unnamed residential road running past it, so the page
 * showed a dash for a place whose town it knew perfectly well.
 */

const T0 = 1_700_000_000_000;
const CAR_ID = 1;
const HOST = "http://geocoder.test";

/** The forecourt, and the road Nominatim's address layer answers with. */
const ESSO = { lat: 34.704226, lon: 33.003258 };

async function reset() {
  // Not `settings`: it is a singleton row shared by every suite in the run, and
  // emptying it here is how this file breaks four specs in two other files.
  for (const table of ["positions", "drives", "charging_processes", "addresses", "car_settings", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, 10, 20, 'VIN1', 'Bro', ?, ?)",
  )
    .bind(CAR_ID, T0, T0)
    .run();
  await env.DB.prepare("INSERT INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
}

/** The nameless road the address layer returns for this coordinate. */
const ROAD = {
  osm_id: 900,
  osm_type: "way",
  lat: String(ESSO.lat),
  lon: String(ESSO.lon),
  name: "",
  display_name: "Pano Polemidia, Pano Polemidia Community, Cyprus",
  address: { city: "Pano Polemidia Community", country: "Cyprus" },
};

/** The station itself, as the POI layer returns it. */
const STATION = {
  osm_id: 901,
  osm_type: "node",
  lat: String(ESSO.lat),
  lon: String(ESSO.lon),
  name: "Esso",
  category: "amenity",
  type: "fuel",
  display_name: "Esso, Giannou Kranidioti, Pano Polemidia Community, Cyprus",
  address: { road: "Giannou Kranidioti", city: "Pano Polemidia Community", country: "Cyprus" },
};

/** Routes the two layers to two answers, and counts what was asked. */
function stubGeocoder(poi: unknown, address: unknown = ROAD) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(String(url));
    const wantsPoi = new URL(String(url)).searchParams.get("layer")?.includes("poi");
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(wantsPoi ? poi : address),
    } as Response);
  });
  return urls;
}

/** What the page would render for an address row. */
async function rendered(id: number): Promise<{ spot: string | null; region: string | null }> {
  const row = await env.DB.prepare(
    `SELECT ${placeSpot("a")} AS spot, ${placeRegion("a")} AS region FROM addresses a WHERE a.id = ?`,
  )
    .bind(id)
    .first<{ spot: string | null; region: string | null }>();
  return row!;
}

beforeEach(reset);
afterEach(() => vi.unstubAllGlobals());

describe("resolveAddress", () => {
  it("names the stop after the station, not the nameless road it opens onto", async () => {
    stubGeocoder(STATION);
    const id = await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);

    expect(await rendered(id!)).toEqual({ spot: "Esso", region: "Pano Polemidia Community" });
    const row = await env.DB.prepare("SELECT osm_id, poi_category FROM addresses WHERE id = ?")
      .bind(id)
      .first<{ osm_id: number; poi_category: string }>();
    // The POI's own OSM object, so it deduplicates on its own identity and
    // cannot put "Esso" on other stops that share the road.
    expect(row).toEqual({ osm_id: 901, poi_category: "amenity/fuel" });
  });

  it("keeps the town when there is no POI, instead of the dash it used to show", async () => {
    stubGeocoder({ error: { code: 404, message: "Unable to geocode" } });
    const id = await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);

    // The bug in one assertion: name arrived as "", COALESCE stopped at it, and
    // the spot came out empty even though the town was right there.
    expect(await rendered(id!)).toEqual({ spot: "Pano Polemidia Community", region: null });
    const row = await env.DB.prepare("SELECT name FROM addresses WHERE id = ?").bind(id).first<{ name: null }>();
    expect(row?.name).toBeNull();
  });

  it("marks the row checked either way, so the sweep never revisits it", async () => {
    stubGeocoder({ error: { code: 404 } });
    const id = await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);
    const row = await env.DB.prepare("SELECT poi_checked_at FROM addresses WHERE id = ?")
      .bind(id)
      .first<{ poi_checked_at: number | null }>();
    expect(row?.poi_checked_at).toBeGreaterThan(0);
  });

  it("does not ask the POI layer when the address layer already named the place", async () => {
    const named = { ...ROAD, name: "Strandbad Wannsee", address: { city: "Berlin" } };
    const urls = stubGeocoder(STATION, named);
    await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);
    // One request, not two: Nominatim already answered with the thing itself.
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain("layer=poi");
  });

  it("takes an address-layer answer that is itself a POI, in one request", async () => {
    // The Larnaca Airport case: parked inside the car park's footprint, so the
    // address layer answers with the car park itself — name, classification and
    // the road it opens onto, all at once. The poi layer must not be asked (its
    // nearest-centroid answer for something airport-sized fails any radius),
    // and the row must still count as a POI so its name beats the road.
    const parking = {
      osm_id: 902,
      osm_type: "way",
      lat: String(ESSO.lat),
      lon: String(ESSO.lon),
      name: "Larnaca Airport Short Parking P2",
      category: "amenity",
      type: "parking",
      display_name: "Larnaca Airport Short Parking P2, Arrival, Dromolaxia, Cyprus",
      address: { amenity: "Larnaca Airport Short Parking P2", road: "Arrival", city: "Dromolaxia" },
    };
    const urls = stubGeocoder({ error: { code: 404 } }, parking);

    const id = await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);

    expect(urls).toHaveLength(1);
    expect(await rendered(id!)).toEqual({ spot: "Larnaca Airport Short Parking P2", region: "Dromolaxia" });
    const row = await env.DB.prepare("SELECT road, poi_category, poi_checked_at FROM addresses WHERE id = ?")
      .bind(id)
      .first<{ road: string; poi_category: string; poi_checked_at: number }>();
    expect(row).toMatchObject({ road: "Arrival", poi_category: "amenity/parking" });
    // Answered, in the fullest sense — the sweep has nothing left to ask about.
    expect(row?.poi_checked_at).toBeGreaterThan(0);
  });

  it("teaches an existing unclassified row what it is on the next arrival", async () => {
    // The row as the old code stored it: named, roaded, never marked as a POI —
    // so the road won on screen. Arriving there again must heal it in place.
    const staleId = (await env.DB.prepare(
      "INSERT INTO addresses (osm_id, osm_type, name, road, city, latitude, longitude, inserted_at, updated_at) " +
        "VALUES (902, 'way', 'Larnaca Airport Short Parking P2', 'Arrival', 'Dromolaxia', ?, ?, ?, ?) RETURNING id",
    )
      .bind(ESSO.lat, ESSO.lon, T0, T0)
      .first<{ id: number }>())!.id;
    expect((await rendered(staleId)).spot).toBe("Arrival");

    stubGeocoder(
      { error: { code: 404 } },
      {
        ...ROAD,
        osm_id: 902,
        name: "Larnaca Airport Short Parking P2",
        category: "amenity",
        type: "parking",
        address: { road: "Arrival", city: "Dromolaxia" },
      },
    );
    const id = await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);

    // The same OSM object, so the same row — now knowing what it is.
    expect(id).toBe(staleId);
    expect((await rendered(staleId)).spot).toBe("Larnaca Airport Short Parking P2");
  });

  it("holds a POI to the tight radius when it would displace a real street address", async () => {
    // A café 30 m away must not rename a stop that has a proper address.
    const street = { ...ROAD, name: "", address: { road: "Torstraße", house_number: "1", city: "Berlin" } };
    const cafe = { ...STATION, name: "Café Nero", category: "amenity", type: "cafe", lat: "34.704496" };
    stubGeocoder(cafe, street);

    const id = await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);
    expect(await rendered(id!)).toEqual({ spot: "Torstraße 1", region: "Berlin" });
  });

  it("still takes a POI that is right on top of a street address", async () => {
    const street = { ...ROAD, name: "", address: { road: "Torstraße", house_number: "1", city: "Berlin" } };
    stubGeocoder({ ...STATION, name: "Café Nero", type: "cafe" }, street);

    const id = await new Repo(env.DB, CAR_ID, HOST).resolveAddress(ESSO.lat, ESSO.lon);
    expect((await rendered(id!)).spot).toBe("Café Nero");
  });
});

describe("repairMissingPois", () => {
  /** A drive that ends at the forecourt, already pinned to the nameless road. */
  async function driveEndingAtTheEsso(): Promise<{ driveId: number; roadId: number }> {
    const roadId = (await env.DB.prepare(
      "INSERT INTO addresses (osm_id, osm_type, name, city, latitude, longitude, inserted_at, updated_at) " +
        "VALUES (900, 'way', NULL, 'Pano Polemidia Community', ?, ?, ?, ?) RETURNING id",
    )
      .bind(ESSO.lat, ESSO.lon, T0, T0)
      .first<{ id: number }>())!.id;

    const posId = (await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, latitude, longitude) VALUES (?, ?, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, T0, ESSO.lat, ESSO.lon)
      .first<{ id: number }>())!.id;

    const driveId = (await env.DB.prepare(
      "INSERT INTO drives (car_id, start_date_at, end_date_at, end_position_id, end_address_id) " +
        "VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, T0, T0 + 60_000, posId, roadId)
      .first<{ id: number }>())!.id;

    return { driveId, roadId };
  }

  it("relinks an existing drive to the station it actually stopped at", async () => {
    const { driveId, roadId } = await driveEndingAtTheEsso();
    stubGeocoder(STATION);

    expect(await repairMissingPois(env.DB, HOST)).toEqual({ checked: 1, named: 1 });

    const drive = await env.DB.prepare("SELECT end_address_id FROM drives WHERE id = ?")
      .bind(driveId)
      .first<{ end_address_id: number }>();
    expect(drive?.end_address_id).not.toBe(roadId);
    expect(await rendered(drive!.end_address_id)).toEqual({ spot: "Esso", region: "Pano Polemidia Community" });
  });

  it("leaves the drive alone when there is no POI, and does not ask twice", async () => {
    const { driveId, roadId } = await driveEndingAtTheEsso();
    stubGeocoder({ error: { code: 404 } });

    expect(await repairMissingPois(env.DB, HOST)).toEqual({ checked: 1, named: 0 });
    const drive = await env.DB.prepare("SELECT end_address_id FROM drives WHERE id = ?")
      .bind(driveId)
      .first<{ end_address_id: number }>();
    expect(drive?.end_address_id).toBe(roadId);

    // The bookmark is the whole reason the sweep terminates.
    expect(await repairMissingPois(env.DB, HOST)).toEqual({ checked: 0, named: 0 });
  });

  it("leaves a rate-limited row for the next sweep instead of retiring it", async () => {
    const { roadId } = await driveEndingAtTheEsso();
    // Nominatim answering 429 to everything, as it does under load.
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response));

    expect(await repairMissingPois(env.DB, HOST)).toEqual({ checked: 0, named: 0 });
    const row = await env.DB.prepare("SELECT poi_checked_at FROM addresses WHERE id = ?")
      .bind(roadId)
      .first<{ poi_checked_at: number | null }>();
    expect(row?.poi_checked_at).toBeNull();

    // Service recovers; the row was still there to be found.
    stubGeocoder(STATION);
    expect(await repairMissingPois(env.DB, HOST)).toEqual({ checked: 1, named: 1 });
  });

  it("passes over a row that already names a street", async () => {
    await env.DB.prepare(
      "INSERT INTO addresses (osm_id, osm_type, road, city, inserted_at, updated_at) " +
        "VALUES (910, 'way', 'Torstraße', 'Berlin', ?, ?)",
    )
      .bind(T0, T0)
      .run();
    const urls = stubGeocoder(STATION);

    expect(await repairMissingPois(env.DB, HOST)).toEqual({ checked: 0, named: 0 });
    expect(urls).toHaveLength(0);
  });
});
