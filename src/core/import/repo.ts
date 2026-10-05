import { Repo } from "../../db/repo";
import { boundingBox, haversineMeters } from "../geo/geofence";
import type { SqlDatabase } from "../../platform/ports";

/**
 * The write layer used during an import: the live `Repo`, with reverse geocoding
 * made affordable.
 *
 * Nominatim asks for at most one request per second, and a two-year history has
 * thousands of drive endpoints — but they are mostly the same few dozen places. So
 * a point is only looked up if neither cache can answer it, within
 * `radiusMeters` (25 m by default):
 *
 * - **Where the car was.** Every point asked about, and what came back, including
 *   the failures. This is the effective one, and `known` carries it between the
 *   slices of a Worker import — a fresh repo per slice would otherwise look the
 *   same home address up once per slice.
 * - **Where OSM says the place is.** The `addresses` table, searched by
 *   coordinate. Weaker, because a street or a car park can be centred a long way
 *   from where you parked, but it survives restarts and is shared by a second
 *   import and by the cron repair pass.
 *
 * With geocoding off (the default) nothing is looked up at all and the cron
 * repair pass fills addresses in later, exactly as it does after a failed lookup.
 */

/** A point that has already been asked about, and what came back. */
export interface KnownPoint {
  latitude: number;
  longitude: number;
  addressId: number | null;
}

export interface GeocodeOptions {
  enabled: boolean;
  /**
   * Points asked about earlier in the same import. A Worker import runs in
   * slices, and this is what carries the answers — including the failures —
   * from one slice to the next.
   */
  known?: readonly KnownPoint[];
  /**
   * How close an existing address has to be to stand in for a new point. Tens of
   * metres is the right order: Nominatim is queried at building precision, and
   * parking twice outside the same house should not be two lookups.
   */
  radiusMeters?: number;
  /** Minimum spacing between lookups, per Nominatim's usage policy. */
  throttleMs?: number;
  /**
   * When the last lookup went out, carried between the slices of a Worker import.
   * Without it the clock restarts every slice and the first request of each one
   * ignores the spacing.
   */
  lastLookupAt?: number;
  /** Fixture geocoder for local runs; empty means the real Nominatim. */
  baseUrl?: string;
}

const DEFAULT_RADIUS_M = 25;

export class ImportRepo extends Repo {
  /** Points looked at so far, including the ones that failed. */
  private readonly seen: KnownPoint[];
  private readonly radiusMeters: number;
  private readonly throttleMs: number;
  private lastLookupAt: number;
  /** Lookups that actually went out over the network. */
  requests = 0;
  /** Of those, the ones that came back with an address. */
  resolved = 0;
  /** Answered by a point already asked about — the query-point cache. */
  cached = 0;
  /** Answered by an address the database already had nearby. */
  reused = 0;

  constructor(
    db: SqlDatabase,
    carId: number,
    private readonly geocode: GeocodeOptions,
  ) {
    super(db, carId, geocode.baseUrl);
    this.radiusMeters = geocode.radiusMeters ?? DEFAULT_RADIUS_M;
    this.throttleMs = geocode.throttleMs ?? 1_200;
    this.seen = [...(geocode.known ?? [])];
    this.lastLookupAt = geocode.lastLookupAt ?? 0;
  }

  /**
   * Everything asked about so far, to hand to the next slice of an import.
   *
   * This is keyed on where the car was, which is what makes it effective: the
   * address table can only be searched by where OSM says the *place* is, and for a
   * street or a car park that can be a long way from where you parked.
   */
  knownPoints(): readonly KnownPoint[] {
    return this.seen;
  }

  /** When the last request went out, to keep the next slice's spacing honest. */
  lastRequestAt(): number {
    return this.lastLookupAt;
  }

  /**
   * Imports do not enrich elevation. An upload is history, and one Tessie export
   * is tens of thousands of distinct coordinates — a bill and a wait nobody asked
   * for by uploading a file. Live drives get their profile as they close, and the
   * terrain cache they build means an imported road that is later driven again
   * costs nothing.
   */
  override async enrichElevations(): Promise<{ filled: number; requests: number; skipped: number }> {
    return { filled: 0, requests: 0, skipped: 0 };
  }

  /**
   * Nominatim's one-per-second, honoured for every request rather than every
   * point — resolving one spot can cost an address lookup and then a POI lookup,
   * and firing those back to back would be two requests in one second.
   *
   * Time spent on cache hits counts towards the spacing rather than adding to it,
   * which is why this waits here and not around the whole resolve.
   */
  protected override async beforeGeocodeRequest(): Promise<void> {
    const wait = this.throttleMs - (Date.now() - this.lastLookupAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastLookupAt = Date.now();
  }

  override async resolveAddress(latitude: number | null, longitude: number | null): Promise<number | null> {
    if (!this.geocode.enabled || latitude == null || longitude == null) return null;

    // Already asked about this spot in this run — including if the answer was
    // "no address", which must not be retried thousands of times.
    const recent = this.nearest(this.seen, latitude, longitude);
    if (recent !== undefined) {
      this.cached++;
      return recent.addressId;
    }

    const stored = await this.storedNearby(latitude, longitude);
    if (stored !== null) {
      this.seen.push({ latitude, longitude, addressId: stored });
      this.reused++;
      return stored;
    }

    // Counted per point, not per request: one point may cost an address lookup
    // and a POI lookup, and the spacing between those is `beforeGeocodeRequest`'s
    // job. A cache hit above has already returned and costs nothing.
    this.requests++;

    const addressId = await super.resolveAddress(latitude, longitude);
    this.seen.push({ latitude, longitude, addressId });
    if (addressId !== null) this.resolved++;
    return addressId;
  }

  /** An address already on record within the radius, bounding box first. */
  private async storedNearby(latitude: number, longitude: number): Promise<number | null> {
    const box = boundingBox(latitude, longitude, this.radiusMeters);
    const rows = await this.db
      .prepare(
        "SELECT id, latitude, longitude FROM addresses " +
          "WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?",
      )
      .bind(box.minLat, box.maxLat, box.minLon, box.maxLon)
      .all<{ id: number; latitude: number; longitude: number }>();

    const match = this.nearest(
      rows.results.map((row) => ({ latitude: row.latitude, longitude: row.longitude, addressId: row.id })),
      latitude,
      longitude,
    );
    return match?.addressId ?? null;
  }

  /** Closest of `points` within the radius, or undefined if none is. */
  private nearest(points: KnownPoint[], latitude: number, longitude: number): KnownPoint | undefined {
    let best: KnownPoint | undefined;
    let bestDistance = this.radiusMeters;
    for (const point of points) {
      const distance = haversineMeters(latitude, longitude, point.latitude, point.longitude);
      if (distance <= bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    return best;
  }
}
