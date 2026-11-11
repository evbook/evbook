import { describe, expect, it } from "bun:test";
import { details, energyState, ex30 } from "../../../test/fake-volvo";
import {
  fingerprint,
  mergeView,
  normalize,
  normalizeDetails,
  normalizeDoors,
  normalizeEnergyState,
  normalizeLocation,
  normalizeTyres,
  powertrainOf,
} from "./normalize";

const AT = "2026-10-10T11:02:03.000Z";
const AT_MS = Date.parse(AT);

describe("energy state", () => {
  it("maps every property that reports OK, in EVBook's units", () => {
    const view = normalizeEnergyState(
      energyState(
        ex30({
          soc: 62,
          charging: "CHARGING",
          cable: "CONNECTED",
          chargeType: "AC",
          powerKw: 7.4,
          minutesToTarget: 45,
          at: AT_MS,
        }),
      ),
    );
    expect(view.soc).toEqual({ v: 62, at: AT_MS });
    expect(view.rangeKm?.v).toBe(260);
    expect(view.charging?.v).toBe("charging");
    expect(view.cable?.v).toBe("connected");
    expect(view.chargeType?.v).toBe("AC");
    expect(view.powerKw?.v).toBeCloseTo(7.4);
    expect(view.targetSoc?.v).toBe(90);
    expect(view.minutesToTarget?.v).toBe(45);
    expect(view.currentLimitA?.v).toBe(16);
  });

  it("never turns an unsupported or missing property into zero", () => {
    const view = normalizeEnergyState({
      batteryChargeLevel: { status: "ERROR", code: "PROPERTY_NOT_SUPPORTED", message: "nope" },
      electricRange: null,
      chargingPower: { status: "OK", value: 3, unit: "horsepower", updatedAt: AT },
      chargingStatus: { status: "OK", value: "SOMETHING_NEW", updatedAt: AT },
      estimatedChargingTimeToTargetBatteryChargeLevel: { status: "OK", value: 0, unit: "minutes", updatedAt: AT },
    });
    // Covered, and unknown: the keys are there so the previous values are cleared.
    expect("soc" in view).toBe(true);
    expect(view.soc).toBeNull();
    expect(view.rangeKm).toBeNull();
    expect(view.powerKw).toBeNull(); // unknown unit
    expect(view.charging).toBeNull(); // unknown enum
    expect(view.minutesToTarget).toBeNull(); // 0 means "not charging"
  });

  it("converts miles and kilowatts", () => {
    const view = normalizeEnergyState({
      electricRange: { status: "OK", value: 100, unit: "mi", updatedAt: AT },
      chargingPower: { status: "OK", value: 11, unit: "kW", updatedAt: AT },
    });
    expect(view.rangeKm?.v).toBeCloseTo(160.9344);
    expect(view.powerKw?.v).toBe(11);
  });
});

describe("connected vehicle", () => {
  it("reads engine status and odometer, and drops a value without a unit", () => {
    expect(normalize("engine-status", { data: { engineStatus: { value: "RUNNING", timestamp: AT } } })).toEqual({
      engineRunning: { v: true, at: AT_MS },
    });
    expect(normalize("engine-status", { data: { engineStatus: { value: "UNSPECIFIED", timestamp: AT } } })).toEqual({
      engineRunning: null,
    });
    expect(
      normalize("odometer", { data: { odometer: { value: 1000, unit: "miles", timestamp: AT } } }).odometerKm?.v,
    ).toBeCloseTo(1609.344);
    expect(normalize("odometer", { data: { odometer: { value: 1000, timestamp: AT } } }).odometerKm).toBeNull();
  });

  it("reads statistics, consumption only in kWh/100km", () => {
    const view = normalize("statistics", {
      data: {
        tripMeterAutomatic: { value: 12.3, unit: "km", timestamp: AT },
        averageEnergyConsumptionAutomatic: { value: 17.1, unit: "kWh/100km", timestamp: AT },
      },
    });
    expect(view.tripMeterKm?.v).toBe(12.3);
    expect(view.consumptionKwhPer100Km?.v).toBe(17.1);
  });

  it("treats UNSPECIFIED doors as unknown, not closed, and stamps the group with its latest time", () => {
    const later = "2026-10-10T12:00:00.000Z";
    const view = normalizeDoors({
      data: {
        frontLeftDoor: { value: "OPEN", timestamp: AT },
        frontRightDoor: { value: "UNSPECIFIED", timestamp: later },
        hood: { value: "AJAR", timestamp: AT },
        centralLock: { value: "UNSPECIFIED", timestamp: AT },
      },
    });
    expect(view.doors?.v).toEqual({
      frontLeft: "open",
      frontRight: null,
      rearLeft: null,
      rearRight: null,
      hood: "ajar",
      tailgate: null,
    });
    expect(view.doors?.at).toBe(AT_MS);
    expect(view.locked).toBeNull();
  });

  it("reports tyre warnings, and an unknown warning as a fault", () => {
    const view = normalizeTyres({
      data: {
        frontLeft: { value: "NO_WARNING", timestamp: AT },
        frontRight: { value: "VERY_LOW_PRESSURE", timestamp: AT },
        rearLeft: { value: "SENSOR_BROKEN", timestamp: AT },
        rearRight: { value: "UNSPECIFIED", timestamp: AT },
      },
    });
    expect(view.tyres?.v).toEqual({ frontLeft: "ok", frontRight: "very-low", rearLeft: "fault", rearRight: null });
  });
});

describe("location", () => {
  it("reads GeoJSON longitude first", () => {
    const view = normalizeLocation({
      data: { geometry: { coordinates: [13.405, 52.52, 34] }, properties: { timestamp: AT } },
    });
    expect(view.position).toEqual({ v: { lat: 52.52, lon: 13.405, alt: 34 }, at: AT_MS });
  });

  it("clears the position for a missing, short or null-island answer", () => {
    expect(normalizeLocation({ data: {} }).position).toBeNull();
    expect(normalizeLocation({ data: { geometry: { coordinates: [13.4] } } }).position).toBeNull();
    expect(normalizeLocation({ data: { geometry: { coordinates: [null, 52.5] } } }).position).toBeNull();
    expect(normalizeLocation({ data: { geometry: { coordinates: [0, 0] } } }).position).toBeNull();
  });
});

describe("details", () => {
  it("reads an EX30, which reports its fuel type as NONE", () => {
    expect(normalizeDetails(details(ex30())).details).toEqual({
      model: "EX30",
      modelYear: 2024,
      batteryCapacityKwh: 69,
      powertrain: "electric",
      colour: "Cloud Blue",
      imageUrl: "https://cas.volvocars.com/image/test.png",
    });
  });

  it("survives a car with no specifications at all", () => {
    expect(normalizeDetails({ data: { descriptions: {} } }).details).toEqual({
      model: null,
      modelYear: null,
      batteryCapacityKwh: null,
      powertrain: null,
      colour: null,
      imageUrl: null,
    });
  });

  it("names a plug-in hybrid, and never guesses otherwise", () => {
    expect(powertrainOf("PETROL/ELECTRIC")).toBe("plug-in-hybrid");
    expect(powertrainOf("ELECTRIC")).toBe("electric");
    expect(powertrainOf("DIESEL")).toBe("other");
    expect(powertrainOf(undefined)).toBeNull();
  });
});

describe("mergeView", () => {
  it("replaces covered fields, clears covered-but-absent ones, keeps the rest", () => {
    const before = mergeView({}, { soc: { v: 50, at: 1 }, odometerKm: { v: 10, at: 1 } });
    const after = mergeView(before, normalizeEnergyState({ batteryChargeLevel: null }));
    expect(after.soc).toBeNull();
    expect(after.odometerKm).toEqual({ v: 10, at: 1 });
  });
});

describe("fingerprint", () => {
  it("ignores the keys that change on every poll, and nothing else", async () => {
    const a = await fingerprint({ data: { odometer: { value: 1, unit: "km", timestamp: "2026-01-01T00:00:00Z" } } });
    const b = await fingerprint({ data: { odometer: { unit: "km", value: 1, timestamp: "2026-02-01T00:00:00Z" } } });
    const c = await fingerprint({ data: { odometer: { value: 2, unit: "km", timestamp: "2026-01-01T00:00:00Z" } } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await fingerprint({ x: { updatedAt: "1", value: 1 }, operationId: "z" })).toBe(
      await fingerprint({ x: { value: 1 } }),
    );
  });
});
