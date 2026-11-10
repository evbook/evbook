import { describe, expect, it } from "bun:test";
import { chargeChartFromStored, DEFAULT_CHARGE_CHART } from "./chargeChartStore";

/**
 * Mirror of the drive chart store's suite — see `driveChartStore.test.ts` for why
 * the parser takes a raw string. The one rule of its own here: "soc" is a valid
 * axis and the drive store's "distance" is not, so a record cannot wander
 * between the two pages.
 */

const stored = (record: unknown) => JSON.stringify(record);

describe("restoring the charge chart setup", () => {
  it("gives back what was saved", () => {
    expect(chargeChartFromStored(stored({ series: ["voltage", "current"], xAxis: "soc" }))).toEqual({
      series: ["voltage", "current"],
      xAxis: "soc",
    });
  });

  it("restores series in canonical order, whatever order they were stored in", () => {
    expect(chargeChartFromStored(stored({ series: ["packTemp", "power"], xAxis: "time" }))?.series).toEqual([
      "power",
      "packTemp",
    ]);
  });

  it("remembers everything switched off as a choice of its own", () => {
    expect(chargeChartFromStored(stored({ series: [], xAxis: "time" }))).toEqual({
      series: [],
      xAxis: "time",
    });
  });

  it("drops series it does not know rather than refusing the record", () => {
    expect(chargeChartFromStored(stored({ series: ["power", "phases"], xAxis: "time" }))?.series).toEqual(["power"]);
  });

  it("opens on the default when there is nothing stored", () => {
    expect(chargeChartFromStored(null)).toBeNull();
    expect(chargeChartFromStored("")).toBeNull();
    expect(DEFAULT_CHARGE_CHART.series.length).toBeGreaterThan(0);
  });

  it("ignores anything it cannot read, rather than throwing on the way in", () => {
    for (const raw of [
      "not json",
      "null",
      '"power"',
      "[]",
      "{}",
      stored({ series: "power", xAxis: "time" }),
      stored({ series: ["power"], xAxis: "distance" }),
      stored({ series: ["power"] }),
    ]) {
      expect(chargeChartFromStored(raw)).toBeNull();
    }
  });
});
