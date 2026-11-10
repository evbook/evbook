import { describe, expect, it } from "bun:test";
import { rangeFromStored, sameRange } from "./rangeStore";

/**
 * The range outlives the page it was picked on, so these cover what a stored record
 * is allowed to mean when it is read back: on another page, and on another day.
 *
 * `rangeFromStored` takes the raw string rather than reading storage itself, both so
 * the rules can be tested here — the suite runs in workerd, which has no
 * `localStorage` — and because the value really is arbitrary text from the browser.
 */

const TODAY = "2026-07-23";
const stored = (record: unknown) => JSON.stringify(record);

describe("restoring a remembered range", () => {
  it("gives back what was saved today", () => {
    const raw = stored({ day: TODAY, preset: "1w", from: "2026-07-13", to: "" });
    expect(rangeFromStored(raw, TODAY, true)).toEqual({ preset: "1w", from: "2026-07-13", to: "" });
  });

  it("keeps the preset but not the pinned window once the day has rolled over", () => {
    // Yesterday's "the week before this one" is not this morning's answer to "1W";
    // the preset is the preference, the pin was a place you had stepped to.
    const raw = stored({ day: "2026-07-22", preset: "1w", from: "2026-07-13", to: "" });
    expect(rangeFromStored(raw, TODAY, true)).toEqual({ preset: "1w", from: "", to: "" });
  });

  it("drops a stale custom range entirely rather than leaving it dateless", () => {
    // Its dates are the whole selection, so a custom range without them would open
    // the page on "… – …" with nothing to fetch.
    const raw = stored({ day: "2026-07-22", preset: "custom", from: "2026-06-01", to: "2026-06-30" });
    expect(rangeFromStored(raw, TODAY, true)).toBeNull();
  });

  it("keeps a custom range picked today, dates and all", () => {
    const raw = stored({ day: TODAY, preset: "custom", from: "2026-06-01", to: "2026-06-30" });
    expect(rangeFromStored(raw, TODAY, true)).toEqual({ preset: "custom", from: "2026-06-01", to: "2026-06-30" });
  });

  it("withholds all time from a page that cannot show it", () => {
    const raw = stored({ day: TODAY, preset: "all", from: "", to: "" });
    expect(rangeFromStored(raw, TODAY, true)).toEqual({ preset: "all", from: "", to: "" });
    // The timeline page opens on its own default instead, and leaves the record be
    // so the list pages still find it.
    expect(rangeFromStored(raw, TODAY, false)).toBeNull();
  });

  it("opens on the page default when there is nothing stored", () => {
    expect(rangeFromStored(null, TODAY, true)).toBeNull();
    expect(rangeFromStored("", TODAY, true)).toBeNull();
  });

  it("ignores anything it cannot read, rather than throwing on the way in", () => {
    for (const raw of ["not json", "null", '"1w"', "[]", "{}", stored({ day: TODAY, preset: "fortnight" })]) {
      expect(rangeFromStored(raw, TODAY, true)).toBeNull();
    }
  });

  it("treats missing dates as unpinned", () => {
    const raw = stored({ day: TODAY, preset: "1m" });
    expect(rangeFromStored(raw, TODAY, true)).toEqual({ preset: "1m", from: "", to: "" });
  });
});

describe("noticing that the range changed", () => {
  const week = { preset: "1w" as const, from: "", to: "" };

  it("is the same range only when preset and both dates match", () => {
    expect(sameRange(week, { ...week })).toBe(true);
    expect(sameRange(week, { ...week, preset: "1m" })).toBe(false);
    // Stepping to another week changes the range even though the preset holds.
    expect(sameRange(week, { ...week, from: "2026-07-13" })).toBe(false);
    expect(sameRange(week, { ...week, to: "2026-07-19" })).toBe(false);
  });
});
