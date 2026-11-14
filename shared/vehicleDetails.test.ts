import { describe, expect, it } from "bun:test";
import type { VehicleDetailsDto } from "./api-types";
import { vehicleDetailRows, vehicleSubtitle } from "./vehicleDetails";

// An XC40 as Volvo described it on 2026-11-14; the VIN is a made-up one.
const xc40: VehicleDetailsDto = {
  modelYear: 2022,
  driveType: "AWD",
  enginePowerKw: 300,
  batteryCapacityKwh: 78,
  firstRegistration: "2021-12-10",
  colour: "Crystal White",
  seats: 5,
  curbWeightKg: null,
  grossWeightKg: 2650,
};
const car = { model: "XC40", vin: "YV1XZEDV0N2000000" };

describe("vehicleDetailRows", () => {
  it("lists what the provider reports, like a Tesla's VIN rows", () => {
    expect(vehicleDetailRows(car, xc40, (day) => `day ${day}`)).toEqual([
      { label: "Model", value: "2022 XC40" },
      { label: "Drive", value: "AWD · 300 kW" },
      { label: "Pack", value: "78 kWh" },
      { label: "First registration", value: "day 2021-12-10" },
      { label: "Colour", value: "Crystal White" },
      { label: "Seats", value: "5" },
      { label: "Weight", value: "2,650 kg gross" },
      { label: "Serial", value: "000000" },
    ]);
  });

  it("drops a row without a value", () => {
    const rows = vehicleDetailRows(
      car,
      { ...xc40, enginePowerKw: null, colour: null, firstRegistration: null },
      String,
    );
    expect(rows.find((r) => r.label === "Drive")?.value).toBe("AWD");
    expect(rows.map((r) => r.label)).not.toContain("Colour");
    expect(rows.map((r) => r.label)).not.toContain("First registration");
  });
});

describe("vehicleSubtitle", () => {
  it("reads year, model and drive, without the make", () => {
    expect(vehicleSubtitle("XC40", xc40)).toBe("2022 XC40 AWD");
  });

  it("is null when the details add nothing to the model", () => {
    expect(vehicleSubtitle("XC40", null)).toBeNull();
    expect(vehicleSubtitle("XC40", { ...xc40, modelYear: null, driveType: null })).toBeNull();
  });
});
