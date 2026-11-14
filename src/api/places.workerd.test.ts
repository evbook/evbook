import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlaceDto } from "@shared/api-types";
import { authed, getJson, login } from "../../test/http";
import { resetLoggedCar, seedGeofence } from "../../test/seed";

/** HTTP tests for naming a coordinate: the car marker's location card. */

describe("place API", () => {
  beforeEach(() => resetLoggedCar(7));

  it("names a point inside a geofence by the geofence", async () => {
    const cookie = await login();
    await seedGeofence({ name: "Home", latitude: 52.52, longitude: 13.4, radius: 200 });
    const place = await getJson<PlaceDto>(cookie, "/api/v1/place?lat=52.5205&lon=13.4");
    expect(place).toEqual({ label: "Home", region: null, geofence: true });
  });

  it("answers from a stored address nearby without asking the geocoder", async () => {
    const cookie = await login();
    await env.DB.prepare(
      "INSERT INTO addresses (road, house_number, city, latitude, longitude, inserted_at, updated_at) " +
        "VALUES ('Torstraße', '1', 'Berlin', 52.5, 13.4, 0, 0)",
    ).run();
    // About 20 m north of the stored row.
    const place = await getJson<PlaceDto>(cookie, "/api/v1/place?lat=52.50018&lon=13.4");
    expect(place).toEqual({ label: "Torstraße 1", region: "Berlin", geofence: false });
  });

  it("rejects a coordinate that is not one", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/place?lat=91&lon=0")).status).toBe(400);
    expect((await authed(cookie, "/api/v1/place?lat=abc&lon=0")).status).toBe(400);
  });
});
