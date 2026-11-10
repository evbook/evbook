import { describe, expect, it } from "bun:test";
import { calculateCostCents } from "./cost";

describe("charge cost", () => {
  it("is free at a supercharger with free supercharging", () => {
    const cost = calculateCostCents({
      fastChargerType: "Tesla",
      freeSupercharging: true,
      energyAdded: 40,
      energyUsed: 42,
      durationMin: 30,
      geofence: null,
    });
    expect(cost).toBe(0);
  });

  it("charges per kWh on the greater of added and used energy", () => {
    const cost = calculateCostCents({
      fastChargerType: null,
      freeSupercharging: false,
      energyAdded: 40,
      energyUsed: 42,
      durationMin: 30,
      geofence: { billing_type: "per_kwh", cost_per_unit: 0.3, session_fee_cents: 100 },
    });
    // 42 kWh * 0.30 = 12.60 plus a 1.00 session fee.
    expect(cost).toBe(1360);
  });

  it("charges per minute", () => {
    const cost = calculateCostCents({
      fastChargerType: null,
      freeSupercharging: false,
      energyAdded: 40,
      energyUsed: null,
      durationMin: 30,
      geofence: { billing_type: "per_minute", cost_per_unit: 0.1, session_fee_cents: null },
    });
    expect(cost).toBe(300);
  });

  it("is unknown without a matching geofence", () => {
    const cost = calculateCostCents({
      fastChargerType: "Combo",
      freeSupercharging: true,
      energyAdded: 10,
      energyUsed: 11,
      durationMin: 20,
      geofence: null,
    });
    expect(cost).toBeNull();
  });

  it("still applies a session fee when no rate is set", () => {
    const cost = calculateCostCents({
      fastChargerType: null,
      freeSupercharging: false,
      energyAdded: 10,
      energyUsed: null,
      durationMin: 20,
      geofence: { billing_type: "per_kwh", cost_per_unit: null, session_fee_cents: 250 },
    });
    expect(cost).toBe(250);
  });
});
