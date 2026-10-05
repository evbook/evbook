import { z } from "zod";
import { APP_VERSION } from "@shared/version";
import { withDeadline } from "../deadline";
import { haversineMeters } from "./geofence";

/**
 * Reverse geocoding via OSM Nominatim — the same provider TeslaMate uses.
 * Addresses are deduplicated on (osm_id, osm_type), so repeat visits to a
 * place reuse one row.
 */

const DEFAULT_BASE_URL = "https://nominatim.openstreetmap.org";
const USER_AGENT = `EVBook/${APP_VERSION} (self-hosted EV logbook; https://evbook.app)`;

const AddressDetails = z.record(z.string(), z.string()).default({});

const ReverseResponse = z.object({
  osm_id: z.number().nullish(),
  osm_type: z.string().nullish(),
  lat: z.union([z.string(), z.number()]).nullish(),
  lon: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
  display_name: z.string().nullish(),
  address: AddressDetails.nullish(),
  /** OSM's classification, present on a POI-layer answer: `amenity`, `shop`, … */
  category: z.string().nullish(),
  type: z.string().nullish(),
});

export interface AddressAttrs {
  osm_id: number | null;
  osm_type: string | null;
  display_name: string | null;
  name: string | null;
  house_number: string | null;
  road: string | null;
  neighbourhood: string | null;
  city: string | null;
  county: string | null;
  postcode: string | null;
  state: string | null;
  state_district: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  raw: string;
}

/** OSM uses many keys for the same concept; take the first that is present. */
function pick(address: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = address[key];
    if (value) return value;
  }
  return null;
}

const ROAD_KEYS = ["road", "street", "pedestrian", "footway", "path", "cycleway", "highway", "residential"];
const NEIGHBOURHOOD_KEYS = ["neighbourhood", "suburb", "city_district", "district", "quarter", "borough"];
const CITY_KEYS = ["city", "town", "village", "municipality", "hamlet", "locality"];

function toNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Absent, as one value. Nominatim sends `""` for a place it has no name for, and
 * `?? null` lets that through — which then defeats every `COALESCE` downstream,
 * because an empty string is not NULL. "No name" has one representation here.
 */
function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Reverse-geocode a coordinate. Returns null on any failure — never throws.
 * `baseUrl` exists so local runs can point at a fixture geocoder; empty means
 * the real Nominatim.
 */
export async function reverseLookup(
  latitude: number,
  longitude: number,
  language = "en",
  baseUrl?: string,
  timeoutMs = 8_000,
): Promise<AddressAttrs | null> {
  const url =
    `${baseUrl || DEFAULT_BASE_URL}/reverse?format=jsonv2&addressdetails=1&extratags=1&namedetails=1&zoom=19` +
    `&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`;

  try {
    const json = await fetchJson(url, language, timeoutMs);
    if (json === null) return null;
    return toAddress(json, latitude, longitude);
  } catch {
    return null;
  }
}

/** One Nominatim request, body included, under the deadline; null for any non-2xx. */
async function fetchJson(url: string, language: string, timeoutMs: number): Promise<unknown> {
  return withDeadline(timeoutMs, async (signal) => {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, "accept-language": language, accept: "application/json" },
      signal,
    });
    return res.ok ? ((await res.json()) as unknown) : null;
  });
}

/**
 * One Nominatim answer as an address row. Shared by both lookups: a POI is the
 * same shape of object, and parsing it twice in two places is how the two drift.
 */
function toAddress(json: unknown, latitude: number, longitude: number): AddressAttrs | null {
  const parsed = ReverseResponse.safeParse(json);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.osm_id == null || !data.osm_type) return null;

  const address = data.address ?? {};
  return {
    osm_id: data.osm_id,
    osm_type: data.osm_type,
    display_name: blank(data.display_name),
    name: blank(data.name),
    house_number: blank(pick(address, ["house_number"])),
    road: blank(pick(address, ROAD_KEYS)),
    neighbourhood: blank(pick(address, NEIGHBOURHOOD_KEYS)),
    city: blank(pick(address, CITY_KEYS)),
    county: blank(pick(address, ["county"])),
    postcode: blank(pick(address, ["postcode"])),
    state: blank(pick(address, ["state", "province"])),
    state_district: blank(pick(address, ["state_district"])),
    country: blank(pick(address, ["country"])),
    latitude: toNumber(data.lat) ?? latitude,
    longitude: toNumber(data.lon) ?? longitude,
    raw: JSON.stringify(json),
  };
}

/**
 * OSM classifications the address layer may answer with that describe a thing
 * standing at the coordinate rather than the address fabric around it. The
 * fabric — `highway`, `place`, `boundary`, `landuse` — also arrives named
 * ("Torstraße", "Mitte"), and a road must never be classified as a POI: that is
 * exactly the promotion `placeSpot` uses `poi_category` to decide.
 *
 * An allowlist, not a blocklist, because the failure modes differ: a category
 * wrongly refused just keeps today's behaviour, a category wrongly admitted
 * renames stops after railway lines and administrative areas.
 */
const OWN_POI_CATEGORIES = new Set([
  "amenity",
  "shop",
  "leisure",
  "tourism",
  "office",
  "craft",
  "historic",
  "healthcare",
  "emergency",
  "club",
  "aeroway",
]);

/**
 * The address-layer answer's own classification, when the thing it answered
 * with IS a POI.
 *
 * Nominatim answers with a POI directly whenever the coordinate falls inside
 * its footprint — an airport car park comes back as `amenity/parking` with its
 * name and the road it opens onto, all in one response. That answer already is
 * what `poiLookup` would go looking for, so reading it saves the second request
 * — and succeeds where the second request cannot: the POI layer answers with
 * the *nearest* POI centroid, and on something the size of an airport that can
 * be beyond any sane radius even while the car is parked inside it.
 *
 * Null when the answer is unnamed (a name is what the classification exists to
 * promote), unclassified, or classified as fabric. Reads `raw` because that is
 * where the classification survives parsing — `toAddress` keeps no column for
 * it, deliberately: `poi_category` is a decision, not a transcription.
 */
export function ownPoiCategory(address: AddressAttrs): string | null {
  if (!address.name) return null;
  let json: unknown;
  try {
    json = JSON.parse(address.raw);
  } catch {
    return null;
  }
  const parsed = ReverseResponse.safeParse(json);
  if (!parsed.success) return null;
  const category = blank(parsed.data.category);
  const type = blank(parsed.data.type);
  if (!category || !type || !OWN_POI_CATEGORIES.has(category)) return null;
  return `${category}/${type}`;
}

/**
 * How close a named POI has to be before it is taken as the name of a spot.
 *
 * `layer=poi` returns the nearest one at any distance — probing outward from a
 * petrol station gave the station at 14 m, then an unnamed car park at 81 m, then
 * a school at 474 m. Unbounded, that labels a layby with whatever happens to be
 * down the road.
 *
 * Two radii, because what is being displaced differs. With no street and no name
 * the row currently says nothing finer than the town, so a POI within `LOOSE` is
 * strictly better than what is there. When a street *is* known, the POI has to
 * overrule a real address, and only being all but on top of it justifies that.
 */
export const POI_RADIUS_M = { loose: 50, tight: 25 } as const;

/**
 * A POI, shaped as an address row because that is what it becomes. It is a full
 * OSM object with its own id, so it deduplicates and is linked to exactly like
 * any other address — which is what keeps one stop's petrol station off every
 * other stop that shares the road with it.
 */
interface PoiAttrs extends AddressAttrs {
  /** OSM's `category`/`type` pair, e.g. `amenity/fuel`. Never null here. */
  poi_category: string;
  /** How far the POI sits from the point that was asked about. */
  meters: number;
}

/**
 * Whether the question got through, kept apart from what the answer was.
 *
 * For display the two collapse — no POI and no answer both mean "call it by its
 * street". For the repair sweep they must not: it records that a row has been
 * asked about so it is never asked again, and a rate-limited request that
 * counted as "nothing here" would retire that row on the strength of a 429.
 */
export type PoiResult = { asked: true; poi: PoiAttrs | null } | { asked: false };

const UNREACHABLE: PoiResult = { asked: false };

/**
 * The named thing at a coordinate, asked for specifically.
 *
 * Nominatim's default reverse prefers the address layer, so a forecourt comes
 * back as the nameless road running past it. `layer=poi` asks the other question.
 * `{ asked: true, poi: null }` when there is genuinely nothing — no POI, or one
 * with no name, or one further off than `withinMeters`. Never throws.
 */
export async function poiLookup(
  latitude: number,
  longitude: number,
  withinMeters: number,
  language = "en",
  baseUrl?: string,
  timeoutMs = 8_000,
): Promise<PoiResult> {
  const url =
    `${baseUrl || DEFAULT_BASE_URL}/reverse?format=jsonv2&addressdetails=1&namedetails=1&zoom=19&layer=poi` +
    `&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`;

  try {
    const json = await fetchJson(url, language, timeoutMs);
    // 429 and 5xx are the service declining to answer, not an answer. Treating a
    // rate-limited request as "no POI here" is how the sweep would burn through
    // its backlog marking everything checked during one bad minute.
    if (json === null) return UNREACHABLE;
    const parsed = ReverseResponse.safeParse(json);
    if (!parsed.success) return UNREACHABLE;

    const category = blank(parsed.data.category);
    const type = blank(parsed.data.type);
    const poiCategory = category && type ? `${category}/${type}` : (category ?? type);

    const address = toAddress(json, latitude, longitude);
    // From here on the service did answer, and every rejection is a fact about
    // the place: no POI, or one not worth naming it after.
    //
    // An unnamed POI is not a name for anywhere, and one with no classification
    // is not identifiable as a POI at all — `poi_category` is what later tells
    // the display to prefer this row's name over the street it sits on.
    if (!address?.name || !poiCategory) return { asked: true, poi: null };

    // Read off the response rather than off `address`, whose coordinates fall
    // back to the ones asked about when Nominatim sends none. That fallback is
    // right for recording where a place is and fatal here: it would measure an
    // unlocated POI as nought metres away and wave it through.
    const lat = toNumber(parsed.data.lat);
    const lon = toNumber(parsed.data.lon);
    if (lat == null || lon == null) return { asked: true, poi: null };

    // `layer=poi` answers with the nearest one at any distance, and the whole
    // guard is that it must be near enough to be where the car actually was.
    const meters = haversineMeters(latitude, longitude, lat, lon);
    if (meters > withinMeters) return { asked: true, poi: null };

    return { asked: true, poi: { ...address, name: address.name, poi_category: poiCategory, meters } };
  } catch {
    return UNREACHABLE;
  }
}
