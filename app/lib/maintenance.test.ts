import { describe, expect, it } from "bun:test";
import type { GlobalSettingsDto, MaintenanceDto } from "@shared/api-types";
import { lampName, serviceLeft } from "./maintenance";

const km = {
  unitOfLength: "km",
  unitOfTemperature: "C",
  unitOfPressure: "bar",
  currency: "CHF",
} as unknown as GlobalSettingsDto;
const base: MaintenanceDto = {
  serviceDue: false,
  serviceReason: null,
  serviceDistanceKm: 29631,
  serviceMonths: 23,
  washerFluidWarning: false,
  oilLevelWarning: false,
  coolantLevelWarning: false,
  brakeFluidWarning: false,
  lampFailures: [],
};

describe("serviceLeft", () => {
  it("counts down in distance and months", () => {
    expect(serviceLeft(base, km)).toMatch(/^in 29.631 km · 23 months$/);
  });
  it("says when a service is due, and stays quiet when Volvo says nothing", () => {
    expect(serviceLeft({ ...base, serviceDue: true }, km)).toMatch(/^Due · /);
    expect(serviceLeft({ ...base, serviceDistanceKm: null, serviceMonths: 1 }, km)).toBe("in 1 month");
    // 12 days, as Volvo may send them: not "0 months".
    expect(serviceLeft({ ...base, serviceMonths: 12 / 30.4375 }, km)).toMatch(/^in 29.631 km · due this month$/);
    expect(serviceLeft({ ...base, serviceDistanceKm: null, serviceMonths: null }, km)).toBeNull();
  });
});

describe("lampName", () => {
  it("turns Volvo's field names into words", () => {
    expect(lampName("brakeLightLeft")).toBe("Brake light left");
    expect(lampName("turnIndicationRearRight")).toBe("Turn indication rear right");
  });
});
