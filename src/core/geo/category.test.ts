import { describe, expect, it } from "bun:test";
import { guessCategory } from "./category";

describe("place category guessing", () => {
  it("maps a self-evident OSM type", () => {
    expect(guessCategory(JSON.stringify({ category: "amenity", type: "school" }))).toBe("school");
    expect(guessCategory(JSON.stringify({ category: "shop", type: "supermarket" }))).toBe("supermarket");
    expect(guessCategory(JSON.stringify({ category: "amenity", type: "charging_station" }))).toBe("charging");
  });

  it("treats every office subtype as an office", () => {
    expect(guessCategory(JSON.stringify({ category: "office", type: "it" }))).toBe("office");
    expect(guessCategory(JSON.stringify({ category: "office", type: "company" }))).toBe("office");
  });

  it("reads the older json format, which says class instead of category", () => {
    expect(guessCategory(JSON.stringify({ class: "office", type: "lawyer" }))).toBe("office");
  });

  it("refuses to guess from an ambiguous type", () => {
    // A residential building could be anyone's; a road is nobody's destination.
    expect(guessCategory(JSON.stringify({ category: "building", type: "residential" }))).toBeNull();
    expect(guessCategory(JSON.stringify({ category: "highway", type: "residential" }))).toBeNull();
    expect(guessCategory(JSON.stringify({ category: "amenity", type: "parking" }))).toBeNull();
  });

  it("returns null for missing, empty or malformed raw JSON", () => {
    expect(guessCategory(null)).toBeNull();
    expect(guessCategory("")).toBeNull();
    expect(guessCategory("not json")).toBeNull();
    expect(guessCategory('"a string"')).toBeNull();
    expect(guessCategory("{}")).toBeNull();
  });
});
