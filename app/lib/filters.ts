import type { Bound } from "@shared/api-types";
import { shiftWindow, windowFor, zonedTimeToUtc, type FirstDay, type Period } from "@shared/timeBuckets";
import { toDateInput } from "./format";

/**
 * Filter state for the drives and charges lists. Everything lives in the URL so
 * a view can be bookmarked, shared, and survives a reload or a back button. The
 * date range is additionally remembered in `rangeStore`, which is what a page
 * opens on when its URL names no range of its own.
 */

export type PresetKey = "1d" | "1w" | "1m" | "1y" | "all" | "custom";

/**
 * The presets that resolve to exactly one calendar period, which is what makes
 * the arrows meaningful: the preset picks the size of a step and the arrows walk
 * the calendar in those steps. Windows land on the same boundaries every time, so
 * a bucketed rollup table can serve them without recomputing anything.
 */
export const PRESETS: { key: PresetKey; label: string; period: Period }[] = [
  { key: "1d", label: "1D", period: "day" },
  { key: "1w", label: "1W", period: "week" },
  { key: "1m", label: "1M", period: "month" },
  { key: "1y", label: "1Y", period: "year" },
];

/** The period a steppable preset walks in, or null for "all" and "custom". */
export function periodOf(preset: PresetKey): Period | null {
  return PRESETS.find((p) => p.key === preset)?.period ?? null;
}

export interface Range {
  min: string;
  max: string;
}

export interface FilterState {
  carId: string;
  preset: PresetKey;
  /**
   * For a calendar preset, the start of the window being viewed — set once the
   * user steps off the present, empty while they are looking at the current one.
   * Leaving it empty is what keeps a shared "this week" link evergreen instead of
   * pinning it to the week it was copied in.
   *
   * For "custom", the start of the range, with `to` as its end.
   */
  from: string;
  to: string;
  search: string;
  currentType: string;
  /**
   * The geofence each end of a drive has to sit in, as its id. Drives read both;
   * charges read `location` alone, since a session happens in one place.
   *
   * Only named places are on offer. The free-text search already covers everywhere
   * else, an address being a thing the geocoder found rather than a thing the owner
   * chose, and a list of every address the car has ever parked at would be a list no
   * one could pick out of.
   */
  startLocation: string;
  endLocation: string;
  location: string;
  /**
   * Which timeline event kinds to show. Empty means all of them, which is what
   * keeps the parameter out of the URL until the user narrows it. Only the History
   * page reads this; the lists carry it without setting it.
   */
  kinds: string[];
  /**
   * The trip being looked at, as its start instant. Only the Trips page reads it;
   * it lives here rather than in component state because a trip is the thing on
   * that page worth sending to someone, and every other view in this app is
   * shareable by its URL.
   */
  trip: string;
  ranges: Record<string, Range>;
  sort: string;
  dir: "asc" | "desc";
  page: number;
}

/**
 * A change to the filters: the fields that differ, or a function of the state it
 * is applied to.
 *
 * Patches rather than whole states, because a control only ever means to change
 * its own field, and the state it was rendered from may already be a render
 * behind — see `useUrlFilters`. Reach for the function form whenever the new value
 * is derived from the old one (a stepped window, a toggled sort, the next page);
 * that is the only form that cannot read a stale value.
 */
export type FilterPatch = Partial<FilterState> | ((current: FilterState) => Partial<FilterState>);

/**
 * Everything `resolveWindow` needs beyond the filter state. The zone is the one
 * configured in settings, not the browser's: every date on screen is rendered in
 * it, so snapping in any other calendar would show a window whose bounds
 * disagreed with its own labels.
 */
export interface RangeContext {
  timeZone: string;
  firstDay: FirstDay;
  now: number;
}

export const EMPTY_RANGE: Range = { min: "", max: "" };

/** `preset` is overridable for pages like History that have no all-time option. */
export function emptyFilters(sort: string, rangeKeys: string[], preset: PresetKey = "all"): FilterState {
  return {
    carId: "",
    preset,
    from: "",
    to: "",
    search: "",
    currentType: "",
    startLocation: "",
    endLocation: "",
    location: "",
    kinds: [],
    trip: "",
    ranges: Object.fromEntries(rangeKeys.map((key) => [key, { ...EMPTY_RANGE }])),
    sort,
    dir: "desc",
    page: 0,
  };
}

/** Noon on a `YYYY-MM-DD` date in a zone, or null if it is not a real date. */
function noonOn(date: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Midday, so the instant exists even in a zone that shifts its clock at
  // midnight, and so snapping down cannot land on the day before.
  return zonedTimeToUtc(timeZone, year, month, day, 12);
}

/**
 * Resolve a preset (or custom dates) into a half-open `[from, to)` epoch window.
 *
 * Every preset snaps to a calendar boundary, which is also what fixed a refetch
 * loop: the resolved window goes into the react-query key, and the old sliding
 * presets recomputed `now - 30 days` on every render, so the key changed every
 * millisecond and each render started another request. A snapped window is
 * identical on every render by construction — it only changes when the calendar
 * does — so no rounding or anchoring is needed to hold it still.
 */
export function resolveWindow(state: FilterState, ctx: RangeContext): { from?: number; to?: number } {
  const window = selectedWindow(state, ctx);
  // Never ask for time that has not happened yet. A calendar period containing
  // today runs past it — "this week" ends on Sunday — and the unclamped end put a
  // stretch of future on the end of every chart, which the timeline counted as
  // hours in an unknown state and folded into its percentages.
  //
  // Only the in-progress window moves with the clock. A window that has already
  // closed resolves to two fixed instants and its query key never changes.
  if (window.to == null || window.to <= ctx.now) return window;
  return { ...window, to: clampedEnd(window.from, window.to, ctx.now) };
}

const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/**
 * How closely the open end of a window follows the clock, by how long the window
 * is. Wide windows step coarsely: the resolved end is part of every query key
 * built from the window, so a year chart that tracked the present to the minute
 * reloaded itself once a minute for a tail one seven-thousandth of a bucket
 * wide. An hour is invisible on a year and still keeps the chart current.
 */
const CLAMP_STEPS: { upTo: number; step: number }[] = [
  { upTo: 2 * DAY_MS, step: MINUTE },
  { upTo: 8 * DAY_MS, step: 5 * MINUTE },
  { upTo: 40 * DAY_MS, step: 15 * MINUTE },
];
const COARSEST_CLAMP_STEP = 60 * MINUTE;

function clampedEnd(from: number | undefined, to: number, now: number): number {
  const span = from == null ? Infinity : to - from;
  const step = CLAMP_STEPS.find((s) => span <= s.upTo)?.step ?? COARSEST_CLAMP_STEP;
  const stepped = Math.floor(now / step) * step;
  // In the first step of a period the floor lands on or before its start, and a
  // window that ends where it begins is empty. Until the clock has moved a whole
  // step into the period, the present itself is the only sensible end.
  return from != null && stepped <= from ? now : stepped;
}

/**
 * The period the user picked, unclamped — the whole of this week even when half of
 * it is still ahead. This is what the date fields and the label show, because it is
 * what was selected; `resolveWindow` is what gets fetched.
 */
export function selectedWindow(state: FilterState, ctx: RangeContext): { from?: number; to?: number } {
  if (state.preset === "all") return {};

  if (state.preset === "custom") {
    const from = state.from ? noonOn(state.from, ctx.timeZone) : null;
    const to = state.to ? noonOn(state.to, ctx.timeZone) : null;
    return {
      // Whole days at both ends, and the end is exclusive, so a custom range that
      // starts and ends on the same date still covers that entire day.
      from: from == null ? undefined : windowFor(from, "day", ctx.timeZone).from,
      to: to == null ? undefined : windowFor(to, "day", ctx.timeZone).to,
    };
  }

  const period = periodOf(state.preset) ?? "week";
  const at = (state.from && noonOn(state.from, ctx.timeZone)) || ctx.now;
  return windowFor(at, period, ctx.timeZone, ctx.firstDay);
}

/** The window one step earlier or later, as a `from` date for the filter state. */
export function steppedFrom(state: FilterState, direction: -1 | 1, ctx: RangeContext): string {
  const period = periodOf(state.preset);
  if (!period) return state.from;
  const current = selectedWindow(state, ctx);
  if (current.from == null) return state.from;
  const next = shiftWindow(current.from, period, direction, ctx.timeZone, ctx.firstDay);
  return toDateInput(next.from, ctx.timeZone);
}

/** True once the window already reaches the present; stepping forward is a no-op. */
export function isAtPresent(state: FilterState, ctx: RangeContext): boolean {
  if (!periodOf(state.preset)) return true;
  // The selected period, not the clamped one: clamping makes the current window
  // end at exactly `now`, which would otherwise read as not yet reaching it.
  const window = selectedWindow(state, ctx);
  return window.to == null || window.to > ctx.now;
}

/**
 * The resolved window as something to read: "July 2026", "2026", "Thu 23 Jul", or
 * "19 – 25 Jul 2026". Named after the period rather than the dates where that is
 * unambiguous, because "July 2026" is quicker to read than a pair of dates that
 * the reader has to work out spans a month.
 */
export function rangeLabel(state: FilterState, ctx: RangeContext): string {
  if (state.preset === "all") return "All time";

  const window = selectedWindow(state, ctx);
  if (window.from == null || window.to == null) {
    if (state.preset !== "custom") return "–";
    // A half-typed custom range still says what it knows.
    return [state.from || "…", state.to || "…"].join(" – ");
  }

  const zone = ctx.timeZone;
  const on = (at: number, options: Intl.DateTimeFormatOptions) =>
    new Date(at).toLocaleDateString(undefined, { timeZone: zone, ...options });
  // The last instant inside the window, since `to` is the next window's start.
  const last = window.to - 1;

  switch (state.preset) {
    case "1d":
      return on(window.from, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    case "1m":
      return on(window.from, { month: "long", year: "numeric" });
    case "1y":
      return on(window.from, { year: "numeric" });
    default: {
      const sameMonth = on(window.from, { month: "short", year: "numeric" }) === on(last, { month: "short", year: "numeric" });
      const start = on(window.from, sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
      const end = on(last, { day: "numeric", month: "short", year: "numeric" });
      return `${start} – ${end}`;
    }
  }
}

/**
 * The place filters: for each, the field on the state, the name it takes in the
 * URL and the parameter the API knows it by. `fromPlace` and `toPlace` rather than
 * `from` and `to`, which the date range already answers to.
 *
 * A page only ever sets the fields its own picker offers — both ends on drives,
 * the single place on charges — so the rest stay empty and out of every query.
 */
const LOCATION_FIELDS = [
  { key: "startLocation", param: "fromPlace", api: "startGeofenceId" },
  { key: "endLocation", param: "toPlace", api: "endGeofenceId" },
  { key: "location", param: "place", api: "geofenceId" },
] as const;

export type LocationKey = (typeof LOCATION_FIELDS)[number]["key"];

/** Maps a range key to the API's min/max parameter names. */
export type RangeParamMap = Record<string, { min: string; max: string; scale?: number }>;

export function toQuery(
  state: FilterState,
  rangeParams: RangeParamMap,
  pageSize: number,
  ctx: RangeContext,
): string {
  const params = new URLSearchParams();
  if (state.carId) params.set("carId", state.carId);

  const window = resolveWindow(state, ctx);
  if (window.from !== undefined) params.set("from", String(Math.round(window.from)));
  if (window.to !== undefined) params.set("to", String(Math.round(window.to)));

  if (state.search) params.set("search", state.search);
  if (state.currentType) params.set("currentType", state.currentType);

  for (const field of LOCATION_FIELDS) {
    if (state[field.key]) params.set(field.api, state[field.key]);
  }

  for (const [key, param] of Object.entries(rangeParams)) {
    const range = state.ranges[key];
    if (!range) continue;
    const scale = param.scale ?? 1;
    if (range.min !== "") params.set(param.min, String(Number(range.min) * scale));
    if (range.max !== "") params.set(param.max, String(Number(range.max) * scale));
  }

  params.set("sort", state.sort);
  params.set("dir", state.dir);
  params.set("limit", String(pageSize));
  params.set("offset", String(state.page * pageSize));
  return params.toString();
}

/**
 * How the URL says "every car" out loud. Every car is the absence of a car filter,
 * so it has no id of its own to name, and staying silent about it is what defers to
 * the remembered car instead — see `nameAllCars`. Car ids are database keys, so no
 * real car can collide with this.
 */
const ALL_CARS = "all";

/**
 * Which choices to write out even though they are what a silent URL already means.
 *
 * Both are set while something remembered is still seeding the page: a URL that says
 * nothing about a field is exactly what defers to the store, so leaving the default
 * out would let the remembered value overlay the choice the user had just made — and
 * the control for the default would look dead. See `useUrlFilters`.
 */
export interface UrlDefaults {
  /** Name the range even when it is the page's own default. */
  nameDefaultRange?: boolean;
  /** Name every car as `car=all` rather than by leaving the parameter out. */
  nameAllCars?: boolean;
}

/** Serialize to compact URL params, omitting anything at its default. */
export function toUrlParams(
  state: FilterState,
  defaultSort: string,
  defaultPreset: PresetKey = "all",
  { nameDefaultRange = false, nameAllCars = false }: UrlDefaults = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.carId) params.set("car", state.carId);
  else if (nameAllCars) params.set("car", ALL_CARS);
  if (nameDefaultRange || state.preset !== defaultPreset) params.set("range", state.preset);
  if (state.preset === "custom") {
    if (state.from) params.set("from", state.from);
    if (state.to) params.set("to", state.to);
  } else if (state.from) {
    // Only written once the user has stepped off the current window, so a link to
    // "1W" keeps meaning this week rather than the week it was shared in.
    params.set("from", state.from);
  }
  if (state.search) params.set("q", state.search);
  if (state.currentType) params.set("type", state.currentType);
  for (const field of LOCATION_FIELDS) {
    if (state[field.key]) params.set(field.param, state[field.key]);
  }
  if (state.kinds.length > 0) params.set("kinds", state.kinds.join(","));
  if (state.trip) params.set("trip", state.trip);
  for (const [key, range] of Object.entries(state.ranges)) {
    if (range.min !== "") params.set(`${key}Min`, range.min);
    if (range.max !== "") params.set(`${key}Max`, range.max);
  }
  if (state.sort !== defaultSort) params.set("sort", state.sort);
  if (state.dir !== "desc") params.set("dir", state.dir);
  if (state.page !== 0) params.set("page", String(state.page + 1));
  return params;
}

/**
 * Presets that existed before the range picker snapped to the calendar. Mapped to
 * the nearest surviving one rather than dropped, because an unknown value falls
 * back to all time — so an old bookmark would silently widen from "last 30 days"
 * to every drive ever recorded.
 */
const RETIRED_PRESETS: Record<string, PresetKey> = {
  today: "1d",
  week: "1w",
  month: "1m",
  days30: "1m",
  days90: "1m",
  year: "1y",
};

/** Whether an unknown value is one of the presets on offer. */
export function isPresetKey(value: unknown): value is PresetKey {
  return value === "all" || value === "custom" || PRESETS.some((p) => p.key === value);
}

function readPreset(raw: string | null, fallback: PresetKey): PresetKey {
  if (!raw) return fallback;
  if (isPresetKey(raw)) return raw;
  return RETIRED_PRESETS[raw] ?? fallback;
}

export function fromUrlParams(
  params: URLSearchParams,
  defaultSort: string,
  rangeKeys: string[],
  defaultPreset: PresetKey = "all",
): FilterState {
  const validPreset = readPreset(params.get("range"), defaultPreset);
  const page = Number(params.get("page") ?? 1);
  const car = params.get("car") ?? "";

  return {
    carId: car === ALL_CARS ? "" : car,
    preset: validPreset,
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    search: params.get("q") ?? "",
    currentType: params.get("type") ?? "",
    startLocation: params.get("fromPlace") ?? "",
    endLocation: params.get("toPlace") ?? "",
    location: params.get("place") ?? "",
    kinds: (params.get("kinds") ?? "").split(",").filter((kind) => kind !== ""),
    trip: params.get("trip") ?? "",
    ranges: Object.fromEntries(
      rangeKeys.map((key) => [
        key,
        { min: params.get(`${key}Min`) ?? "", max: params.get(`${key}Max`) ?? "" },
      ]),
    ),
    sort: params.get("sort") ?? defaultSort,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    page: Number.isFinite(page) && page > 1 ? page - 1 : 0,
  };
}

/** True when anything other than sorting and paging is set. */
export function hasActiveFilters(state: FilterState): boolean {
  return (
    state.carId !== "" ||
    state.preset !== "all" ||
    state.search !== "" ||
    state.currentType !== "" ||
    LOCATION_FIELDS.some((field) => state[field.key] !== "") ||
    state.kinds.length > 0 ||
    Object.values(state.ranges).some((r) => r.min !== "" || r.max !== "")
  );
}

/** Sensible slider step for a given span. */
export function stepFor(bound: Bound): number {
  const span = Math.max(0, bound.max - bound.min);
  if (span <= 5) return 0.1;
  if (span <= 50) return 1;
  if (span <= 500) return 5;
  return 10;
}
