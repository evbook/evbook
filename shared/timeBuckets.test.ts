import { describe, expect, it } from "vitest";
import { buildBuckets, shiftWindow, statsWindow, windowFor, zonedTimeToUtc } from "./timeBuckets";

/**
 * Period bucketing is the highest-risk piece of the analytics port: SQLite has
 * no time-zone database, so these boundaries are computed in TypeScript and
 * must survive DST transitions.
 */

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

function hoursBetween(from: number, to: number): number {
  return (to - from) / 3_600_000;
}

describe("zonedTimeToUtc", () => {
  it("resolves winter time in Berlin (UTC+1)", () => {
    const at = zonedTimeToUtc(BERLIN, 2026, 1, 15, 0);
    expect(new Date(at).toISOString()).toBe("2026-01-14T23:00:00.000Z");
  });

  it("resolves summer time in Berlin (UTC+2)", () => {
    const at = zonedTimeToUtc(BERLIN, 2026, 7, 15, 0);
    expect(new Date(at).toISOString()).toBe("2026-07-14T22:00:00.000Z");
  });

  it("resolves New York offsets", () => {
    expect(new Date(zonedTimeToUtc(NEW_YORK, 2026, 1, 15, 0)).toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(new Date(zonedTimeToUtc(NEW_YORK, 2026, 7, 15, 0)).toISOString()).toBe("2026-07-15T04:00:00.000Z");
  });

  it("treats UTC as a no-op", () => {
    expect(new Date(zonedTimeToUtc("UTC", 2026, 3, 10, 0)).toISOString()).toBe("2026-03-10T00:00:00.000Z");
  });
});

describe("daily buckets across DST", () => {
  it("produces a 23-hour day when Berlin springs forward", () => {
    // Berlin loses an hour on 29 March 2026.
    const from = zonedTimeToUtc(BERLIN, 2026, 3, 28, 0);
    const to = zonedTimeToUtc(BERLIN, 2026, 3, 31, 0);
    const buckets = buildBuckets(from, to, "day", BERLIN);
    const spring = buckets.find((b) => b.key === "2026-03-29");
    expect(spring).toBeDefined();
    expect(hoursBetween(spring!.from, spring!.to)).toBe(23);
  });

  it("produces a 25-hour day when Berlin falls back", () => {
    // Berlin gains an hour on 25 October 2026.
    const from = zonedTimeToUtc(BERLIN, 2026, 10, 24, 0);
    const to = zonedTimeToUtc(BERLIN, 2026, 10, 27, 0);
    const buckets = buildBuckets(from, to, "day", BERLIN);
    const autumn = buckets.find((b) => b.key === "2026-10-25");
    expect(autumn).toBeDefined();
    expect(hoursBetween(autumn!.from, autumn!.to)).toBe(25);
  });

  it("keeps buckets contiguous with no gaps or overlaps", () => {
    const from = zonedTimeToUtc(BERLIN, 2026, 3, 26, 0);
    const to = zonedTimeToUtc(BERLIN, 2026, 4, 2, 0);
    const buckets = buildBuckets(from, to, "day", BERLIN);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.from).toBe(buckets[i - 1]!.to);
    }
  });

  it("labels days by their local date, not the UTC date", () => {
    // 23:30 local on 14 July in Berlin is still 21:30 UTC the same day.
    const at = zonedTimeToUtc(BERLIN, 2026, 7, 14, 23);
    const buckets = buildBuckets(at, at, "day", BERLIN);
    expect(buckets[0]!.key).toBe("2026-07-14");
  });

  it("assigns an instant just after local midnight to the new day", () => {
    const at = zonedTimeToUtc(BERLIN, 2026, 7, 15, 0) + 60_000;
    const buckets = buildBuckets(at, at, "day", BERLIN);
    expect(buckets[0]!.key).toBe("2026-07-15");
  });
});

describe("month and year buckets", () => {
  it("aligns months to local midnight and rolls over the year", () => {
    const from = zonedTimeToUtc(BERLIN, 2025, 11, 5, 0);
    const to = zonedTimeToUtc(BERLIN, 2026, 2, 5, 0);
    const buckets = buildBuckets(from, to, "month", BERLIN);
    expect(buckets.map((b) => b.key)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    // November starts in winter time, so 23:00 UTC the previous day.
    expect(new Date(buckets[0]!.from).toISOString()).toBe("2025-10-31T23:00:00.000Z");
  });

  it("spans a month across a DST change correctly", () => {
    const from = zonedTimeToUtc(BERLIN, 2026, 3, 1, 0);
    const to = zonedTimeToUtc(BERLIN, 2026, 3, 31, 0);
    const buckets = buildBuckets(from, to, "month", BERLIN);
    expect(buckets).toHaveLength(1);
    // March has 31 days but only 743 hours in Berlin, thanks to the lost hour.
    expect(hoursBetween(buckets[0]!.from, buckets[0]!.to)).toBe(743);
  });

  it("builds year buckets", () => {
    const from = zonedTimeToUtc(BERLIN, 2024, 6, 1, 0);
    const to = zonedTimeToUtc(BERLIN, 2026, 6, 1, 0);
    const buckets = buildBuckets(from, to, "year", BERLIN);
    expect(buckets.map((b) => b.key)).toEqual(["2024", "2025", "2026"]);
  });

  it("builds ISO weeks starting on Monday", () => {
    // 15 July 2026 is a Wednesday; its week starts Monday the 13th.
    const at = zonedTimeToUtc(BERLIN, 2026, 7, 15, 12);
    const buckets = buildBuckets(at, at, "week", BERLIN);
    expect(buckets).toHaveLength(1);
    expect(hoursBetween(buckets[0]!.from, buckets[0]!.to)).toBe(168);
    expect(new Date(buckets[0]!.from).toISOString()).toBe("2026-07-12T22:00:00.000Z");
  });
});

describe("edge cases", () => {
  it("returns nothing when the range is inverted", () => {
    expect(buildBuckets(2000, 1000, "day", "UTC")).toEqual([]);
  });

  it("returns a single bucket for an instant", () => {
    const at = Date.UTC(2026, 5, 1, 12);
    expect(buildBuckets(at, at, "month", "UTC")).toHaveLength(1);
  });

  it("caps how many buckets it will build", () => {
    const from = Date.UTC(2000, 0, 1);
    const to = Date.UTC(2026, 0, 1);
    expect(buildBuckets(from, to, "day", "UTC", 50)).toHaveLength(50);
  });

  it("handles a half-hour offset zone", () => {
    const buckets = buildBuckets(
      zonedTimeToUtc("Asia/Kolkata", 2026, 7, 15, 0),
      zonedTimeToUtc("Asia/Kolkata", 2026, 7, 16, 0),
      "day",
      "Asia/Kolkata",
    );
    expect(buckets[0]!.key).toBe("2026-07-15");
    expect(new Date(buckets[0]!.from).toISOString()).toBe("2026-07-14T18:30:00.000Z");
  });
});

describe("the window a preset resolves to", () => {
  it("snaps a month to the whole calendar month", () => {
    const mid = zonedTimeToUtc(BERLIN, 2026, 7, 23, 14);
    const window = windowFor(mid, "month", BERLIN);
    expect(new Date(window.from).toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(new Date(window.to).toISOString()).toBe("2026-07-31T22:00:00.000Z");
  });

  it("gives every instant in a month the identical window", () => {
    const first = windowFor(zonedTimeToUtc(BERLIN, 2026, 7, 1, 0), "month", BERLIN);
    const last = windowFor(zonedTimeToUtc(BERLIN, 2026, 7, 31, 23), "month", BERLIN);
    expect(last).toEqual(first);
  });

  it("starts the week on Monday by default", () => {
    // 23 July 2026 is a Thursday.
    const window = windowFor(zonedTimeToUtc(BERLIN, 2026, 7, 23, 14), "week", BERLIN);
    expect(new Date(window.from).toISOString()).toBe("2026-07-19T22:00:00.000Z");
    expect(hoursBetween(window.from, window.to)).toBe(168);
  });

  it("starts the week on Sunday when the locale does", () => {
    const window = windowFor(zonedTimeToUtc(NEW_YORK, 2026, 7, 23, 14), "week", NEW_YORK, 7);
    // The Sunday before Thursday the 23rd is the 19th.
    expect(new Date(window.from).toISOString()).toBe("2026-07-19T04:00:00.000Z");
    expect(hoursBetween(window.from, window.to)).toBe(168);
  });

  it("starts the week on Saturday when the locale does", () => {
    const window = windowFor(zonedTimeToUtc("UTC", 2026, 7, 23, 14), "week", "UTC", 6);
    expect(new Date(window.from).toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });
});

describe("stepping a window", () => {
  it("steps back a whole calendar month, whatever its length", () => {
    const july = zonedTimeToUtc("UTC", 2026, 7, 15, 12);
    const june = shiftWindow(july, "month", -1, "UTC");
    expect(new Date(june.from).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(new Date(june.to).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    const february = shiftWindow(zonedTimeToUtc("UTC", 2026, 3, 10, 12), "month", -1, "UTC");
    expect(hoursBetween(february.from, february.to)).toBe(28 * 24);
  });

  it("crosses the year boundary in both directions", () => {
    const back = shiftWindow(zonedTimeToUtc("UTC", 2026, 1, 15, 12), "month", -1, "UTC");
    expect(new Date(back.from).toISOString()).toBe("2025-12-01T00:00:00.000Z");
    const forward = shiftWindow(zonedTimeToUtc("UTC", 2026, 12, 15, 12), "month", 1, "UTC");
    expect(new Date(forward.from).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("steps a week across a month boundary", () => {
    // Monday 27 July 2026, stepped forward once, lands in August.
    const next = shiftWindow(zonedTimeToUtc("UTC", 2026, 7, 27, 12), "week", 1, "UTC");
    expect(new Date(next.from).toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(hoursBetween(next.from, next.to)).toBe(168);
  });

  it("keeps a day a whole day across the spring DST jump", () => {
    // Berlin loses an hour on 29 March 2026.
    const day = shiftWindow(zonedTimeToUtc(BERLIN, 2026, 3, 30, 12), "day", -1, BERLIN);
    expect(hoursBetween(day.from, day.to)).toBe(23);
    expect(new Date(day.from).toISOString()).toBe("2026-03-28T23:00:00.000Z");
  });

  it("keeps a week 167 hours long when it contains the spring jump", () => {
    // Berlin springs forward on Sunday 29 March 2026, which falls in the week
    // beginning Monday the 23rd — two steps back from Monday 6 April.
    const week = shiftWindow(zonedTimeToUtc(BERLIN, 2026, 4, 6, 12), "week", -2, BERLIN);
    expect(new Date(week.from).toISOString()).toBe("2026-03-22T23:00:00.000Z");
    expect(hoursBetween(week.from, week.to)).toBe(167);
  });

  it("is reversible", () => {
    const at = zonedTimeToUtc(BERLIN, 2026, 7, 23, 14);
    const here = windowFor(at, "week", BERLIN);
    const roundTrip = shiftWindow(shiftWindow(at, "week", -3, BERLIN).from, "week", 3, BERLIN);
    expect(roundTrip).toEqual(here);
  });

  it("steps a year", () => {
    const year = shiftWindow(zonedTimeToUtc("UTC", 2026, 7, 15, 12), "year", -1, "UTC");
    expect(new Date(year.from).toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(new Date(year.to).toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("steps a Sunday-start week without drifting off Sunday", () => {
    const week = shiftWindow(zonedTimeToUtc("UTC", 2026, 7, 23, 12), "week", -2, "UTC", 7);
    expect(new Date(week.from).toISOString()).toBe("2026-07-05T00:00:00.000Z");
    expect(hoursBetween(week.from, week.to)).toBe(168);
  });
});

describe("bucketing by week when weeks do not start on Monday", () => {
  it("aligns the buckets to the given start day", () => {
    // 15 July 2026 is a Wednesday; a Sunday-start week began on the 12th.
    const at = zonedTimeToUtc(BERLIN, 2026, 7, 15, 12);
    const buckets = buildBuckets(at, at, "week", BERLIN, 400, 7);
    expect(buckets).toHaveLength(1);
    expect(new Date(buckets[0]!.from).toISOString()).toBe("2026-07-11T22:00:00.000Z");
    expect(hoursBetween(buckets[0]!.from, buckets[0]!.to)).toBe(168);
  });

  it("names the bucket by its start date rather than an ISO week number", () => {
    const at = zonedTimeToUtc(BERLIN, 2026, 7, 15, 12);
    const iso = buildBuckets(at, at, "week", BERLIN)[0]!;
    const sunday = buildBuckets(at, at, "week", BERLIN, 400, 7)[0]!;
    expect(iso.key).toBe("2026-W29");
    expect(iso.label).toBe("2026-W29");
    // "2026-W29" would be wrong for a week that runs Sunday to Saturday.
    expect(sunday.key).toBe("W2026-07-12");
    expect(sunday.label).toBe("12 Jul 2026");
  });

  it("keeps consecutive buckets exactly a week apart", () => {
    const from = zonedTimeToUtc(BERLIN, 2026, 6, 1, 12);
    const to = zonedTimeToUtc(BERLIN, 2026, 8, 31, 12);
    const buckets = buildBuckets(from, to, "week", BERLIN, 400, 6);
    expect(buckets.length).toBeGreaterThan(10);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.from).toBe(buckets[i - 1]!.to);
    }
  });
});

describe("the window the statistics page looks back over", () => {
  const NOW = Date.UTC(2026, 6, 15, 12);
  const days = (period: Parameters<typeof statsWindow>[0]) => (NOW - statsWindow(period, NOW).from) / 86_400_000;

  it("widens with the grouping", () => {
    expect(days("day")).toBe(30);
    expect(days("week")).toBe(365);
    expect(days("month")).toBe(730);
    expect(days("year")).toBe(3650);
  });

  it("ends at the instant it is asked about", () => {
    // The page sends these bounds to every card on it, and a `to` in the past
    // would drop today's drives out of the roll-ups beside the table.
    for (const period of ["day", "week", "month", "year"] as const) {
      expect(statsWindow(period, NOW).to).toBe(NOW);
    }
  });
});
