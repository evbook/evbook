import { describe, expect, it } from "bun:test";
import {
  CAPABILITIES,
  canDo,
  capabilitiesOf,
  cardMode,
  FIGURE_COUNT,
  FIGURE_PRIORITY,
  figuresFor,
  hasFeature,
} from "./capabilities";

describe("figuresFor", () => {
  it("keeps a Tesla's figures exactly as they were", () => {
    expect(figuresFor("tesla", "parked")).toEqual(["outsideTemp", "insideTemp", "odometer"]);
    expect(figuresFor("tesla", "driving")).toEqual(["speed", "power", "outsideTemp"]);
    expect(figuresFor("tesla", "charging")).toEqual(["chargerPower", "timeToFull", "energyAdded"]);
  });

  it("fills a Volvo's figures with what it reports instead of dashes", () => {
    expect(figuresFor("volvo", "parked")).toEqual(["odometer", "chargeLimit", "service"]);
    expect(figuresFor("volvo", "driving")).toEqual(["odometer", "chargeLimit", "service"]);
    expect(figuresFor("volvo", "charging")).toEqual(["chargerPower", "timeToFull", "energyAdded"]);
  });

  it("treats a car with no provider as the Tesla it was before Volvo", () => {
    expect(figuresFor(undefined, "parked")).toEqual(figuresFor("tesla", "parked"));
    expect(capabilitiesOf(null)).toBe(CAPABILITIES.tesla);
  });

  it("gives every provider three figures in every mode", () => {
    for (const provider of Object.keys(CAPABILITIES)) {
      for (const mode of Object.keys(FIGURE_PRIORITY) as (keyof typeof FIGURE_PRIORITY)[]) {
        expect(figuresFor(provider, mode)).toHaveLength(FIGURE_COUNT);
      }
    }
  });
});

describe("cardMode", () => {
  it("parks every state that is neither charging nor driving", () => {
    expect(cardMode("charging")).toBe("charging");
    expect(cardMode("driving")).toBe("driving");
    for (const state of ["online", "asleep", "offline", "falling_asleep", "updating", "unknown", undefined]) {
      expect(cardMode(state)).toBe("parked");
    }
  });
});

describe("commands and features", () => {
  it("lets a Tesla be woken, put to sleep and sent a destination, and a Volvo none of them", () => {
    for (const command of ["wake", "sleep", "navigate"] as const) {
      expect(canDo("tesla", command)).toBe(true);
      expect(canDo("volvo", command)).toBe(false);
    }
  });

  it("offers free supercharging only where there is a Supercharger account to have it on", () => {
    expect(hasFeature("tesla", "freeSupercharging")).toBe(true);
    expect(hasFeature("volvo", "freeSupercharging")).toBe(false);
  });
});
