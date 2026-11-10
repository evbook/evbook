import type { PlaceCategory } from "@shared/api-types";

/**
 * Guessing what a place is from the reverse-geocode response already stored in
 * `addresses.raw`. Nominatim says what the OSM object *is* — `category` ("amenity",
 * "shop", "office") and `type` ("school", "supermarket") — so no second lookup is
 * needed; the guess is a read of data the geocoder has already been paid for.
 *
 * Only self-evident tags map: an OSM object typed `school` is a school, and that is
 * the whole test. Ambiguous ones — `parking`, `residential`, plain roads — map to
 * nothing, because a wrong "this is your gym" is worse than no suggestion at all.
 */

const BY_TYPE: Record<string, PlaceCategory> = {
  school: "school",
  university: "university",
  college: "university",
  kindergarten: "kindergarten",
  childcare: "kindergarten",
  fitness_centre: "gym",
  sports_centre: "gym",
  supermarket: "supermarket",
  mall: "shopping",
  department_store: "shopping",
  restaurant: "restaurant",
  fast_food: "restaurant",
  cafe: "cafe",
  hospital: "hospital",
  clinic: "hospital",
  charging_station: "charging",
  hotel: "hotel",
  guest_house: "hotel",
};

/**
 * The confident category for a stored raw geocoder response, or null. Accepts the
 * raw column as-is: imported rows may hold empty or foreign JSON, and that is a
 * null, not an error.
 */
export function guessCategory(raw: string | null): PlaceCategory | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  // jsonv2 calls it `category`; the older json format calls the same field `class`.
  const category =
    typeof record.category === "string" ? record.category : typeof record.class === "string" ? record.class : null;
  const type = typeof record.type === "string" ? record.type : null;

  // Any office is an office — OSM subtypes ("company", "it", "lawyer") add nothing.
  if (category === "office") return "office";
  return type !== null ? (BY_TYPE[type] ?? null) : null;
}
