import { describe, expect, it } from "bun:test";
import {
  CAPABILITIES,
  canDo,
  capabilitiesOf,
  cardMode,
  FIGURE_COUNT,
  FIGURE_PRIORITY,
  figuresFor,
  figuresOf,
  hasFeature,
  NO_CAPABILITIES,
  type Capabilities,
  type CardMode,
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

  it("gives a Škoda two figures while parked or driving, since it has no service schedule", () => {
    expect(figuresFor("skoda", "parked")).toEqual(["odometer", "chargeLimit"]);
    expect(figuresFor("skoda", "driving")).toEqual(["odometer", "chargeLimit"]);
    expect(figuresFor("skoda", "charging")).toEqual(["chargerPower", "timeToFull", "energyAdded"]);
  });

  it("gives a Hyundai, Kia or Genesis what Pleos reports, and no energy it cannot measure", () => {
    expect(figuresFor("pleos", "parked")).toEqual(["odometer", "chargeLimit"]);
    expect(figuresFor("pleos", "driving")).toEqual(["odometer", "chargeLimit"]);
    expect(figuresFor("pleos", "charging")).toEqual(["timeToFull", "chargeLimit", "odometer"]);
  });

  it("never leads with more than three, or with a reading the provider does not declare", () => {
    for (const provider of Object.keys(CAPABILITIES)) {
      for (const mode of Object.keys(FIGURE_PRIORITY) as CardMode[]) {
        const figures = figuresFor(provider, mode);
        expect(figures.length).toBeLessThanOrEqual(FIGURE_COUNT);
        for (const reading of figures) expect(capabilitiesOf(provider).readings).toContain(reading);
      }
    }
  });
});

describe("figuresOf", () => {
  // Several planned providers report little: an odometer and a time to full is
  // all a Toyota gives, an odometer all an import-only feed has.
  it("gives a sparse declaration fewer figures rather than dashes", () => {
    const sparse: Capabilities = { readings: ["odometer", "timeToFull"], commands: [], features: [] };
    expect(figuresOf(sparse, "parked")).toEqual(["odometer"]);
    expect(figuresOf(sparse, "driving")).toEqual(["odometer"]);
    expect(figuresOf(sparse, "charging")).toEqual(["timeToFull", "odometer"]);
    expect(figuresOf(NO_CAPABILITIES, "parked")).toEqual([]);
  });

  it("follows the priority order, not the order of the declaration", () => {
    const shuffled: Capabilities = {
      readings: ["service", "odometer", "outsideTemp", "chargeLimit"],
      commands: [],
      features: [],
    };
    expect(figuresOf(shuffled, "parked")).toEqual(["outsideTemp", "odometer", "chargeLimit"]);
  });
});

describe("capabilitiesOf", () => {
  it("gives an unknown or missing provider nothing, never Tesla's commands", () => {
    for (const provider of ["bmw", "toString", "", null, undefined]) {
      expect(capabilitiesOf(provider)).toBe(NO_CAPABILITIES);
      expect(canDo(provider, "wake")).toBe(false);
      expect(canDo(provider, "sleep")).toBe(false);
      expect(hasFeature(provider, "freeSupercharging")).toBe(false);
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
      expect(canDo("skoda", command)).toBe(false);
      expect(canDo("pleos", command)).toBe(false);
    }
  });

  it("offers free supercharging only where there is a Supercharger account to have it on", () => {
    expect(hasFeature("tesla", "freeSupercharging")).toBe(true);
    expect(hasFeature("volvo", "freeSupercharging")).toBe(false);
  });
});
