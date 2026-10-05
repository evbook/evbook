import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ImportRepo } from "./repo";

/**
 * The import's write layer only differs from the live one in how it geocodes:
 * off by default, and otherwise skipping the lookup whenever the database already
 * holds an address close enough to stand in.
 */

const CAR_ID = 91;
const T0 = Date.UTC(2024, 4, 1);

/** Berlin, and points a known distance away from it. */
const HOME = { latitude: 52.52, longitude: 13.405 };

beforeEach(async () => {
  for (const table of ["positions", "drives", "addresses", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, 'IMPORTVIN2', ?, ?)")
    .bind(CAR_ID, T0, T0)
    .run();
  await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
});

/** An address on record, as a previous lookup would have left it. */
async function storeAddress(latitude: number, longitude: number, osmId: number): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO addresses (osm_id, osm_type, display_name, latitude, longitude, raw, inserted_at, updated_at) " +
      "VALUES (?, 'way', 'Somewhere', ?, ?, '{}', ?, ?) RETURNING id",
  )
    .bind(osmId, latitude, longitude, T0, T0)
    .first<{ id: number }>();
  return row!.id;
}

/**
 * The geocoder is deliberately unreachable, so a lookup that goes out fails
 * without leaving the runtime. Anything that returns an id therefore came from
 * the cache, which is exactly what these specs are about.
 */
function repo(options: { enabled?: boolean; radiusMeters?: number; throttleMs?: number; lastLookupAt?: number } = {}) {
  return new ImportRepo(env.DB, CAR_ID, {
    enabled: options.enabled ?? true,
    radiusMeters: options.radiusMeters,
    throttleMs: options.throttleMs ?? 0,
    lastLookupAt: options.lastLookupAt,
    baseUrl: "no-geocoder-here",
  });
}

describe("geocoding during an import", () => {
  it("resolves nothing when geocoding is off, and never calls out", async () => {
    const off = repo({ enabled: false });
    expect(await off.resolveAddress(HOME.latitude, HOME.longitude)).toBeNull();
    expect(off.requests).toBe(0);
  });

  it("reuses an address the database already has nearby", async () => {
    const addressId = await storeAddress(HOME.latitude, HOME.longitude, 1);
    const subject = repo();

    // 20 m north: the same place as far as an address label goes.
    expect(await subject.resolveAddress(HOME.latitude + 0.00018, HOME.longitude)).toBe(addressId);
    expect(subject.requests).toBe(0);
    expect(subject.reused).toBe(1);
  });

  it("does not reuse an address that is further than the radius", async () => {
    await storeAddress(HOME.latitude, HOME.longitude, 2);
    const subject = repo();

    // 200 m away — a different address, so it has to ask (and fail, here).
    expect(await subject.resolveAddress(HOME.latitude + 0.0018, HOME.longitude)).toBeNull();
    expect(subject.requests).toBe(1);
    expect(subject.reused).toBe(0);
  });

  it("honours a custom radius", async () => {
    await storeAddress(HOME.latitude, HOME.longitude, 3);
    // 60 m away: outside the default, inside a 100 m radius.
    const far = { latitude: HOME.latitude + 0.00054, longitude: HOME.longitude };

    const tight = repo();
    expect(await tight.resolveAddress(far.latitude, far.longitude)).toBeNull();
    expect(tight.requests).toBe(1);

    const loose = repo({ radiusMeters: 100 });
    expect(await loose.resolveAddress(far.latitude, far.longitude)).not.toBeNull();
    expect(loose.requests).toBe(0);
  });

  it("picks the closest of several nearby addresses", async () => {
    await storeAddress(HOME.latitude + 0.0002, HOME.longitude, 4); // ~22 m
    const closest = await storeAddress(HOME.latitude + 0.00005, HOME.longitude, 5); // ~6 m
    expect(await repo().resolveAddress(HOME.latitude, HOME.longitude)).toBe(closest);
  });

  it("asks once per place, however many times the car parks there", async () => {
    const subject = repo();
    expect(await subject.resolveAddress(HOME.latitude, HOME.longitude)).toBeNull();
    expect(await subject.resolveAddress(HOME.latitude, HOME.longitude)).toBeNull();
    expect(await subject.resolveAddress(HOME.latitude + 0.0001, HOME.longitude)).toBeNull();
    // A failure has to be cached too, or a two-year import retries thousands of
    // dead lookups.
    expect(subject.requests).toBe(1);
    expect(subject.cached).toBe(2);

    await subject.resolveAddress(48.137, 11.575); // Munich
    expect(subject.requests).toBe(2);
  });

  it("reuses a stored address in a fresh repo, so restarts keep the saving", async () => {
    const addressId = await storeAddress(HOME.latitude, HOME.longitude, 6);

    // A Worker import builds a fresh repo for every slice; the saving has to
    // survive that, or a fifty-slice import pays for the same place fifty times.
    for (let slice = 0; slice < 3; slice++) {
      const perSlice = repo();
      expect(await perSlice.resolveAddress(HOME.latitude, HOME.longitude)).toBe(addressId);
      expect(perSlice.requests).toBe(0);
    }
  });

  it("hands the points it asked about to the next slice", async () => {
    // Nothing stored, and the geocoder is unreachable: the first slice spends a
    // request and learns nothing but "no address here".
    const first = repo();
    await first.resolveAddress(HOME.latitude, HOME.longitude);
    expect(first.requests).toBe(1);
    expect(first.knownPoints()).toHaveLength(1);

    // The next slice must not spend that request again — a failure is an answer.
    const known = JSON.parse(JSON.stringify(first.knownPoints()));
    const second = new ImportRepo(env.DB, CAR_ID, {
      enabled: true,
      throttleMs: 0,
      baseUrl: "no-geocoder-here",
      known,
    });
    expect(await second.resolveAddress(HOME.latitude + 0.0001, HOME.longitude)).toBeNull();
    expect(second.requests).toBe(0);
  });

  it("only makes a cache miss wait for the throttle", async () => {
    const addressId = await storeAddress(HOME.latitude, HOME.longitude, 7);
    // A throttle long enough that paying it would be obvious.
    const subject = repo({ throttleMs: 2_000 });

    const started = Date.now();
    // Answered by the addresses table, and then by the in-run cache: neither
    // should sit out the delay, because neither is about to make a request.
    expect(await subject.resolveAddress(HOME.latitude, HOME.longitude)).toBe(addressId);
    expect(await subject.resolveAddress(HOME.latitude, HOME.longitude)).toBe(addressId);
    expect(Date.now() - started).toBeLessThan(500);
    expect(subject.requests).toBe(0);

    // A point nowhere near it has to ask, and that is what waits.
    await subject.resolveAddress(48.137, 11.575);
    expect(subject.requests).toBe(1);
    expect(subject.lastRequestAt()).toBeGreaterThan(0);
  });

  it("does not restart the throttle clock in the next slice", async () => {
    // A slice that just made a request hands the clock on; the next slice's first
    // lookup has to respect the spacing rather than fire immediately.
    const carried = repo({ throttleMs: 300, lastLookupAt: Date.now() });
    const started = Date.now();
    await carried.resolveAddress(48.137, 11.575);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("skips points with no coordinates", async () => {
    const subject = repo();
    expect(await subject.resolveAddress(null, null)).toBeNull();
    expect(await subject.resolveAddress(HOME.latitude, null)).toBeNull();
    expect(subject.requests).toBe(0);
  });

  it("still writes drives, just without an address", async () => {
    const subject = repo({ enabled: false });
    const driveId = await subject.openDrive(T0);
    await subject.insertPositions([
      { driveId, attrs: position(T0, 1000) },
      { driveId, attrs: position(T0 + 60_000, 1010) },
    ]);
    const closed = await subject.closeDrive(driveId);

    expect(closed.deleted).toBe(false);
    const drive = await env.DB.prepare("SELECT start_address_id, end_address_id, distance FROM drives WHERE id = ?")
      .bind(driveId)
      .first<{ start_address_id: number | null; end_address_id: number | null; distance: number }>();
    expect(drive).toMatchObject({ start_address_id: null, end_address_id: null, distance: 10 });
  });
});

/** Minimal position attrs — only what `closeDrive` aggregates. */
function position(at: number, odometer: number) {
  return {
    date_at: at,
    latitude: HOME.latitude,
    longitude: HOME.longitude,
    speed: 50,
    power: 10,
    odometer,
    elevation: null,
    ideal_battery_range_km: 300,
    rated_battery_range_km: 280,
    est_battery_range_km: null,
    battery_level: 70,
    usable_battery_level: 70,
    outside_temp: 15,
    inside_temp: 21,
    fan_status: null,
    driver_temp_setting: null,
    passenger_temp_setting: null,
    is_climate_on: null,
    is_rear_defroster_on: null,
    is_front_defroster_on: null,
    battery_heater: null,
    battery_heater_on: null,
    battery_heater_no_power: null,
    tpms_pressure_fl: null,
    tpms_pressure_fr: null,
    tpms_pressure_rl: null,
    tpms_pressure_rr: null,
  };
}
