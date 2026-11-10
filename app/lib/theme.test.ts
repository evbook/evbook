import { describe, expect, it } from "bun:test";
import { resolveScheme, themeFromStored } from "./theme";

/**
 * The theme outlives the page it was picked on, so these cover what a stored value
 * is allowed to mean when it is read back, and what each choice comes to. The suite
 * runs in workerd, which has no `localStorage` or `matchMedia`, so both functions
 * take their inputs rather than reading the browser.
 */

describe("restoring a picked theme", () => {
  it("gives back light or dark when one was picked", () => {
    expect(themeFromStored("light")).toBe("light");
    expect(themeFromStored("dark")).toBe("dark");
  });

  it("follows the OS when nothing usable is stored", () => {
    expect(themeFromStored(null)).toBe("system");
    expect(themeFromStored("")).toBe("system");
    // An older shape, or something else's key: never a reason to pin a scheme.
    expect(themeFromStored('{"theme":"dark"}')).toBe("system");
  });
});

describe("the scheme a choice comes to", () => {
  it("follows the OS when the reader has not picked", () => {
    expect(resolveScheme("system", true)).toBe("dark");
    expect(resolveScheme("system", false)).toBe("light");
  });

  it("holds a picked scheme whatever the OS is doing", () => {
    expect(resolveScheme("light", true)).toBe("light");
    expect(resolveScheme("dark", false)).toBe("dark");
  });
});
