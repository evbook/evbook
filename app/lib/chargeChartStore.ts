/**
 * Which telemetry series the charge chart draws, and against which x-axis — the
 * charge page's sibling of `driveChartStore`. A preference about how to read
 * sessions, not a fact about one, so it follows the reader through localStorage.
 */

/**
 * Canonical order, which is also the axis assignment: the first switched-on chip
 * takes the left axis, the second the right. Stored sets are re-filtered through
 * this list so the assignment never depends on the order things were clicked in.
 * `packTemp` is one chip for two lines — coldest and warmest module — because
 * the gap between them is the thing being read, and it only exists on one scale.
 */
export const CHARGE_CHART_SERIES = [
  "power",
  "battery",
  "energy",
  "range",
  "voltage",
  "current",
  "packTemp",
] as const;
export type ChargeChartSeriesKey = (typeof CHARGE_CHART_SERIES)[number];

/** Clock time, or state of charge — the axis the DC taper is read against. */
type ChargeChartXAxis = "time" | "soc";

export interface ChargeChartPrefs {
  series: ChargeChartSeriesKey[];
  xAxis: ChargeChartXAxis;
}

/** The pair the old fixed chart led with — what went in, and how full it got. */
export const DEFAULT_CHARGE_CHART: ChargeChartPrefs = { series: ["power", "battery"], xAxis: "time" };

const KEY = "evbook.chargeChart";

/**
 * The raw string rather than storage itself, so the rules are testable in workerd
 * (which has no `localStorage`) and because the value really is arbitrary browser
 * text. A series key this build does not know is dropped rather than fatal — it is
 * what a stored record from a newer build looks like. An empty set is kept: having
 * switched everything off is a choice, not a missing record.
 */
export function chargeChartFromStored(raw: string | null): ChargeChartPrefs | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.series)) return null;
  if (record.xAxis !== "time" && record.xAxis !== "soc") return null;
  const stored = record.series;
  return {
    series: CHARGE_CHART_SERIES.filter((key) => stored.includes(key)),
    xAxis: record.xAxis,
  };
}

export function readChargeChart(): ChargeChartPrefs | null {
  try {
    return chargeChartFromStored(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveChargeChart(prefs: ChargeChartPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be denied (private mode); the preference just won't stick.
  }
}
