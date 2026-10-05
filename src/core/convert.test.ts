import { describe, expect, it } from "vitest";
import { celsiusToFahrenheit, kmToMiles, milesToKm, mphToKmh, secToStr } from "./convert";

describe("unit conversion", () => {
  it("matches TeslaMate's factors", () => {
    expect(mphToKmh(62)).toBe(100);
    expect(milesToKm(100, 2)).toBeCloseTo(160.93, 2);
    expect(kmToMiles(160.93, 2)).toBeCloseTo(100, 1);
    expect(celsiusToFahrenheit(20, 1)).toBe(68);
  });

  it("passes null through", () => {
    expect(mphToKmh(null)).toBeNull();
    expect(milesToKm(undefined, 2)).toBeNull();
  });

  it("humanizes durations to the two coarsest units", () => {
    expect(secToStr(90)).toEqual(["1 min", "30 s"]);
    expect(secToStr(3 * 3600 + 5 * 60)).toEqual(["3 h", "5 min"]);
    expect(secToStr(0)).toEqual([]);
  });
});
