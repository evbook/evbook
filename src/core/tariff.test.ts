import { describe, expect, it } from "bun:test";
import type { TariffPriceDto, TariffWindowDto } from "@shared/api-types";
import {
  BASE,
  changedDays,
  momentAt,
  priceOn,
  rateSlices,
  tariffProblem,
  weekGrid,
  windowAt,
  windowCovers,
} from "./tariff";

const BERLIN = "Europe/Berlin";
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

function win(start: string, end: string, rate: number, extra: Partial<TariffWindowDto> = {}): TariffWindowDto {
  return { label: null, days: ALL_DAYS, start, end, months: null, rate, ...extra };
}

function price(windows: TariffWindowDto[], extra: Partial<TariffPriceDto> = {}): TariffPriceDto {
  return { validFrom: "2026-01-01", billingType: "per_kwh", rate: 0.3, sessionFeeCents: null, windows, ...extra };
}

/** A local moment by its parts; weekday from the date. */
function at(date: string, time: string) {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { year: y, month: mo, day: d, weekday: wd === 0 ? 7 : wd, minute: h * 60 + m };
}

describe("window matching", () => {
  it("covers its own hours only, end exclusive", () => {
    const w = win("08:00", "18:00", 0.4);
    expect(windowCovers(w, at("2026-03-02", "07:59"))).toBe(false);
    expect(windowCovers(w, at("2026-03-02", "08:00"))).toBe(true);
    expect(windowCovers(w, at("2026-03-02", "17:59"))).toBe(true);
    expect(windowCovers(w, at("2026-03-02", "18:00"))).toBe(false);
  });

  it("crosses midnight into the next day, belonging to the day it starts", () => {
    // Monday only: Monday night into Tuesday morning.
    const w = win("22:00", "06:00", 0.12, { days: [1] });
    expect(windowCovers(w, at("2026-03-02", "21:59"))).toBe(false); // Monday
    expect(windowCovers(w, at("2026-03-02", "22:00"))).toBe(true);
    expect(windowCovers(w, at("2026-03-03", "05:59"))).toBe(true); // Tuesday morning
    expect(windowCovers(w, at("2026-03-03", "06:00"))).toBe(false);
    // Monday morning belongs to Sunday's night, which is not one of its days.
    expect(windowCovers(w, at("2026-03-02", "03:00"))).toBe(false);
    // Tuesday night is not Monday's.
    expect(windowCovers(w, at("2026-03-03", "23:00"))).toBe(false);
  });

  it("reads 00:00–00:00 as the whole day and 12:00–12:00 as noon to noon", () => {
    const day = win("00:00", "00:00", 0.1, { days: [6] });
    expect(windowCovers(day, at("2026-03-07", "00:00"))).toBe(true);
    expect(windowCovers(day, at("2026-03-07", "23:59"))).toBe(true);
    expect(windowCovers(day, at("2026-03-08", "00:00"))).toBe(false);
    const noon = win("12:00", "12:00", 0.1, { days: [6] });
    expect(windowCovers(noon, at("2026-03-07", "11:59"))).toBe(false);
    expect(windowCovers(noon, at("2026-03-08", "11:59"))).toBe(true);
    expect(windowCovers(noon, at("2026-03-08", "12:00"))).toBe(false);
  });

  it("lets the last overlapping window win", () => {
    const p = price([win("00:00", "00:00", 0.2), win("22:00", "06:00", 0.1), win("23:00", "01:00", 0.5)]);
    expect(windowAt(p, at("2026-03-02", "12:00"))).toBe(0);
    expect(windowAt(p, at("2026-03-02", "22:30"))).toBe(1);
    expect(windowAt(p, at("2026-03-02", "23:30"))).toBe(2);
    expect(windowAt(p, at("2026-03-03", "00:30"))).toBe(2);
    expect(windowAt(p, at("2026-03-03", "01:30"))).toBe(1);
    expect(windowAt(price([]), at("2026-03-03", "01:30"))).toBe(BASE);
  });

  it("filters by month, judged on the day the window starts", () => {
    // Winter nights only: a December 31st night runs into January 1st and still counts;
    // a February 28th night does not run into March's filter.
    const w = win("22:00", "06:00", 0.1, { months: [12, 1, 2] });
    expect(windowCovers(w, at("2027-01-01", "03:00"))).toBe(true);
    expect(windowCovers(w, at("2026-03-01", "03:00"))).toBe(true); // Feb 28th's night
    expect(windowCovers(w, at("2026-03-01", "23:00"))).toBe(false);
    expect(windowCovers(w, at("2026-11-30", "23:00"))).toBe(false);
    expect(windowCovers(w, at("2026-12-01", "03:00"))).toBe(false); // Nov 30th's night
  });

  it("maps a week for the preview strip", () => {
    const p = price([win("22:00", "06:00", 0.1, { days: [1, 2, 3, 4, 5] })]);
    const grid = weekGrid(p);
    expect(grid[0]![23]).toBe(0); // Monday 23:00
    expect(grid[1]![5]).toBe(0); // Tuesday 05:00, Monday's night
    expect(grid[0]![5]).toBe(BASE); // Monday 05:00 is Sunday's night: not a weekday window
    expect(grid[5]![5]).toBe(0); // Saturday 05:00 is Friday's night
    expect(grid[5]![23]).toBe(BASE);
  });
});

describe("rate slices", () => {
  it("cuts a night session at the window's edges in local time", () => {
    const p = price([win("22:00", "06:00", 0.1)]);
    // 20:00–08:00 local in July (UTC+2) = 18:00Z–06:00Z.
    const slices = rateSlices(p, BERLIN, Date.UTC(2026, 6, 1, 18), Date.UTC(2026, 6, 2, 6));
    expect(slices.map((s) => [new Date(s.from).toISOString().slice(11, 16), s.window])).toEqual([
      ["18:00", BASE],
      ["20:00", 0],
      ["04:00", BASE],
    ]);
  });

  it("follows the wall clock through the night the clocks go forward", () => {
    // 29 March 2026: the 22:00–06:00 window lasts seven hours, 21:00Z (22:00 CET) to 04:00Z (06:00 CEST).
    const p = price([win("22:00", "06:00", 0.1)]);
    const slices = rateSlices(p, BERLIN, Date.UTC(2026, 2, 28, 18), Date.UTC(2026, 2, 29, 8));
    const night = slices.find((s) => s.window === 0)!;
    expect(night.from).toBe(Date.UTC(2026, 2, 28, 21));
    expect(night.to).toBe(Date.UTC(2026, 2, 29, 4));
    expect((night.to - night.from) / 3_600_000).toBe(7);
  });

  it("follows the wall clock through the night the clocks go back", () => {
    // 25 October 2026: nine hours, 20:00Z (UTC+2) to 05:00Z (UTC+1).
    const p = price([win("22:00", "06:00", 0.1)]);
    const slices = rateSlices(p, BERLIN, Date.UTC(2026, 9, 24, 18), Date.UTC(2026, 9, 25, 8));
    const night = slices.find((s) => s.window === 0)!;
    expect((night.to - night.from) / 3_600_000).toBe(9);
  });

  it("handles a window edge inside the hour the clocks skip, and one inside the repeated hour", () => {
    // From 02:30 local: on the spring night that minute never comes, so the
    // window starts when the clocks jump, at 03:00 CEST = 01:00Z.
    const p = price([win("02:30", "05:00", 0.1)]);
    const spring = rateSlices(p, BERLIN, Date.UTC(2026, 2, 28, 22), Date.UTC(2026, 2, 29, 6));
    expect(spring.find((s) => s.window === 0)!.from).toBe(Date.UTC(2026, 2, 29, 1));
    // In autumn 02:30 comes twice; the window is in force from the first one
    // (00:30Z), out while the clocks replay 02:00–02:30 (01:00Z–01:30Z), and
    // back from the second 02:30 until 05:00 CET (04:00Z).
    const autumn = rateSlices(p, BERLIN, Date.UTC(2026, 9, 24, 22), Date.UTC(2026, 9, 25, 6));
    expect(autumn.filter((s) => s.window === 0).map((s) => [s.from, s.to])).toEqual([
      [Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1)],
      [Date.UTC(2026, 9, 25, 1, 30), Date.UTC(2026, 9, 25, 4)],
    ]);
  });

  it("treats a price without windows as one slice", () => {
    expect(rateSlices(price([]), BERLIN, 0, 10)).toEqual([{ from: 0, to: 10, window: BASE, rate: 0.3 }]);
  });

  it("matches the window at a real instant in the place's zone", () => {
    const p = price([win("22:00", "06:00", 0.1)]);
    expect(windowAt(p, momentAt(Date.UTC(2026, 0, 5, 21, 30), BERLIN))).toBe(0); // 22:30 CET
    expect(windowAt(p, momentAt(Date.UTC(2026, 0, 5, 21, 30), "America/New_York"))).toBe(BASE); // 16:30
  });
});

describe("dated prices", () => {
  const first = price([], { validFrom: "2025-01-01", rate: 0.3 });
  const second = price([win("22:00", "06:00", 0.12)], { validFrom: "2026-01-01", rate: 0.32 });

  it("applies the latest price that began on or before the day, none before the first", () => {
    expect(priceOn([first, second], "2024-12-31")).toBeNull();
    expect(priceOn([first, second], "2025-06-01")).toBe(first);
    expect(priceOn([second, first], "2026-01-01")).toBe(second);
  });

  it("reprices only from a new price's first day", () => {
    expect(changedDays([first], [first, second])).toEqual([{ from: "2026-01-01", until: null }]);
  });

  it("reprices only a corrected price's own validity", () => {
    const fixed = { ...first, rate: 0.31 };
    expect(changedDays([first, second], [fixed, second])).toEqual([{ from: "2025-01-01", until: "2026-01-01" }]);
  });

  it("reprices the days a first price newly covers when it starts earlier", () => {
    const earlier = { ...first, validFrom: "2024-06-01" };
    expect(changedDays([first, second], [earlier, second])).toEqual([{ from: "2024-06-01", until: "2025-01-01" }]);
  });

  it("reprices a removed price's days under whatever now applies, and nothing for no change", () => {
    expect(changedDays([first, second], [first])).toEqual([{ from: "2026-01-01", until: null }]);
    expect(changedDays([first, second], [first, second])).toEqual([]);
  });

  it("rejects dates and times it cannot read", () => {
    expect(tariffProblem([first, second])).toBeNull();
    expect(tariffProblem([{ ...first, validFrom: "2025-02-30" }])).toMatch(/not a date/);
    expect(tariffProblem([first, { ...first }])).toMatch(/two prices/);
    expect(tariffProblem([price([win("25:00", "06:00", 0.1)])])).toMatch(/not a time/);
    expect(tariffProblem([price([win("22:00", "06:00", 0.1, { days: [] })])])).toMatch(/weekday/);
  });
});
