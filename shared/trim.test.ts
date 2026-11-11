import { describe, expect, it } from "bun:test";
import { trimMarketingName } from "./trim";

describe("naming a trim the way Tesla sells it", () => {
  it("names the Model 3 and Model Y trims", () => {
    expect(trimMarketingName({ model: "Y", trimBadging: "p74d" })).toBe("Performance");
    expect(trimMarketingName({ model: "Y", trimBadging: "74d" })).toBe("Long Range");
    expect(trimMarketingName({ model: "Y", trimBadging: "74" })).toBe("Long Range RWD");
    expect(trimMarketingName({ model: "3", trimBadging: "62" })).toBe("Mid Range");
    expect(trimMarketingName({ model: "3", trimBadging: "50" })).toBe("Standard Range");
  });

  it("tells a Plaid from the older Performance by year or motor count", () => {
    expect(trimMarketingName({ model: "S", trimBadging: "p100d", modelYear: 2022 })).toBe("Plaid");
    expect(trimMarketingName({ model: "X", trimBadging: "p100d", modelYear: 2020 })).toBe("Performance");
    expect(trimMarketingName({ model: "S", trimBadging: "p100d", motorCount: 3 })).toBe("Plaid");
    expect(trimMarketingName({ model: "S", trimBadging: "100d", modelYear: 2023 })).toBe("Long Range");
  });

  it("keeps a badge that was itself the name", () => {
    expect(trimMarketingName({ model: "S", trimBadging: "p90d", modelYear: 2016 })).toBe("P90D");
    expect(trimMarketingName({ model: "S", trimBadging: "100d", modelYear: 2018 })).toBe("100D");
    expect(trimMarketingName({ model: null, trimBadging: "74d" })).toBe("74D");
  });

  it("has nothing to say without a badge", () => {
    expect(trimMarketingName({ model: "Y", trimBadging: null })).toBeNull();
    expect(trimMarketingName({ model: "Y", trimBadging: " " })).toBeNull();
  });
});
