import { describe, expect, it } from "bun:test";
import { addDays, localDate, localParts, localToUtc, offsetChanges, startOfLocalDay } from "./zone";

const BERLIN = "Europe/Berlin";
const H = 3_600_000;

describe("zone", () => {
  it("reads the local wall clock and weekday", () => {
    // 2026-03-02T23:30Z is Tuesday 00:30 in Berlin (UTC+1).
    const p = localParts(Date.UTC(2026, 2, 2, 23, 30), BERLIN);
    expect(p).toMatchObject({ year: 2026, month: 3, day: 3, hour: 0, minute: 30, weekday: 2 });
    expect(localDate(Date.UTC(2026, 2, 2, 22, 59), BERLIN)).toBe("2026-03-02");
  });

  it("names one instant for an ordinary wall time", () => {
    expect(localToUtc(BERLIN, "2026-07-01", 22 * 60)).toEqual([Date.UTC(2026, 6, 1, 20)]);
  });

  it("names no instant for a wall time the clocks skip", () => {
    // 29 March 2026: 02:00 becomes 03:00 in Berlin.
    expect(localToUtc(BERLIN, "2026-03-29", 2 * 60 + 30)).toEqual([]);
  });

  it("names two instants for a wall time the clocks repeat", () => {
    // 25 October 2026: 03:00 becomes 02:00, so 02:30 happens at 00:30Z and 01:30Z.
    expect(localToUtc(BERLIN, "2026-10-25", 2 * 60 + 30)).toEqual([
      Date.UTC(2026, 9, 25, 0, 30),
      Date.UTC(2026, 9, 25, 1, 30),
    ]);
  });

  it("finds the offset changes, to the minute", () => {
    const changes = offsetChanges(Date.UTC(2026, 2, 28), Date.UTC(2026, 2, 30), BERLIN);
    expect(changes).toEqual([Date.UTC(2026, 2, 29, 1)]);
    expect(offsetChanges(Date.UTC(2026, 5, 1), Date.UTC(2026, 5, 3), BERLIN)).toEqual([]);
  });

  it("starts a day at midnight, or when a zone that skips midnight begins it", () => {
    expect(startOfLocalDay("2026-01-15", BERLIN)).toBe(Date.UTC(2026, 0, 14, 23));
    // Asia/Beirut springs forward at midnight: 29 March 2026 begins at 01:00 local.
    const beirut = startOfLocalDay("2026-03-29", "Asia/Beirut");
    expect(localParts(beirut, "Asia/Beirut")).toMatchObject({ day: 29, hour: 1, minute: 0 });
    expect(localDate(beirut - 1, "Asia/Beirut")).toBe("2026-03-28");
    // The day that loses its first hour is 23 hours long.
    expect(startOfLocalDay("2026-03-30", "Asia/Beirut") - beirut).toBe(23 * H);
  });

  it("adds calendar days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });
});
