import { describe, expect, it } from "bun:test";
import { tyreStates, tyreStatus, tyresNeedAttention, type TyreReadingLike } from "./tyres";

const reading = (overrides: Partial<TyreReadingLike> = {}): TyreReadingLike => ({
  fl: 2.9,
  fr: 2.9,
  rl: 2.9,
  rr: 2.9,
  rcpFront: 2.9,
  rcpRear: 2.9,
  softFl: false,
  softFr: false,
  softRl: false,
  softRr: false,
  hardFl: false,
  hardFr: false,
  hardRl: false,
  hardRr: false,
  ...overrides,
});

describe("tyreStatus", () => {
  const at = (pressureBar: number | null, extra: Partial<Parameters<typeof tyreStatus>[0]> = {}) =>
    tyreStatus({ pressureBar, recommendedBar: 3.0, softWarning: false, hardWarning: false, ...extra });

  it("lets the car's own warnings decide outright", () => {
    expect(at(3.0, { softWarning: true })).toBe("low");
    expect(at(3.0, { hardWarning: true })).toBe("very-low");
    expect(at(null, { hardWarning: true, softWarning: true })).toBe("very-low");
  });

  it("adds thresholds against the recommended pressure", () => {
    expect(at(3.0)).toBe("ok");
    expect(at(2.71)).toBe("ok");
    expect(at(2.69)).toBe("low");
    expect(at(2.24)).toBe("very-low");
    expect(at(3.59)).toBe("ok");
    expect(at(3.61)).toBe("high");
  });

  it("never calls an unreported tyre fine", () => {
    expect(at(null)).toBe("unknown");
    expect(tyreStatus({ pressureBar: 2.9, recommendedBar: null, softWarning: null, hardWarning: null })).toBe(
      "unknown",
    );
    // Without a recommended pressure, the car's explicit "no warning" vouches for it.
    expect(tyreStatus({ pressureBar: 2.9, recommendedBar: null, softWarning: false, hardWarning: null })).toBe("ok");
  });

  it("calls a silent sensor a fault when the others answered", () => {
    expect(tyreStatus({ pressureBar: null, recommendedBar: 3, softWarning: null, hardWarning: null }, true)).toBe(
      "fault",
    );
  });
});

describe("tyreStates", () => {
  it("compares each tyre with its own axle's recommendation", () => {
    const states = tyreStates(reading({ rcpFront: 2.9, rcpRear: 3.4, rl: 2.9 }));
    expect(states.map((s) => s.status)).toEqual(["ok", "ok", "low", "low"]);
    expect(states[2]).toMatchObject({ corner: "rl", pressureBar: 2.9, recommendedBar: 3.4 });
  });

  it("reports four unknown tyres when there is no reading", () => {
    expect(tyreStates(null).map((s) => s.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(tyresNeedAttention(null)).toBe(false);
  });

  it("flags a missing sensor among reporting ones", () => {
    expect(tyreStates(reading({ rr: null })).map((s) => s.status)).toEqual(["ok", "ok", "ok", "fault"]);
    expect(tyresNeedAttention(reading({ rr: null }))).toBe(true);
  });

  it("needs attention for any warning tyre", () => {
    expect(tyresNeedAttention(reading())).toBe(false);
    expect(tyresNeedAttention(reading({ softRl: true }))).toBe(true);
    expect(tyresNeedAttention(reading({ fl: 3.6 }))).toBe(true);
  });
});
