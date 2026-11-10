import { describe, expect, it } from "bun:test";
import { carFromStored } from "./carStore";

/**
 * The car outlives the page it was picked on, so these cover what a stored record is
 * allowed to mean when it is read back — in particular that "every car" is a choice
 * that can be remembered, and not the same as never having picked.
 *
 * `carFromStored` takes the raw string rather than reading storage itself, both so the
 * rules can be tested here — the suite runs in workerd, which has no `localStorage` —
 * and because the value really is arbitrary text from the browser.
 */

const stored = (record: unknown) => JSON.stringify(record);

describe("restoring a remembered car", () => {
  it("gives back the car that was saved", () => {
    expect(carFromStored(stored({ carId: "7" }))).toBe("7");
  });

  it("remembers every car as a choice of its own", () => {
    // Distinct from nothing stored: having cleared the filter on the drives list, the
    // charges list should open on every car too, rather than on whatever was picked
    // before that.
    expect(carFromStored(stored({ carId: "" }))).toBe("");
  });

  it("opens on the page default when there is nothing stored", () => {
    expect(carFromStored(null)).toBeNull();
    expect(carFromStored("")).toBeNull();
  });

  it("ignores anything it cannot read, rather than throwing on the way in", () => {
    for (const raw of ["not json", "null", '"7"', "[]", "{}", stored({ carId: 7 })]) {
      expect(carFromStored(raw)).toBeNull();
    }
  });
});
