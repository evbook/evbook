import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { DriveDetailDto, DriveListDto, DrivesRouteDto } from "@shared/api-types";
import { authed, getJson, login } from "../../test/http";
import { resetLoggedCar, seedComparableCharge, seedComparableDrive, seedDrive, seedGeofence } from "../../test/seed";

/** HTTP tests for the drive list, detail, GPX export and the combined route. */

/** Rich position tracks at 0.15 kWh/km, for lists, detail and GPX. */
const DETAIL_CAR = 7;
/** Drives that differ on every sortable dimension, at 0.2 kWh/km. */
const SORT_CAR = 12;
const T0 = 1_760_000_000_000;
const TS = 1_770_000_000_000;
const DAY = 86_400_000;

const resetDetailCar = () => resetLoggedCar(DETAIL_CAR, { efficiency: 0.15, insertedAt: T0 });
const resetSortCar = () => resetLoggedCar(SORT_CAR, { efficiency: 0.2 });

/** Three drives that differ on every sortable dimension. */
async function seedSortableDrives() {
  await seedComparableDrive(SORT_CAR, { at: TS, distance: 10, durationMin: 20, speedMax: 60, rangeUsed: 5 });
  await seedComparableDrive(SORT_CAR, { at: TS + DAY, distance: 100, durationMin: 60, speedMax: 130, rangeUsed: 40 });
  await seedComparableDrive(SORT_CAR, { at: TS + 2 * DAY, distance: 50, durationMin: 10, speedMax: 90, rangeUsed: 30 });
}

describe("drives API", () => {
  beforeEach(resetDetailCar);

  it("lists completed drives with totals", async () => {
    const cookie = await login();
    await seedDrive(DETAIL_CAR, { startAt: T0 });
    const body = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(body.drives).toHaveLength(1);
    expect(body.totals.count).toBe(1);
    expect(body.totals.distanceKm).toBeCloseTo(20, 5);
    // 15 km of range used at 0.15 kWh/km.
    expect(body.totals.energyKwh).toBeCloseTo(2.25, 5);
    expect(body.drives[0]!.consumptionKwhPer100km).toBeCloseTo(11.25, 2);
  });

  it("excludes drives that are still open", async () => {
    const cookie = await login();
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?)").bind(DETAIL_CAR, T0).run();
    const body = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(body.drives).toHaveLength(0);
  });

  it("filters by date range and minimum distance", async () => {
    const cookie = await login();
    await seedDrive(DETAIL_CAR, { startAt: T0, distance: 20 });
    await seedDrive(DETAIL_CAR, { startAt: T0 + DAY, distance: 2 });

    const recent = (await (await authed(cookie, `/api/v1/drives?from=${T0 + 1000}`)).json()) as DriveListDto;
    expect(recent.drives).toHaveLength(1);

    const long = (await (await authed(cookie, "/api/v1/drives?minDistanceKm=10")).json()) as DriveListDto;
    expect(long.drives).toHaveLength(1);
    expect(long.drives[0]!.distanceKm).toBeCloseTo(20, 5);
  });

  it("paginates", async () => {
    const cookie = await login();
    await seedDrive(DETAIL_CAR, { startAt: T0 });
    await seedDrive(DETAIL_CAR, { startAt: T0 + 3_600_000 });
    const page = (await (await authed(cookie, "/api/v1/drives?limit=1&offset=1")).json()) as DriveListDto;
    expect(page.drives).toHaveLength(1);
    expect(page.totals.count).toBe(2);
  });

  it("returns detail with downsampled positions", async () => {
    const cookie = await login();
    const id = await seedDrive(DETAIL_CAR, { startAt: T0 });
    const body = (await (await authed(cookie, `/api/v1/drives/${id}`)).json()) as DriveDetailDto;
    expect(body.positionCount).toBe(4);
    expect(body.positions.length).toBeGreaterThan(0);
    expect(body.positions[0]!.at).toBeLessThanOrEqual(body.positions[body.positions.length - 1]!.at);
  });

  it("404s an unknown drive", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/drives/99999")).status).toBe(404);
  });

  it("exports GPX", async () => {
    const cookie = await login();
    const id = await seedDrive(DETAIL_CAR, { startAt: T0 });
    const res = await authed(cookie, `/api/v1/drives/${id}/gpx`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("gpx");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const gpx = await res.text();
    expect(gpx).toContain("<gpx");
    expect(gpx).toContain("<trkpt");
    expect((gpx.match(/<trkpt/g) ?? []).length).toBe(4);
  });

  it("honours the preferred range setting", async () => {
    const cookie = await login();
    await seedDrive(DETAIL_CAR, { startAt: T0 });
    await authed(cookie, "/api/v1/settings", { method: "PUT", body: JSON.stringify({ preferredRange: "ideal" }) });
    const body = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(body.drives[0]!.startRangeKm).toBe(320);
  });
});

describe("drive sorting", () => {
  beforeEach(resetSortCar);

  it("defaults to newest first", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives");
    expect(body.drives.map((d) => d.startAt)).toEqual([TS + 2 * DAY, TS + DAY, TS]);
  });

  it.each([
    ["distance", "asc", [10, 50, 100]],
    ["distance", "desc", [100, 50, 10]],
  ])("sorts by %s %s", async (sort, dir, expected) => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DriveListDto>(cookie, `/api/v1/drives?sort=${sort}&dir=${dir}`);
    expect(body.drives.map((d) => d.distanceKm)).toEqual(expected);
  });

  it("sorts by duration and by max speed", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const byDuration = await getJson<DriveListDto>(cookie, "/api/v1/drives?sort=duration&dir=asc");
    expect(byDuration.drives.map((d) => d.durationMin)).toEqual([10, 20, 60]);
    const bySpeed = await getJson<DriveListDto>(cookie, "/api/v1/drives?sort=speed&dir=desc");
    expect(bySpeed.drives.map((d) => d.speedMaxKmh)).toEqual([130, 90, 60]);
  });

  it("sorts by derived consumption", async () => {
    const cookie = await login();
    await seedSortableDrives();
    // 5 kWh over 10 km = 10 kWh/100; 8 over 100 = 8; 6 over 50 = 12.
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives?sort=consumption&dir=asc");
    const values = body.drives.map((d) => Math.round(d.consumptionKwhPer100km!));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values[0]).toBe(8);
  });

  it("withholds consumption on a drive too short to divide by", async () => {
    const cookie = await login();
    await seedSortableDrives();
    // 20 m, a minute, 0.1 km of range at 0.2 kWh/km — which would read 100 kWh/100 km.
    await seedComparableDrive(SORT_CAR, { at: TS + 3 * DAY, distance: 0.02, durationMin: 1, speedMax: 8, rangeUsed: 0.1 });
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives?sort=consumption&dir=desc");

    const shunt = body.drives.find((d) => d.distanceKm === 0.02);
    // The energy it really used is still reported; only the ratio is withheld.
    expect(shunt?.energyUsedKwh).toBeCloseTo(0.02, 5);
    expect(shunt?.consumptionKwhPer100km).toBeNull();
    // Nulls order last whichever way the column is sorted, so it cannot head the list.
    expect(body.drives.at(-1)!.distanceKm).toBe(0.02);
    // And the slider still spans the real drives, not 0 to 100.
    expect(body.bounds.consumption).toEqual({ min: 8, max: 12 });
  });

  it("rejects an unknown sort column", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/drives?sort=; DROP TABLE drives");
    expect(res.status).toBe(400);
    // The table must still be there.
    const check = await env.DB.prepare("SELECT COUNT(*) AS n FROM drives").first<{ n: number }>();
    expect(check?.n).toBe(0);
  });

  it("rejects an unknown direction", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/drives?dir=sideways")).status).toBe(400);
  });
});

describe("drive range filters", () => {
  beforeEach(resetSortCar);

  it("filters on a distance window", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives?minDistanceKm=20&maxDistanceKm=80");
    expect(body.drives.map((d) => d.distanceKm)).toEqual([50]);
    expect(body.totals.count).toBe(1);
  });

  it("filters on a duration window", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives?minDurationMin=15&maxDurationMin=30");
    expect(body.drives.map((d) => d.durationMin)).toEqual([20]);
  });

  it("filters on consumption", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives?maxConsumption=9");
    expect(body.drives).toHaveLength(1);
    expect(body.drives[0]!.distanceKm).toBe(100);
  });

  it("combines a range with a date window", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DriveListDto>(cookie, `/api/v1/drives?from=${TS + DAY}&minDistanceKm=40`);
    expect(body.totals.count).toBe(2);
  });

  it("reports bounds for the sliders", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives");
    expect(body.bounds.distanceKm).toEqual({ min: 10, max: 100 });
    expect(body.bounds.durationMin).toEqual({ min: 10, max: 60 });
  });

  it("keeps bounds independent of the active filter, so sliders do not collapse", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const filtered = await getJson<DriveListDto>(cookie, "/api/v1/drives?minDistanceKm=90");
    expect(filtered.drives).toHaveLength(1);
    expect(filtered.bounds.distanceKm).toEqual({ min: 10, max: 100 });
  });

  it("returns zeroed bounds when nothing is logged", async () => {
    const cookie = await login();
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives");
    expect(body.bounds.distanceKm).toEqual({ min: 0, max: 0 });
  });
});

/**
 * Each end of a drive filters on its own named place, which is what makes the
 * pair worth having: "from Home" is a different question from "to Home", and
 * asking both at once is the commute.
 */
describe("drive place filters", () => {
  beforeEach(resetDetailCar);

  it("filters on the place a drive started from and the one it ended at", async () => {
    const cookie = await login();
    const home = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4 });
    const work = await seedGeofence({ name: "Work", latitude: 52.6, longitude: 13.5 });
    await seedDrive(DETAIL_CAR, { startAt: T0, startGeofenceId: home, endGeofenceId: work });
    await seedDrive(DETAIL_CAR, { startAt: T0 + DAY, startGeofenceId: work, endGeofenceId: home });
    // Somewhere the owner never named, which neither place should ever claim.
    await seedDrive(DETAIL_CAR, { startAt: T0 + 2 * DAY });

    const out = await getJson<DriveListDto>(cookie, `/api/v1/drives?startGeofenceId=${home}`);
    expect(out.totals.count).toBe(1);
    expect(out.drives[0]!.endLabel).toBe("Work");

    const back = await getJson<DriveListDto>(cookie, `/api/v1/drives?endGeofenceId=${home}`);
    expect(back.totals.count).toBe(1);
    expect(back.drives[0]!.startLabel).toBe("Work");
  });

  it("takes both ends together as one journey", async () => {
    const cookie = await login();
    const home = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4 });
    const work = await seedGeofence({ name: "Work", latitude: 52.6, longitude: 13.5 });
    await seedDrive(DETAIL_CAR, { startAt: T0, startGeofenceId: home, endGeofenceId: work });
    await seedDrive(DETAIL_CAR, { startAt: T0 + DAY, startGeofenceId: home });

    const commute = await getJson<DriveListDto>(
      cookie,
      `/api/v1/drives?startGeofenceId=${home}&endGeofenceId=${work}`,
    );
    expect(commute.totals.count).toBe(1);
    expect(commute.drives[0]!.startAt).toBe(T0);
  });

  it("narrows the combined route to the drives between those places", async () => {
    const cookie = await login();
    const home = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4 });
    await seedDrive(DETAIL_CAR, { startAt: T0, startGeofenceId: home });
    await seedDrive(DETAIL_CAR, { startAt: T0 + DAY });

    const route = await getJson<DrivesRouteDto>(cookie, `/api/v1/drives/route?startGeofenceId=${home}`);
    expect(route.fromAt).toBe(T0);
    expect(route.toAt).toBe(T0 + 3 * 60_000);
  });

  it("matches nothing for a place no drive touched", async () => {
    const cookie = await login();
    const home = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4 });
    await seedDrive(DETAIL_CAR, { startAt: T0 });
    const body = await getJson<DriveListDto>(cookie, `/api/v1/drives?startGeofenceId=${home}`);
    expect(body.totals.count).toBe(0);
  });
});

describe("combined route", () => {
  beforeEach(resetSortCar);

  it("returns the path across every filtered drive", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DrivesRouteDto>(cookie, "/api/v1/drives/route");
    expect(body.path.length).toBe(6); // 2 positions per drive
    expect(body.fromAt).toBe(TS);
    expect(body.toAt).toBe(TS + 2 * DAY + 10 * 60_000);
  });

  it("thins a long track rather than returning every position", async () => {
    const cookie = await login();
    const driveId = await seedDrive(SORT_CAR, { startAt: TS });
    // Four thousand samples on one drive — far past what a map needs, and past
    // what the endpoint should ever read into memory.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3999)
       INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude)
       SELECT ?1, ?2, ?3 + i * 1000, 52.5 + i * 0.0001, 13.4 FROM n`,
    )
      .bind(SORT_CAR, driveId, TS)
      .run();

    const body = await getJson<DrivesRouteDto>(cookie, "/api/v1/drives/route");
    // Sampled to roughly 1500 points: enough to draw the track, few enough to send.
    expect(body.path.length).toBeGreaterThan(1000);
    expect(body.path.length).toBeLessThan(1700);
  });

  it("narrows the path when the filter narrows", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DrivesRouteDto>(cookie, "/api/v1/drives/route?minDistanceKm=90");
    expect(body.path.length).toBe(2);
  });

  it("summarises charging within the window spanned by those drives", async () => {
    const cookie = await login();
    await seedSortableDrives();
    await seedComparableCharge(SORT_CAR, { at: TS + DAY + 3_600_000, energy: 30, durationMin: 45, costCents: 900 });
    // Outside the drive window, so it must not be counted.
    await seedComparableCharge(SORT_CAR, { at: TS + 10 * DAY, energy: 99, durationMin: 60, costCents: 5000 });

    const body = await getJson<DrivesRouteDto>(cookie, "/api/v1/drives/route");
    expect(body.charging.count).toBe(1);
    expect(body.charging.energyKwh).toBeCloseTo(30, 5);
    expect(body.charging.costCents).toBe(900);
    expect(body.charging.durationMin).toBe(45);
  });

  it("is empty when no drives match", async () => {
    const cookie = await login();
    await seedSortableDrives();
    const body = await getJson<DrivesRouteDto>(cookie, "/api/v1/drives/route?minDistanceKm=9999");
    expect(body.path).toEqual([]);
    expect(body.fromAt).toBeNull();
    expect(body.charging.count).toBe(0);
  });

  it("does not collide with the drive detail route", async () => {
    const cookie = await login();
    await seedSortableDrives();
    // "route" must be matched as the literal path, not parsed as an id.
    const res = await authed(cookie, "/api/v1/drives/route");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("path");
  });
});

describe("place labels", () => {
  beforeEach(resetDetailCar);

  /** An address row with only the columns a case needs; the rest stay NULL. */
  async function seedAddress(fields: {
    road?: string;
    house_number?: string;
    name?: string;
    city?: string;
    county?: string;
    state?: string;
    postcode?: string;
  }): Promise<number> {
    const columns = Object.keys(fields);
    const row = await env.DB.prepare(
      `INSERT INTO addresses (${columns.join(", ")}, display_name, latitude, longitude, inserted_at, updated_at) ` +
        `VALUES (${columns.map(() => "?").join(", ")}, 'full display name', 52.5, 13.4, 0, 0) RETURNING id`,
    )
      .bind(...columns.map((c) => fields[c as keyof typeof fields]!))
      .first<{ id: number }>();
    return row!.id;
  }

  /** What the list puts in "From" for a drive that started at `addressId`. */
  async function startPlace(cookie: string, addressId: number): Promise<{ label: string | null; region: string | null }> {
    const id = await seedDrive(DETAIL_CAR, { startAt: T0 });
    await env.DB.prepare("UPDATE drives SET start_address_id = ? WHERE id = ?").bind(addressId, id).run();
    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives");
    await env.DB.prepare("DELETE FROM drives WHERE id = ?").bind(id).run();
    const drive = body.drives[0]!;
    return { label: drive.startLabel, region: drive.startRegion };
  }

  it("names the street, with the town it is in beside it", async () => {
    const cookie = await login();
    const address = await seedAddress({ road: "Torstraße", house_number: "1", city: "Berlin" });
    expect(await startPlace(cookie, address)).toEqual({ label: "Torstraße 1", region: "Berlin" });
  });

  it("falls back to the place's own name when there is no street", async () => {
    const cookie = await login();
    const address = await seedAddress({ name: "Ionity Brohltal", city: "Niederzissen" });
    expect(await startPlace(cookie, address)).toEqual({ label: "Ionity Brohltal", region: "Niederzissen" });
  });

  it("stands a region in for a town the geocoder could not name", async () => {
    const cookie = await login();
    const county = await seedAddress({ road: "Feldweg", county: "Uckermark", state: "Brandenburg" });
    expect(await startPlace(cookie, county)).toEqual({ label: "Feldweg", region: "Uckermark" });

    const state = await seedAddress({ road: "Feldweg", state: "Brandenburg" });
    expect(await startPlace(cookie, state)).toEqual({ label: "Feldweg", region: "Brandenburg" });
  });

  it("gives the town alone when that is all the address holds", async () => {
    const cookie = await login();
    const address = await seedAddress({ city: "Leipzig" });
    // As the label, not as a region dimmed after nothing.
    expect(await startPlace(cookie, address)).toEqual({ label: "Leipzig", region: null });
  });

  it("does not repeat a town that is already the whole label", async () => {
    const cookie = await login();
    const address = await seedAddress({ name: "Berlin", city: "Berlin" });
    expect(await startPlace(cookie, address)).toEqual({ label: "Berlin", region: null });
  });

  it("has nothing to show for an address with neither a spot nor a region", async () => {
    const cookie = await login();
    const address = await seedAddress({ postcode: "10119" });
    expect(await startPlace(cookie, address)).toEqual({ label: null, region: null });
  });

  it("leaves a geofence to stand on its own name", async () => {
    const cookie = await login();
    const address = await seedAddress({ road: "Torstraße", house_number: "1", city: "Berlin" });
    const id = await seedDrive(DETAIL_CAR, { startAt: T0 });
    const geofence = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4 });
    await env.DB.prepare("UPDATE drives SET start_address_id = ?, start_geofence_id = ? WHERE id = ?")
      .bind(address, geofence, id)
      .run();

    const body = await getJson<DriveListDto>(cookie, "/api/v1/drives");
    expect(body.drives[0]!.startLabel).toBe("Home");
    expect(body.drives[0]!.startRegion).toBeNull();
  });
});
