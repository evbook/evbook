/**
 * How a geocoded address is named on screen, shared by every list that shows a
 * place: drives, charges, trips, the timeline and the statistics roll-ups.
 *
 * A place is two halves, kept as two columns rather than one string, because the
 * page sets them in different weights — the spot in the body colour, the region
 * dimmed after it, as the Places page has always shown a recent arrival. Joining
 * them in SQL and splitting them again in the browser would guess at a comma that
 * a street or a geofence name is free to contain.
 */

/**
 * A text column, with "absent" as one value.
 *
 * Every `COALESCE` here would otherwise stop at an empty string and return it, so
 * one row storing `''` where another stores NULL is the difference between a name
 * and a blank on screen. 0011 normalised the rows and the parser no longer writes
 * `''`, but this is what makes those two guarantees unnecessary to rely on.
 */
function text(column: string): string {
  return `NULLIF(TRIM(COALESCE(${column}, '')), '')`;
}

/** Street and number, as one value; empty when the row has neither. */
function street(alias: string): string {
  return `NULLIF(TRIM(COALESCE(${alias}.road,'') || ' ' || COALESCE(${alias}.house_number,'')), '')`;
}

/** The town, or what stands in for one. */
function region(alias: string): string {
  return `COALESCE(${text(`${alias}.city`)}, ${text(`${alias}.county`)}, ${text(`${alias}.state`)})`;
}

/**
 * The place itself: what OSM calls the thing that is there, else the street it is
 * on, else the row's own name, else — having nothing finer to say — the town.
 *
 * The POI comes first because it is the answer to the question actually being
 * asked. "Esso" is where you stopped; "Giannou Kranidioti" is merely the road it
 * opens onto, and an unnamed residential road is not even that. Only a POI that
 * survived the radius check in [`core/geo/nominatim`](../../core/geo/nominatim.ts)
 * is ever stored, so preferring it here cannot promote something down the street.
 *
 * A geofence still wins over all of it — see the callers — because a place the
 * owner named is a better answer than one OSM named.
 *
 * `alias` is the SQL alias the `addresses` table is joined under.
 */
export function placeSpot(alias: string): string {
  return `COALESCE(${poi(alias)}, ${street(alias)}, ${text(`${alias}.name`)}, ${region(alias)})`;
}

/**
 * The row's name, but only when the row *is* a POI — `poi_category` is what says
 * so. A POI carries the street it opens onto in `road` like any other row, and
 * without this test the street would win and "Esso" would render as the road.
 */
function poi(alias: string): string {
  return `CASE WHEN ${text(`${alias}.poi_category`)} IS NOT NULL THEN ${text(`${alias}.name`)} END`;
}

/**
 * The town the spot sits in: "Torstraße 1" alone only means something to someone
 * who already knows which town they are in, and half the streets in the country
 * are called Bahnhofstraße.
 *
 * Nominatim leaves `city` empty out in the countryside — see CITY_KEYS in
 * [`core/geo/nominatim`](../../core/geo/nominatim.ts), which already folds town,
 * village and hamlet into that column — so the county, then the state, stands in.
 *
 * NULL when there is no town, and equally when the town *is* the spot: a row
 * geocoded no finer than the town would otherwise read "Berlin, Berlin".
 */
export function placeRegion(alias: string): string {
  const spot = `COALESCE(${poi(alias)}, ${street(alias)}, ${text(`${alias}.name`)})`;
  return `CASE WHEN ${spot} IS NOT NULL AND ${region(alias)} <> ${spot} THEN ${region(alias)} END`;
}

/**
 * The two halves as one string, for the places that have no room to weight them
 * apart: a map popup, a diagnostics row. Either half may be missing.
 */
export function oneLine(spot: string, region: string): string {
  // Trimmed of the separator as well as of space: a region never arrives without a
  // spot in front of it, and a leading ", " is not the way to find out otherwise.
  return `NULLIF(TRIM(COALESCE(${spot}, '') || COALESCE(', ' || ${region}, ''), ', '), '')`;
}
