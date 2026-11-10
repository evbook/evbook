import { describe, expect, it } from "bun:test";
import {
  calculateEnergyAdded,
  calculateEnergyUsed,
  determinePhases,
  modalFastChargerType,
  type ChargeSample,
} from "./energy";

const T0 = 1_700_000_000_000;

function samples(count: number, overrides: Partial<ChargeSample> = {}): ChargeSample[] {
  return Array.from({ length: count }, (_, i) => ({
    date_at: T0 + i * 60_000,
    charger_power: 11,
    charger_voltage: 230,
    charger_actual_current: 16,
    charger_phases: 3,
    charge_energy_added: i * 0.18,
    fast_charger_type: "<invalid>",
    ...overrides,
  }));
}

describe("energy added", () => {
  it("is the difference between first and last counter values", () => {
    const rows = samples(10);
    expect(calculateEnergyAdded(rows)).toBeCloseTo(1.62, 2);
  });

  it("survives the counter resetting to zero at the end of a session", () => {
    const rows = samples(5);
    rows[rows.length - 1]!.charge_energy_added = 0;
    // Falls back to the maximum seen instead of reporting a negative delta.
    expect(calculateEnergyAdded(rows)).toBeCloseTo(0.54, 2);
  });

  it("returns null rather than a negative amount", () => {
    const rows = samples(3);
    rows[0]!.charge_energy_added = 10;
    rows[1]!.charge_energy_added = 5;
    rows[2]!.charge_energy_added = 4;
    expect(calculateEnergyAdded(rows)).toBeNull();
  });

  it("handles an empty session", () => {
    expect(calculateEnergyAdded([])).toBeNull();
  });

  it("calls a counter that never left zero unknown, not zero", () => {
    // What a Tessie export looks like where the pack file has a gap: the charger
    // was working, but nothing measured what reached the battery.
    expect(calculateEnergyAdded(samples(5, { charge_energy_added: 0 }))).toBeNull();
  });
});

describe("phase determination", () => {
  it("needs more than 15 samples", () => {
    expect(determinePhases(samples(15))).toBeNull();
    expect(determinePhases(samples(16))).toBe(3);
  });

  it("applies the sqrt(3) voltage correction for three-phase charging", () => {
    // 400 V line voltage reported per-phase: implied ratio ~= sqrt(3).
    const rows = samples(20, {
      charger_power: 11,
      charger_voltage: 230,
      charger_actual_current: 16,
      charger_phases: 3,
    });
    for (const r of rows) r.charger_power = 6; // ratio ≈ 1.63 ≈ sqrt(3)
    expect(determinePhases(rows)).toBeCloseTo(Math.sqrt(3), 5);
  });

  it("corrects an under-reported phase count", () => {
    const rows = samples(20, { charger_phases: 1, charger_voltage: 230, charger_actual_current: 16, charger_power: 7 });
    expect(determinePhases(rows)).toBe(2);
  });

  it("gives up when the implied phase count is not close to a whole number", () => {
    // Implied ratio is 2.5 — too far from any integer to trust, and not 3-phase.
    const rows = samples(20, {
      charger_phases: 1,
      charger_voltage: 100,
      charger_actual_current: 10,
      charger_power: 2.5,
    });
    expect(determinePhases(rows)).toBeNull();
  });

  it("accepts a clean integer phase correction", () => {
    // Implied ratio is exactly 5, so the reported single phase is corrected.
    const rows = samples(20, {
      charger_phases: 1,
      charger_voltage: 100,
      charger_actual_current: 10,
      charger_power: 5,
    });
    expect(determinePhases(rows)).toBe(5);
  });
});

describe("energy used", () => {
  it("integrates current x voltage x phases over time", () => {
    // 16 A * 230 V * 3 = 11.04 kW over 19 minutes.
    const rows = samples(20);
    const expected = ((16 * 230 * 3) / 1000) * (19 / 60);
    expect(calculateEnergyUsed(rows)).toBeCloseTo(expected, 1);
  });

  it("falls back to charger_power when phases are unknown", () => {
    const rows = samples(4, { charger_phases: null, charger_power: 50 });
    // 50 kW over 3 minutes = 2.5 kWh.
    expect(calculateEnergyUsed(rows)).toBeCloseTo(2.5, 2);
  });

  it("ignores samples that would contribute negative energy", () => {
    const rows = samples(4, { charger_phases: null, charger_power: 50 });
    rows[2]!.charger_power = -50;
    expect(calculateEnergyUsed(rows)!).toBeLessThan(2.5);
  });

  it("returns null for a single sample", () => {
    expect(calculateEnergyUsed(samples(1))).toBeNull();
  });
});

describe("fast charger type", () => {
  it("takes the modal value across samples drawing power", () => {
    const rows = [...samples(3, { fast_charger_type: "Tesla" }), ...samples(5, { fast_charger_type: "Combo" })];
    expect(modalFastChargerType(rows)).toBe("Combo");
  });

  it("ignores samples with no power draw", () => {
    const rows = samples(4, { charger_power: 0, fast_charger_type: "Tesla" });
    expect(modalFastChargerType(rows)).toBeNull();
  });
});
