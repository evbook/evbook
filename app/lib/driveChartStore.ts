/**
 * Which telemetry series the drive chart draws, and against which x-axis. This is a
 * preference about how to read drives, not a fact about one drive — so it follows
 * the reader from drive to drive through localStorage, like the remembered car.
 */

/**
 * Canonical order, which is also the axis assignment: the first switched-on series
 * takes the left axis, the second the right. Stored sets are re-filtered through
 * this list so the assignment never depends on the order things were clicked in.
 */
export const DRIVE_CHART_SERIES = ["speed", "power", "battery", "range", "elevation", "outside", "inside"] as const;
export type DriveChartSeriesKey = (typeof DRIVE_CHART_SERIES)[number];

type DriveChartXAxis = "time" | "distance";

export interface DriveChartPrefs {
  series: DriveChartSeriesKey[];
  xAxis: DriveChartXAxis;
}

/** The pair the old fixed chart led with — how fast, and what it cost. */
export const DEFAULT_DRIVE_CHART: DriveChartPrefs = { series: ["speed", "power"], xAxis: "time" };

const KEY = "evbook.driveChart";

/**
 * The raw string rather than storage itself, so the rules are testable in workerd
 * (which has no `localStorage`) and because the value really is arbitrary browser
 * text. A series key this build does not know is dropped rather than fatal — it is
 * what a stored record from a newer build looks like. An empty set is kept: having
 * switched everything off is a choice, not a missing record.
 */
export function driveChartFromStored(raw: string | null): DriveChartPrefs | null {
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
  if (record.xAxis !== "time" && record.xAxis !== "distance") return null;
  const stored = record.series;
  return {
    series: DRIVE_CHART_SERIES.filter((key) => stored.includes(key)),
    xAxis: record.xAxis,
  };
}

export function readDriveChart(): DriveChartPrefs | null {
  try {
    return driveChartFromStored(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveDriveChart(prefs: DriveChartPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be denied (private mode); the preference just won't stick.
  }
}
