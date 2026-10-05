import { describe, expect, it } from "vitest";
import { zonedTimeToUtc } from "@shared/timeBuckets";
import {
  PRESETS,
  emptyFilters,
  fromUrlParams,
  isAtPresent,
  rangeLabel,
  resolveWindow,
  selectedWindow,
  steppedFrom,
  toQuery,
  toUrlParams,
  type FilterState,
  type PresetKey,
  type RangeContext,
  type RangeParamMap,
} from "./filters";

/**
 * Every preset resolves to one calendar period in the zone from settings, and two
 * things follow from that. The window is a pair of exact boundary instants, so the
 * arrows can walk it a period at a time and a bucketed rollup can serve it. And its
 * boundaries come from the calendar rather than the clock, so the react-query keys
 * built from it hold still — the presets used to be sliding windows recomputed from
 * `Date.now()`, which changed the key on every render and left the lists refetching
 * in a loop. The one part that still tracks the clock is the end of a window that
 * has not closed yet, which is clamped to now so nothing asks for the future.
 */

const BERLIN = "Europe/Berlin";
const RANGE_PARAMS: RangeParamMap = { distance: { min: "minDistance", max: "maxDistance" } };
const STEPPABLE: PresetKey[] = PRESETS.map((p) => p.key);

/** Thursday 23 July 2026, 14:32 in Berlin. */
const NOW = zonedTimeToUtc(BERLIN, 2026, 7, 23, 14) + 32 * 60_000;

const ctx = (over: Partial<RangeContext> = {}): RangeContext => ({
  timeZone: BERLIN,
  firstDay: 1,
  now: NOW,
  ...over,
});

const withPreset = (preset: PresetKey, over: Partial<FilterState> = {}): FilterState => ({
  ...emptyFilters("date", ["distance"]),
  preset,
  ...over,
});

const iso = (at: number | undefined) => (at == null ? null : new Date(at).toISOString());

describe("resolving a preset into a window", () => {
  it.each(STEPPABLE)("gives %s the same window across a burst of renders", (preset) => {
    const state = withPreset(preset);
    // `useRangeContext` rounds the clock down to the minute before it gets here, so
    // this is what a handful of renders milliseconds apart actually pass in.
    const windows = [0, 1, 4, 9, 17, 250, 999].map(() => resolveWindow(state, ctx()));
    for (const window of windows) expect(window).toEqual(windows[0]);
  });

  it.each(STEPPABLE)("keeps %s stable in the query string too", (preset) => {
    const state = withPreset(preset);
    expect(toQuery(state, RANGE_PARAMS, 50, ctx())).toBe(toQuery(state, RANGE_PARAMS, 50, ctx()));
  });

  it.each(STEPPABLE)("does not move the start of %s as the minute turns", (preset) => {
    // The point of snapping: the boundaries come from the calendar, so the only
    // part that can move with the clock is the clamped end of an open window.
    const state = withPreset(preset);
    expect(selectedWindow(state, ctx({ now: NOW + 60_000 }))).toEqual(selectedWindow(state, ctx()));
    expect(resolveWindow(state, ctx({ now: NOW + 60_000 })).from).toBe(resolveWindow(state, ctx()).from);
  });

  it("snaps a day to midnight in the settings zone, not the browser's", () => {
    const window = selectedWindow(withPreset("1d"), ctx());
    expect(iso(window.from)).toBe("2026-07-22T22:00:00.000Z");
    expect(iso(window.to)).toBe("2026-07-23T22:00:00.000Z");
  });

  it("snaps a month to the whole month", () => {
    const window = selectedWindow(withPreset("1m"), ctx());
    expect(iso(window.from)).toBe("2026-06-30T22:00:00.000Z");
    expect(iso(window.to)).toBe("2026-07-31T22:00:00.000Z");
  });

  it("snaps a year to the whole year", () => {
    const window = selectedWindow(withPreset("1y"), ctx());
    expect(iso(window.from)).toBe("2025-12-31T23:00:00.000Z");
    expect(iso(window.to)).toBe("2026-12-31T23:00:00.000Z");
  });

  it("starts a week on the day the locale does", () => {
    // Thursday the 23rd sits in the week from Monday the 20th…
    expect(iso(resolveWindow(withPreset("1w"), ctx()).from)).toBe("2026-07-19T22:00:00.000Z");
    // …or the week from Sunday the 19th where weeks start on Sunday.
    expect(iso(resolveWindow(withPreset("1w"), ctx({ firstDay: 7 })).from)).toBe("2026-07-18T22:00:00.000Z");
  });

  it("bounds nothing for all time", () => {
    expect(resolveWindow(withPreset("all"), ctx())).toEqual({});
    expect(selectedWindow(withPreset("all"), ctx())).toEqual({});
  });

  it("ends the window exclusively, so adjacent windows cannot both claim midnight", () => {
    // Two windows that have both closed, so neither end is clamped to now.
    const may = resolveWindow(withPreset("1m", { from: "2026-05-10" }), ctx());
    const june = resolveWindow(withPreset("1m", { from: "2026-06-05" }), ctx());
    expect(may.to).toBe(june.from);
  });
});

describe("not asking for time that has not happened yet", () => {
  it.each(STEPPABLE)("clamps the end of the in-progress %s to the present", (preset) => {
    // The selection is the whole period; only what is fetched stops at the present.
    expect(selectedWindow(withPreset(preset), ctx()).to).toBeGreaterThan(NOW);
    const resolved = resolveWindow(withPreset(preset), ctx()).to!;
    expect(resolved).toBeLessThanOrEqual(NOW);
    expect(resolved).toBeGreaterThan(NOW - 3_600_000);
  });

  it("follows the clock at the resolution the window is drawn at", () => {
    // 14:32 in Berlin. A day tracks the minute, because that is the window you
    // watch live; wider ones step coarsely so the key stops moving every minute.
    const endOf = (preset: PresetKey) => resolveWindow(withPreset(preset), ctx()).to;
    expect(endOf("1d")).toBe(NOW); //           14:32, to the minute
    expect(endOf("1w")).toBe(NOW - 2 * 60_000); // 14:30, to five minutes
    expect(endOf("1m")).toBe(NOW - 2 * 60_000); // 14:30, to the quarter hour
    expect(endOf("1y")).toBe(NOW - 32 * 60_000); // 14:00, to the hour
  });

  it("holds a wide in-progress window still as the minute turns", () => {
    // This is what stopped the history page reloading itself once a minute.
    const year = withPreset("1y");
    expect(resolveWindow(year, ctx({ now: NOW + 60_000 }))).toEqual(resolveWindow(year, ctx()));

    const day = withPreset("1d");
    expect(resolveWindow(day, ctx({ now: NOW + 60_000 }))).not.toEqual(resolveWindow(day, ctx()));
  });

  it("uses the present itself in the first step of a new period", () => {
    // Ten past midnight on New Year's Day: rounding the end down to the hour
    // would land on the window's own start and resolve to nothing at all.
    const newYear = zonedTimeToUtc(BERLIN, 2027, 1, 1, 0);
    const window = resolveWindow(withPreset("1y"), ctx({ now: newYear + 10 * 60_000 }));
    expect(window.to).toBe(newYear + 10 * 60_000);
    expect(window.to!).toBeGreaterThan(window.from!);
  });

  it("leaves a window that has already closed alone", () => {
    const state = withPreset("1m", { from: "2026-06-01" });
    expect(resolveWindow(state, ctx())).toEqual(selectedWindow(state, ctx()));
  });

  it("keeps the start of the in-progress window untouched", () => {
    expect(resolveWindow(withPreset("1w"), ctx()).from).toBe(selectedWindow(withPreset("1w"), ctx()).from);
  });

  it("still holds the closed window's query string still as the minute turns", () => {
    const state = withPreset("1m", { from: "2026-06-01" });
    expect(toQuery(state, RANGE_PARAMS, 50, ctx({ now: NOW + 60_000 }))).toBe(
      toQuery(state, RANGE_PARAMS, 50, ctx()),
    );
  });
});

describe("custom ranges", () => {
  it("covers whole days at both ends", () => {
    const state = withPreset("custom", { from: "2026-06-01", to: "2026-06-30" });
    const window = resolveWindow(state, ctx());
    expect(iso(window.from)).toBe("2026-05-31T22:00:00.000Z");
    // Exclusive, so the last day is included in full.
    expect(iso(window.to)).toBe("2026-06-30T22:00:00.000Z");
  });

  it("covers the whole of a single day when both ends are the same date", () => {
    const window = resolveWindow(withPreset("custom", { from: "2026-06-01", to: "2026-06-01" }), ctx());
    expect((window.to ?? 0) - (window.from ?? 0)).toBe(86_400_000);
  });

  it("ignores a half-typed range rather than sending NaN", () => {
    const state = withPreset("custom", { from: "", to: "" });
    expect(resolveWindow(state, ctx())).toEqual({ from: undefined, to: undefined });
    expect(toQuery(state, RANGE_PARAMS, 50, ctx())).not.toContain("from=");
  });

  it("ignores a date that is not a real one", () => {
    expect(resolveWindow(withPreset("custom", { from: "2026-13-99", to: "" }), ctx()).from).toBeUndefined();
    expect(resolveWindow(withPreset("custom", { from: "not-a-date", to: "" }), ctx()).from).toBeUndefined();
  });
});

describe("stepping with the arrows", () => {
  it("steps a month back onto the first of the previous month", () => {
    const back = steppedFrom(withPreset("1m"), -1, ctx());
    expect(back).toBe("2026-06-01");
    expect(iso(resolveWindow(withPreset("1m", { from: back }), ctx()).from)).toBe("2026-05-31T22:00:00.000Z");
  });

  it("steps a week back a week, staying on the locale's start day", () => {
    expect(steppedFrom(withPreset("1w"), -1, ctx())).toBe("2026-07-13");
    expect(steppedFrom(withPreset("1w"), -1, ctx({ firstDay: 7 }))).toBe("2026-07-12");
  });

  it("walks back repeatedly without drifting", () => {
    let state = withPreset("1m");
    for (const expected of ["2026-06-01", "2026-05-01", "2026-04-01", "2026-03-01", "2026-02-01", "2026-01-01", "2025-12-01"]) {
      state = { ...state, from: steppedFrom(state, -1, ctx()) };
      expect(state.from).toBe(expected);
    }
  });

  it("returns to where it started", () => {
    const state = withPreset("1w");
    const back = { ...state, from: steppedFrom(state, -1, ctx()) };
    const forward = { ...back, from: steppedFrom(back, 1, ctx()) };
    expect(resolveWindow(forward, ctx())).toEqual(resolveWindow(state, ctx()));
  });

  it("keeps a day a whole day across a DST jump", () => {
    // Berlin springs forward on Sunday 29 March 2026.
    const state = withPreset("1d", { from: "2026-03-30" });
    const back = { ...state, from: steppedFrom(state, -1, ctx()) };
    expect(back.from).toBe("2026-03-29");
    const window = resolveWindow(back, ctx());
    expect((window.to ?? 0) - (window.from ?? 0)).toBe(23 * 3_600_000);
  });

  it("does not step all time or a custom range", () => {
    expect(steppedFrom(withPreset("all"), -1, ctx())).toBe("");
    const custom = withPreset("custom", { from: "2026-06-01", to: "2026-06-30" });
    expect(steppedFrom(custom, -1, ctx())).toBe("2026-06-01");
  });
});

describe("knowing when the window has caught up with the present", () => {
  it.each(STEPPABLE)("is at the present for an unpinned %s", (preset) => {
    expect(isAtPresent(withPreset(preset), ctx())).toBe(true);
  });

  it("is not at the present once stepped back", () => {
    expect(isAtPresent(withPreset("1m", { from: "2026-06-01" }), ctx())).toBe(false);
    expect(isAtPresent(withPreset("1w", { from: "2026-07-13" }), ctx())).toBe(false);
  });

  it("is at the present again one step forward from the window before this one", () => {
    const previous = withPreset("1w", { from: "2026-07-13" });
    const next = { ...previous, from: steppedFrom(previous, 1, ctx()) };
    expect(isAtPresent(next, ctx())).toBe(true);
  });

  it("treats the window containing now as the present even on its last day", () => {
    // 31 July is inside the July window, which still ends in the future.
    expect(isAtPresent(withPreset("1m", { from: "2026-07-31" }), ctx())).toBe(true);
  });
});

describe("the URL", () => {
  const parse = (search: string, defaultPreset: PresetKey = "all") =>
    fromUrlParams(new URLSearchParams(search), "date", ["distance"], defaultPreset);

  it("leaves the page's own default range out", () => {
    expect(toUrlParams(withPreset("all"), "date").get("range")).toBeNull();
    expect(toUrlParams(withPreset("1w"), "date", "1w").get("range")).toBeNull();
    expect(toUrlParams(withPreset("1m"), "date", "1w").get("range")).toBe("1m");
  });

  it("names the default range anyway while a remembered one is seeding the page", () => {
    // Trips defaults to 1Y. With "1d" remembered from another page, picking 1Y
    // there wrote a URL that said nothing about the range — and a silent URL is
    // what defers to the store, so the seed put 1D straight back and the button
    // looked dead. Naming it puts the choice where `useUrlFilters` reads it.
    const seeded = { nameDefaultRange: true };
    expect(toUrlParams(withPreset("1y"), "date", "1y", seeded).get("range")).toBe("1y");
    expect(toUrlParams(withPreset("all"), "date", "all", seeded).get("range")).toBe("all");
    // Still round-trips to the same window it was built from.
    expect(parse(toUrlParams(withPreset("1y"), "date", "1y", seeded).toString(), "1y").preset).toBe("1y");
  });

  it("leaves the car out when every car is wanted", () => {
    expect(toUrlParams(withPreset("all", { carId: "3" }), "date").get("car")).toBe("3");
    expect(toUrlParams(withPreset("all"), "date").get("car")).toBeNull();
  });

  it("names every car anyway while a remembered car is seeding the page", () => {
    // Same trap as the range above: clearing the car wrote a URL that said nothing
    // about it, and a silent URL defers to the store — so the remembered car came
    // straight back and the filter would not clear.
    const params = toUrlParams(withPreset("all"), "date", "all", { nameAllCars: true });
    expect(params.get("car")).toBe("all");
    // And reads back as every car rather than as a car whose id is "all".
    expect(parse(params.toString()).carId).toBe("");
    // A car that is actually picked names itself, seed or no seed.
    expect(toUrlParams(withPreset("all", { carId: "3" }), "date", "all", { nameAllCars: true }).get("car")).toBe("3");
  });

  it("keeps an unstepped preset evergreen by leaving the start out", () => {
    expect(toUrlParams(withPreset("1w"), "date").get("from")).toBeNull();
    expect(toUrlParams(withPreset("1w", { from: "2026-07-13" }), "date").get("from")).toBe("2026-07-13");
  });

  it("round-trips a stepped window", () => {
    const state = withPreset("1m", { from: "2026-06-01" });
    const parsed = parse(toUrlParams(state, "date").toString());
    expect(resolveWindow(parsed, ctx())).toEqual(resolveWindow(state, ctx()));
  });

  it("round-trips a custom range", () => {
    const state = withPreset("custom", { from: "2026-06-01", to: "2026-06-30" });
    const parsed = parse(toUrlParams(state, "date").toString());
    expect(parsed.preset).toBe("custom");
    expect(resolveWindow(parsed, ctx())).toEqual(resolveWindow(state, ctx()));
  });

  it("maps a retired preset to the nearest surviving one", () => {
    // Silently falling back to all time would widen an old bookmark from a month
    // of drives to every drive ever recorded.
    expect(parse("range=today").preset).toBe("1d");
    expect(parse("range=week").preset).toBe("1w");
    expect(parse("range=month").preset).toBe("1m");
    expect(parse("range=days30").preset).toBe("1m");
    expect(parse("range=days90").preset).toBe("1m");
    expect(parse("range=year").preset).toBe("1y");
  });

  it("falls back to the page's default for a range it cannot read", () => {
    expect(parse("range=nonsense").preset).toBe("all");
    expect(parse("range=nonsense", "1w").preset).toBe("1w");
    expect(parse("", "1w").preset).toBe("1w");
  });

  it("names the places apart from the dates", () => {
    // `from` and `to` are the date range, so the ends of the journey take names of
    // their own — a link that pinned a month to a place used to lose one of them.
    const state = withPreset("1m", { from: "2026-06-01", startLocation: "3", endLocation: "5" });
    const params = toUrlParams(state, "date");
    expect(params.get("from")).toBe("2026-06-01");
    expect(params.get("fromPlace")).toBe("3");
    expect(params.get("toPlace")).toBe("5");

    const parsed = parse(params.toString());
    expect(parsed.startLocation).toBe("3");
    expect(parsed.endLocation).toBe("5");
    expect(resolveWindow(parsed, ctx())).toEqual(resolveWindow(state, ctx()));
  });

  it("round-trips the single place a charging session happened at", () => {
    const params = toUrlParams(withPreset("all", { location: "7" }), "date");
    expect(params.get("place")).toBe("7");
    expect(parse(params.toString()).location).toBe("7");
  });

  it("leaves every place out until one is picked", () => {
    const params = toUrlParams(withPreset("all"), "date");
    for (const name of ["fromPlace", "toPlace", "place"]) expect(params.get(name)).toBeNull();
  });
});

describe("the API query", () => {
  const query = (over: Partial<FilterState>) =>
    new URLSearchParams(toQuery(withPreset("all", over), RANGE_PARAMS, 50, ctx()));

  it("asks for each end of a drive by the geofence it has to sit in", () => {
    const params = query({ startLocation: "3", endLocation: "5" });
    expect(params.get("startGeofenceId")).toBe("3");
    expect(params.get("endGeofenceId")).toBe("5");
  });

  it("asks for a charging session by the one place it happened at", () => {
    expect(query({ location: "7" }).get("geofenceId")).toBe("7");
  });

  it("says nothing about a place a page does not offer", () => {
    // Only the fields a page's own pickers set are ever filled in, so the charges
    // list never sends a start geofence and the drives list never sends a bare one.
    const params = query({ location: "7" });
    expect(params.get("startGeofenceId")).toBeNull();
    expect(params.get("endGeofenceId")).toBeNull();
  });
});

describe("labelling the window", () => {
  it("names the period where the dates would only have to be decoded", () => {
    expect(rangeLabel(withPreset("1m"), ctx())).toBe("July 2026");
    expect(rangeLabel(withPreset("1y"), ctx())).toBe("2026");
    expect(rangeLabel(withPreset("all"), ctx())).toBe("All time");
  });

  /*
    A week is labelled with its days, in whatever order the viewer's locale puts
    them — so these check which parts are there rather than pinning one language's
    word order.
  */
  const monthName = (at: string) =>
    new Date(at).toLocaleDateString(undefined, { timeZone: BERLIN, month: "short" });

  it("spells out a week as the days it covers, naming the month once", () => {
    // Monday 20 July to Sunday the 26th.
    const label = rangeLabel(withPreset("1w"), ctx());
    expect(label).toContain("20");
    expect(label).toContain("26");
    expect(label).toContain("2026");
    expect(label.split(monthName("2026-07-22T12:00:00Z"))).toHaveLength(2);
  });

  it("names both months for a week that straddles two", () => {
    const label = rangeLabel(withPreset("1w", { from: "2026-06-29" }), ctx());
    expect(label).toContain(monthName("2026-06-29T12:00:00Z"));
    expect(label).toContain(monthName("2026-07-01T12:00:00Z"));
  });

  it("says what it knows about a half-typed custom range", () => {
    expect(rangeLabel(withPreset("custom", { from: "2026-06-01", to: "" }), ctx())).toBe("2026-06-01 – …");
  });
});
