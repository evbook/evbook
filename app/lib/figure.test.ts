import { describe, expect, it } from "vitest";
import { splitUnit } from "./figure";

/**
 * `splitUnit` decides which part of a formatted reading is set large. Getting it
 * wrong is visible at a glance — a unit set as a number, or half a duration as a
 * footnote — so the cases are the formatters' real outputs.
 */
describe("splitting a reading into number and unit", () => {
  it("splits a single trailing unit", () => {
    expect(splitUnit("314 km")).toEqual({ value: "314", unit: "km" });
    expect(splitUnit("17.5 °C")).toEqual({ value: "17.5", unit: "°C" });
    expect(splitUnit("11 kW")).toEqual({ value: "11", unit: "kW" });
    expect(splitUnit("80%")).toEqual({ value: "80", unit: "%" });
  });

  it("keeps grouping separators inside the number", () => {
    expect(splitUnit("92,770 km")).toEqual({ value: "92,770", unit: "km" });
    // Narrow no-break space, as some locales group thousands.
    expect(splitUnit("92 770 km")).toEqual({ value: "92 770", unit: "km" });
  });

  it("leaves a compound reading whole", () => {
    expect(splitUnit("1 h 45 min")).toEqual({ value: "1 h 45 min", unit: "" });
  });

  it("leaves a missing reading whole", () => {
    expect(splitUnit("–")).toEqual({ value: "–", unit: "" });
  });
});
