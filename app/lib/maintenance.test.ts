import { describe, expect, it } from "bun:test";
import type { GlobalSettingsDto, MaintenanceDto } from "@shared/api-types";
import { lampName, serviceLeft, serviceWarns } from "./maintenance";

const km = {
  unitOfLength: "km",
  unitOfTemperature: "C",
  unitOfPressure: "bar",
  currency: "CHF",
} as unknown as GlobalSettingsDto;
const base: MaintenanceDto = {
  serviceStatus: "ok",
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
  it("counts down in distance and months while all is fine", () => {
    expect(serviceLeft(base, km)).toMatch(/^in 29.631 km · 23 months$/);
    expect(serviceLeft({ ...base, serviceDistanceKm: null, serviceMonths: 1 }, km)).toBe("in 1 month");
    // 12 days, as Volvo may send them: not "0 months".
    expect(serviceLeft({ ...base, serviceMonths: 12 / 30.4375 }, km)).toMatch(/^in 29.631 km · due this month$/);
    expect(serviceLeft({ ...base, serviceDistanceKm: null, serviceMonths: null }, km)).toBeNull();
  });

  it("names the stage when Volvo warns", () => {
    expect(serviceLeft({ ...base, serviceStatus: "soon", serviceDistanceKm: 800, serviceMonths: 0.4 }, km)).toBe(
      "Due soon · in 800 km · due this month",
    );
    expect(serviceLeft({ ...base, serviceStatus: "due", serviceDistanceKm: 0, serviceMonths: 0 }, km)).toBe("Due now");
    expect(serviceLeft({ ...base, serviceStatus: "warning" }, km)).toBe("Service warning");
  });

  it("says overdue, by how far when Volvo counts below zero, and never shows a negative count", () => {
    expect(serviceLeft({ ...base, serviceStatus: "overdue", serviceDistanceKm: -500, serviceMonths: -1 }, km)).toBe(
      "Overdue by 500 km",
    );
    expect(serviceLeft({ ...base, serviceStatus: "overdue", serviceDistanceKm: 0, serviceMonths: 0 }, km)).toBe(
      "Overdue",
    );
    expect(serviceLeft({ ...base, serviceDistanceKm: -500, serviceMonths: -1 }, km)).toBeNull();
  });
});

describe("serviceWarns", () => {
  it("stands out for every stage but fine and unknown", () => {
    expect(serviceWarns(base)).toBe(false);
    expect(serviceWarns({ ...base, serviceStatus: null })).toBe(false);
    for (const s of ["soon", "due", "overdue", "warning"] as const)
      expect(serviceWarns({ ...base, serviceStatus: s })).toBe(true);
  });
});

describe("lampName", () => {
  it("turns Volvo's field names into words", () => {
    expect(lampName("brakeLightLeft")).toBe("Brake light left");
    expect(lampName("turnIndicationRearRight")).toBe("Turn indication rear right");
  });
});
