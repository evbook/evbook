import { describe, expect, it } from "bun:test";
import { DATE_FORMATS, formatDate, type DateFormat } from "./datetime";

/**
 * The one formatter behind every date on a page. What it prints is the
 * runtime's locale's business, so these pin the two things that are ours: the
 * time zone the instant is read in, and which fields each format shows.
 */

const BERLIN = "Europe/Berlin";
// 23:30 UTC on the 12th is already the 13th in Berlin.
const LATE = Date.UTC(2026, 10, 12, 23, 30);

/** What the runtime itself prints for these fields, in whatever locale the tests run. */
const expected = (at: number, format: DateFormat, timezone: string) =>
  new Intl.DateTimeFormat(undefined, { timeZone: timezone, ...DATE_FORMATS[format] }).format(at);

describe("formatDate", () => {
  it("is a dash when there is no instant", () => {
    expect(formatDate(null, "date", BERLIN)).toBe("–");
    expect(formatDate(undefined, "time", BERLIN)).toBe("–");
  });

  it("reads the instant in the zone it is given, not the machine's", () => {
    expect(formatDate(LATE, "date", BERLIN)).toContain("13");
    expect(formatDate(LATE, "date", "UTC")).toContain("12");
    expect(formatDate(LATE, "time", BERLIN)).not.toBe(formatDate(LATE, "time", "UTC"));
  });

  it("prints every format the way the runtime's own locale does", () => {
    for (const format of Object.keys(DATE_FORMATS) as DateFormat[]) {
      expect(formatDate(LATE, format, BERLIN)).toBe(expected(LATE, format, BERLIN));
    }
  });

  it("shows only the fields a format names", () => {
    expect(formatDate(LATE, "year", BERLIN)).toBe("2026");
    expect(formatDate(LATE, "time", BERLIN)).not.toContain("2026");
    expect(formatDate(LATE, "dayMonth", BERLIN)).not.toContain("2026");
    expect(formatDate(LATE, "dateTime", BERLIN)).toContain("2026");
  });
});
