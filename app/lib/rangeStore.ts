import { toDateInput } from "./format";
import { isPresetKey, type FilterState } from "./filters";

/**
 * The date range the user last picked, remembered across pages and visits.
 *
 * The range is the one filter that is not really about the page you are on: having
 * settled on "this week", you mean it for the drives, the charges and the timeline
 * alike, and having said it once you should not have to say it again on the next
 * page or the next morning. Every other filter stays page-local, because a distance
 * slider or a location search only makes sense where it was set.
 *
 * This deliberately stays out of the URL. A URL means "this exact view", which is
 * why a shared link always wins over what is stored here; the store means "the
 * range I am working in", which is a property of the person, not of the link.
 */

const KEY = "evbook.range";

/** The part of the filter state that describes the window. */
export type RangeSelection = Pick<FilterState, "preset" | "from" | "to">;

export function sameRange(a: RangeSelection, b: RangeSelection): boolean {
  return a.preset === b.preset && a.from === b.from && a.to === b.to;
}

/**
 * Today, as the `YYYY-MM-DD` stamp a stored range is judged fresh against.
 *
 * In the browser's zone rather than the one from settings: the stamp only decides
 * whether a window someone stepped to survives, so being a few hours out for a
 * viewer whose zones disagree costs nothing, and reading it here keeps the store
 * from needing a `RangeContext` it has nothing else to do with.
 */
function today(now = Date.now()): string {
  return toDateInput(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * What a stored record means today, or null if there is nothing usable in it.
 *
 * Split out from the reading so the rules can be tested without a `localStorage`,
 * and written defensively because the value is whatever is in the browser — an old
 * shape, a truncated write, or something else's key entirely.
 */
export function rangeFromStored(raw: string | null, day: string, allowAll: boolean): RangeSelection | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const stored = parsed as Record<string, unknown>;
  const preset = stored.preset;
  // A page without an all-time option cannot show one, so it opens on its own
  // default instead and leaves what is stored alone for the pages that can.
  if (!isPresetKey(preset) || (preset === "all" && !allowAll)) return null;

  // A pinned window is somewhere you stepped to, not a preference: once the day has
  // rolled over, "1W" should mean this week again rather than the one you were
  // looking at last. Only the preset outlives the day it was chosen on.
  if (stored.day !== day) {
    // Except for a custom range, where the dates are the whole of the selection —
    // without them there is nothing left to restore.
    return preset === "custom" ? null : { preset, from: "", to: "" };
  }

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return { preset, from: text(stored.from), to: text(stored.to) };
}

/** The remembered range, or null to open on the page's own default. */
export function readRange(allowAll: boolean): RangeSelection | null {
  try {
    return rangeFromStored(localStorage.getItem(KEY), today(), allowAll);
  } catch {
    // Storage can be missing or throw outright — Safari's private mode does.
    return null;
  }
}

export function saveRange({ preset, from, to }: RangeSelection): void {
  try {
    // Destructured rather than spread: the callers hand over a whole `FilterState`,
    // and the rest of it — the search text, the sliders — is nobody's business here.
    localStorage.setItem(KEY, JSON.stringify({ day: today(), preset, from, to }));
  } catch {
    // Remembering the range is a convenience; failing to is not worth a broken page.
  }
}
