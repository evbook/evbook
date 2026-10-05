import { describe, expect, it } from "vitest";
import { boundingBox, findGeofence, haversineMeters } from "./geofence";

describe("geofence matching", () => {
  const home = { id: 1, latitude: 52.52, longitude: 13.405, radius: 100 };
  const work = { id: 2, latitude: 52.53, longitude: 13.42, radius: 50 };

  it("measures distance accurately", () => {
    // One degree of latitude is ~111 km.
    expect(haversineMeters(52, 13, 53, 13)).toBeCloseTo(111_195, -2);
    expect(haversineMeters(52.52, 13.405, 52.52, 13.405)).toBe(0);
  });

  it("matches a point inside the radius", () => {
    expect(findGeofence({ latitude: 52.5201, longitude: 13.4051 }, [home, work])?.id).toBe(1);
  });

  it("rejects a point outside every radius", () => {
    expect(findGeofence({ latitude: 52.6, longitude: 13.5 }, [home, work])).toBeNull();
  });

  it("prefers the nearest of two overlapping geofences", () => {
    const wide = { id: 3, latitude: 52.52, longitude: 13.405, radius: 4000 };
    const narrow = { id: 4, latitude: 52.5205, longitude: 13.4055, radius: 4000 };
    expect(findGeofence({ latitude: 52.5205, longitude: 13.4055 }, [wide, narrow])?.id).toBe(4);
  });

  it("returns null for a position with no coordinates", () => {
    expect(findGeofence({ latitude: null, longitude: null }, [home])).toBeNull();
  });

  it("builds a bounding box that contains the radius", () => {
    const box = boundingBox(52.52, 13.405, 100);
    expect(box.maxLat).toBeGreaterThan(52.52);
    expect(haversineMeters(52.52, 13.405, box.maxLat, 13.405)).toBeCloseTo(100, 0);
  });
});
