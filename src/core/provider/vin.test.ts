import { describe, expect, it } from "bun:test";
import { normalizeVin } from "./vin";

describe("normalizeVin", () => {
  it("upper-cases and trims a VIN, and refuses anything that is not one", () => {
    expect(normalizeVin(" tmbjc7ny0sf000001 ")).toBe("TMBJC7NY0SF000001");
    expect(normalizeVin("TMBJC7NY0SF00000")).toBeNull();
    // O, I and Q are never in a VIN.
    expect(normalizeVin("TMBJC7NY0SF00000O")).toBeNull();
    expect(normalizeVin("KMHKM81CPNU00000/")).toBeNull();
  });
});
