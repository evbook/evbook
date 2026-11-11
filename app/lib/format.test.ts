import { describe, expect, it } from "bun:test";
import {
  cost,
  dateTimeSpan,
  dayAndTime,
  durationRangeText,
  happenedBetween,
  money,
  rate,
  sumKnown,
  timeSpan,
  zoneLabel,
} from "./format";
import { duration } from "./units";

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

describe("zoneLabel", () => {
  const JAN = Date.UTC(2026, 0, 15);
  const JUL = Date.UTC(2026, 6, 15);

  it("says UTC as UTC", () => {
    expect(zoneLabel("UTC", JAN)).toBe("UTC");
  });

  it("names the city and the offset", () => {
    expect(zoneLabel("Europe/Moscow", JAN)).toBe("Moscow, GMT+3");
    expect(zoneLabel("America/New_York", JUL)).toMatch(/^New York, (EDT|GMT-4)$/);
  });

  it("follows daylight saving through the year", () => {
    expect(zoneLabel("Europe/London", JAN)).toBe("London, GMT");
    expect(zoneLabel("Europe/London", JUL)).toBe("London, BST");
  });

  it("hands back a zone the runtime does not know rather than throwing", () => {
    expect(zoneLabel("Mars/Olympus_Mons", JAN)).toBe("Mars/Olympus_Mons");
  });
});

describe("cost", () => {
  it("is a dash when unknown and Free when exactly nothing", () => {
    expect(cost(null, "EUR")).toBe("–");
    expect(cost(undefined, "EUR")).toBe("–");
    expect(cost(0, "EUR")).toBe("Free");
    expect(cost(0, "EUR", null)).toBe("Free");
  });

  it("shows a range when the top differs from the bottom", () => {
    const text = cost(524, "EUR", 579);
    expect(text).toContain("5.24");
    expect(text).toContain("5.79");
    expect(text).toContain(" – ");
    expect(cost(524, "EUR", 524)).not.toContain(" – ");
  });
});

describe("sumKnown", () => {
  it("adds what is known and stays unknown when nothing is", () => {
    expect(sumKnown([1, null, 2])).toBe(3);
    expect(sumKnown([null, undefined])).toBeNull();
    expect(sumKnown([0, null])).toBe(0);
  });
});

describe("bounded times", () => {
  const tz = "UTC";
  const at = Date.UTC(2026, 10, 10, 7, 1);
  const wide = { after: Date.UTC(2026, 10, 10, 6, 55), before: at };
  const tight = { after: Date.UTC(2026, 10, 10, 6, 59), before: at };

  it("shows a span as a range and a tight one as one time", () => {
    expect(timeSpan(at, wide, tz)).toMatch(/06:55\D+07:01/);
    expect(timeSpan(at, tight, tz)).not.toMatch(/06:59/);
    expect(timeSpan(at, null, tz)).toMatch(/07:01/);
    expect(dateTimeSpan(at, wide, tz)).toMatch(/06:55\D+07:01/);
  });

  it("says when an event nobody saw happened, without a duration", () => {
    const gap = { after: Date.UTC(2026, 10, 10, 12, 0), before: Date.UTC(2026, 10, 10, 13, 0) };
    // The clock format is the runtime locale's; the words are this module's.
    expect(happenedBetween(gap, tz)).toMatch(/^Happened between 12:00\D* and (13|01):00\D*$/);
    const overnight = { after: Date.UTC(2026, 10, 9, 20, 42), before: Date.UTC(2026, 10, 10, 7, 9) };
    expect(happenedBetween(overnight, tz)).toMatch(/^Happened between .*(20|08):42.* and .*07:09/);
  });

  it("shares the unit across a duration range", () => {
    expect(durationRangeText({ min: 38, max: 45 }, duration)).toBe("38–45 min");
    expect(durationRangeText({ min: 50, max: 75 }, duration)).toBe("50 min – 1 h 15 min");
  });
});
