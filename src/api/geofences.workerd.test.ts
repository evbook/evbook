import { beforeEach, describe, expect, it } from "vitest";
import type { ChargeListDto, DriveListDto, GeofenceDto } from "@shared/api-types";
import { authed, login } from "../../test/http";
import { resetLoggedCar, seedCharge, seedDrive } from "../../test/seed";

/** HTTP tests for named places: CRUD, drive labelling and cost backfill. */

const CAR_ID = 7;
const T0 = 1_760_000_000_000;

describe("geofences API", () => {
  beforeEach(() => resetLoggedCar(CAR_ID, { efficiency: 0.15, insertedAt: T0 }));

  async function create(cookie: string, overrides: Record<string, unknown> = {}) {
    const res = await authed(cookie, "/api/v1/geofences", {
      method: "POST",
      body: JSON.stringify({ name: "Home", latitude: 52.52, longitude: 13.4, radius: 2000, ...overrides }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: number }).id;
  }

  it("creates, lists, updates and deletes", async () => {
    const cookie = await login();
    const id = await create(cookie);

    let list = (await (await authed(cookie, "/api/v1/geofences")).json()) as GeofenceDto[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Home", radius: 2000, billingType: "per_kwh" });

    const update = await authed(cookie, `/api/v1/geofences/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Casa", latitude: 52.52, longitude: 13.4, radius: 300, billingType: "per_minute" }),
    });
    expect(update.status).toBe(200);
    list = (await (await authed(cookie, "/api/v1/geofences")).json()) as GeofenceDto[];
    expect(list[0]).toMatchObject({ name: "Casa", radius: 300, billingType: "per_minute" });

    expect((await authed(cookie, `/api/v1/geofences/${id}`, { method: "DELETE" })).status).toBe(204);
    list = (await (await authed(cookie, "/api/v1/geofences")).json()) as GeofenceDto[];
    expect(list).toHaveLength(0);
  });

  it("rejects an invalid radius or missing name", async () => {
    const cookie = await login();
    for (const patch of [{ radius: 0 }, { radius: 5000 }, { name: "" }]) {
      const res = await authed(cookie, "/api/v1/geofences", {
        method: "POST",
        body: JSON.stringify({ name: "X", latitude: 1, longitude: 1, radius: 100, ...patch }),
      });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
  });

  it("labels existing drives when a geofence is created", async () => {
    const cookie = await login();
    await seedDrive(CAR_ID, { startAt: T0, startLat: 52.52 });
    let drives = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(drives.drives[0]!.startLabel).toBeNull();

    await create(cookie);
    drives = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(drives.drives[0]!.startLabel).toBe("Home");
  });

  it("unlabels drives when the geofence is deleted", async () => {
    const cookie = await login();
    await seedDrive(CAR_ID, { startAt: T0, startLat: 52.52 });
    const id = await create(cookie);
    await authed(cookie, `/api/v1/geofences/${id}`, { method: "DELETE" });
    const drives = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(drives.drives[0]!.startLabel).toBeNull();
  });

  it("counts and backfills uncosted sessions at a location", async () => {
    const cookie = await login();
    await seedCharge(CAR_ID, { startAt: T0 });
    const id = await create(cookie, { costPerUnit: 0.3, sessionFeeCents: 100 });

    const uncosted = (await (await authed(cookie, `/api/v1/geofences/${id}/uncosted`)).json()) as { count: number };
    expect(uncosted.count).toBe(1);

    const applied = (await (
      await authed(cookie, `/api/v1/geofences/${id}/apply-costs`, { method: "POST" })
    ).json()) as { updated: number };
    expect(applied.updated).toBe(1);

    const charges = (await (await authed(cookie, "/api/v1/charges")).json()) as ChargeListDto;
    // Billed on the greater of added (10) and used (11) kWh, plus a 1.00 fee.
    expect(charges.charges[0]!.costCents).toBe(Math.round(11 * 0.3 * 100) + 100);
  });

  it("does not overwrite a cost that was already set", async () => {
    const cookie = await login();
    const chargeId = await seedCharge(CAR_ID, { startAt: T0 });
    await authed(cookie, `/api/v1/charges/${chargeId}/cost`, {
      method: "PUT",
      body: JSON.stringify({ value: 99 }),
    });
    const id = await create(cookie, { costPerUnit: 0.3 });
    await authed(cookie, `/api/v1/geofences/${id}/apply-costs`, { method: "POST" });
    const charges = (await (await authed(cookie, "/api/v1/charges")).json()) as ChargeListDto;
    expect(charges.charges[0]!.costCents).toBe(9900);
  });

  it("404s unknown geofences", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/geofences/9999", { method: "DELETE" })).status).toBe(404);
    expect((await authed(cookie, "/api/v1/geofences/9999/uncosted")).status).toBe(200);
    expect((await authed(cookie, "/api/v1/geofences/9999/apply-costs", { method: "POST" })).status).toBe(404);
  });
});
