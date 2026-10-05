import { describe, expect, it } from "vitest";
import { DEFAULT_DRIVE_CHART, driveChartFromStored } from "./driveChartStore";

/**
 * The chart setup outlives the drive it was made on, so these cover what a stored
 * record may mean when it is read back — in particular that the axis assignment
 * (first series left, second right) never depends on click order, and that a record
 * from a newer build with series this one does not know still restores the rest.
 *
 * `driveChartFromStored` takes the raw string rather than reading storage itself,
 * for the same reason as `carFromStored`: the suite runs in workerd, which has no
 * `localStorage`, and the value really is arbitrary text from the browser.
 */

const stored = (record: unknown) => JSON.stringify(record);

describe("restoring the drive chart setup", () => {
  it("gives back what was saved", () => {
    expect(driveChartFromStored(stored({ series: ["battery", "range"], xAxis: "distance" }))).toEqual({
      series: ["battery", "range"],
      xAxis: "distance",
    });
  });

  it("restores series in canonical order, whatever order they were stored in", () => {
    // The order is the axis assignment — inside on the left because "inside" was
    // clicked first would move the axes around between visits.
    expect(driveChartFromStored(stored({ series: ["inside", "speed"], xAxis: "time" }))?.series).toEqual([
      "speed",
      "inside",
    ]);
  });

  it("remembers everything switched off as a choice of its own", () => {
    expect(driveChartFromStored(stored({ series: [], xAxis: "time" }))).toEqual({
      series: [],
      xAxis: "time",
    });
  });

  it("drops series it does not know rather than refusing the record", () => {
    // What a record written by a newer build looks like from here.
    expect(driveChartFromStored(stored({ series: ["speed", "heading"], xAxis: "time" }))?.series).toEqual([
      "speed",
    ]);
  });

  it("opens on the default when there is nothing stored", () => {
    expect(driveChartFromStored(null)).toBeNull();
    expect(driveChartFromStored("")).toBeNull();
    expect(DEFAULT_DRIVE_CHART.series.length).toBeGreaterThan(0);
  });

  it("ignores anything it cannot read, rather than throwing on the way in", () => {
    for (const raw of [
      "not json",
      "null",
      '"speed"',
      "[]",
      "{}",
      stored({ series: "speed", xAxis: "time" }),
      stored({ series: ["speed"], xAxis: "odometer" }),
      stored({ series: ["speed"] }),
    ]) {
      expect(driveChartFromStored(raw)).toBeNull();
    }
  });
});
