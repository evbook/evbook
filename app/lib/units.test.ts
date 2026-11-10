import { describe, expect, it } from "bun:test";
import { consumption, consumptionValue, DEFAULT_UNITS, type Units } from "./units";

/**
 * The consumption pair, which is the one conversion in here with a history: four
 * pages once printed the per-100-km figure under a miles label, and the fix was to
 * make this the only place that knows. So this pins the factor rather than trusting
 * it, in both units and in both directions the drives page needs it.
 */

const KM: Units = DEFAULT_UNITS;
const MI: Units = { ...DEFAULT_UNITS, unitOfLength: "mi" };

describe("consumption", () => {
  it("reads per kilometre, ten times the per-100-km figure", () => {
    expect(consumption(17.3, KM)).toBe("173 Wh/km");
  });

  it("goes up for miles, a mile being the longer distance to cover", () => {
    // 17.3 kWh/100 km is 27.8 kWh/100 mi, so 278 Wh for one mile.
    expect(consumption(17.3, MI)).toBe("278 Wh/mi");
  });

  it("has nothing to say about a withheld figure", () => {
    expect(consumption(null, KM)).toBe("–");
    expect(consumption(undefined, MI)).toBe("–");
  });

  it("keeps a negative figure, which is a descent giving energy back", () => {
    expect(consumption(-2.5, KM)).toBe("-25 Wh/km");
  });

  it("still takes a precision, for anywhere a whole Wh is too coarse", () => {
    expect(consumption(17.34, KM, 1)).toBe("173.4 Wh/km");
  });
});

describe("consumptionValue", () => {
  it("converts without labelling, for chart axes and slider handles", () => {
    expect(consumptionValue(17.3, KM)).toBeCloseTo(173, 5);
    expect(consumptionValue(17.3, MI)).toBeCloseTo(278.4, 1);
    expect(consumptionValue(null, KM)).toBeNull();
  });

  it("round-trips the scale the drives filter sends back to the API", () => {
    // The slider reads in Wh and the API takes kWh/100 km, so `rangeParams` scales
    // by a tenth — by KM_FACTOR/10 in miles. Whatever the handle shows must divide
    // back to the figure it was drawn from, or a filter excludes what it displays.
    for (const [units, scale] of [
      [KM, 1 / 10],
      [MI, 0.62137119223733 / 10],
    ] as const) {
      expect(consumptionValue(17.3, units)! * scale).toBeCloseTo(17.3, 5);
    }
  });
});
