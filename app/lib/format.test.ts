import { describe, expect, it } from "vitest";
import { dayAndTime, money, rate } from "./format";

/**
 * The money formatters, which are the whole of what the currency setting does: the
 * database stores bare minor units, so these are the only place a cost acquires a
 * currency at all.
 *
 * Assertions look for the symbol and the digits rather than an exact string. The
 * runtime's locale decides where the symbol sits and which space or separator joins
 * it to the number, and pinning that down would be testing ICU, not this module.
 */

describe("money", () => {
  it("shows two decimals in the currency it is given", () => {
    expect(money(1234, "EUR")).toContain("€");
    expect(money(1234, "EUR")).toContain("12.34");
    expect(money(1234, "USD")).toContain("$");
    expect(money(1234, "USD")).toContain("12.34");
  });

  it("keeps two decimals for a currency that normally has none", () => {
    // Yen is quoted whole, but a cost recorded in minor units still has them, and
    // dropping the fraction here would silently round every figure on the page.
    expect(money(1234, "JPY")).toContain("12.34");
  });

  it("is a dash when there is no cost, not a zero", () => {
    expect(money(null, "EUR")).toBe("–");
    expect(money(undefined, "EUR")).toBe("–");
    expect(money(0, "EUR")).toContain("0.00");
  });
});

describe("rate", () => {
  it("takes minor units per unit and shows three decimals", () => {
    // 27.4 cents per kWh: two decimals would round it onto 27 and 28 alike.
    expect(rate(27.42, "EUR")).toContain("0.274");
  });

  it("survives a division that had nothing to divide by", () => {
    // Callers hand over cost/energy directly, and a session with a cost and no
    // energy makes that Infinity — which Intl would print as "∞".
    expect(rate(500 / 0, "EUR")).toBe("–");
    expect(rate(Number.NaN, "EUR")).toBe("–");
    expect(rate(null, "EUR")).toBe("–");
  });
});

describe("dayAndTime", () => {
  // Noon on 2 Sept 2026 in Berlin (CEST, UTC+2).
  const now = Date.UTC(2026, 8, 2, 10, 0);

  it("says today for the account's own calendar day", () => {
    expect(dayAndTime(Date.UTC(2026, 8, 2, 6, 12), "Europe/Berlin", now)).toMatch(/^Today, /);
  });

  it("says yesterday for the day before", () => {
    expect(dayAndTime(Date.UTC(2026, 8, 1, 15, 41), "Europe/Berlin", now)).toMatch(/^Yesterday, /);
  });

  it("counts days in the account's time zone, not UTC's", () => {
    // 23:30 UTC on the 1st is already 01:30 on the 2nd in Berlin.
    expect(dayAndTime(Date.UTC(2026, 8, 1, 23, 30), "Europe/Berlin", now)).toMatch(/^Today, /);
  });

  it("gives the date once it is further back", () => {
    const text = dayAndTime(Date.UTC(2026, 7, 28, 10, 0), "Europe/Berlin", now);
    expect(text).not.toMatch(/Today|Yesterday/);
    expect(text).toContain("28");
  });

  it("is a dash when there is no time", () => {
    expect(dayAndTime(null, "Europe/Berlin", now)).toBe("–");
  });
});
