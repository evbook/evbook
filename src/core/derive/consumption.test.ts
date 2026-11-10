import { describe, expect, it } from "bun:test";
import { consumptionPer100km, consumptionSql, MIN_CONSUMPTION_DISTANCE_KM } from "./consumption";

describe("consumptionPer100km", () => {
  it("divides energy by distance", () => {
    expect(consumptionPer100km(2.25, 20)).toBeCloseTo(11.25, 5);
  });

  it("withholds the ratio under the minimum distance", () => {
    // The case from the archive: 17 m awake for a minute, 0.11 km of range at
    // 0.16 kWh/km, which divides out to 103 kWh/100 km.
    expect(consumptionPer100km(0.0176, 0.017)).toBeNull();
  });

  it("reports it at the minimum distance itself", () => {
    expect(consumptionPer100km(0.15, MIN_CONSUMPTION_DISTANCE_KM)).toBeCloseTo(15, 5);
  });

  it("keeps a negative figure, which is a descent giving energy back", () => {
    expect(consumptionPer100km(-2, 20)).toBeCloseTo(-10, 5);
  });

  it("has nothing to say without an energy or a distance", () => {
    expect(consumptionPer100km(null, 20)).toBeNull();
    expect(consumptionPer100km(2, null)).toBeNull();
  });
});

describe("consumptionSql", () => {
  it("guards on the same distance the TypeScript rule does", () => {
    const sql = consumptionSql("(r * e)", "d.distance");
    expect(sql).toContain(`d.distance >= ${MIN_CONSUMPTION_DISTANCE_KM}`);
    expect(sql).toContain("(r * e) / d.distance * 100");
  });
});
