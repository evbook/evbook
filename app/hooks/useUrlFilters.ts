import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { fromUrlParams, toUrlParams, type FilterPatch, type FilterState, type PresetKey } from "@/lib/filters";
import { readCar, saveCar } from "@/lib/carStore";
import { readRange, sameRange, saveRange } from "@/lib/rangeStore";

interface UrlFilterOptions {
  /**
   * The range a page opens on when nothing else says otherwise, and the one left
   * out of the URL. The lists default to all time; the timeline page has no
   * all-time option, so it passes its own.
   */
  defaultPreset?: PresetKey;
  /** False on a page that cannot draw an unbounded window; see `DateRangeNav`. */
  allowAll?: boolean;
}

/** Whether the URL says anything at all about which window to show. */
function describesRange(params: URLSearchParams): boolean {
  return params.has("range") || params.has("from") || params.has("to");
}

/**
 * Keeps filter state in the URL query string, so a filtered view is
 * bookmarkable, shareable, and survives reload and the back button.
 *
 * The date range and the car are additionally remembered — in `rangeStore` and
 * `carStore` — because they are the two filters that mean the same thing on every
 * page: each seeds the state on a page that opens without one of its own, and is
 * written back whenever the user changes it. A URL that names either still wins — a
 * shared link has to keep showing the view it was copied from, and so does a page the
 * user has since made a pick on, which is why every pick made under a seed names
 * itself in the URL, down to `car=all` for a car filter that was cleared.
 *
 * Changes arrive as patches and are applied to the URL as it stands at that moment,
 * not to the render the handler was made in. `BrowserRouter` puts the re-render
 * after a navigation inside a transition, so two interactions in quick succession
 * are both handled from the same render, and a caller that built a whole next state
 * by spreading that render's would carry the first change's old values back out.
 * That is exactly what put a month back after ALL had cleared it, whenever a search
 * was typed quickly enough afterwards.
 */
export function useUrlFilters(
  defaultSort: string,
  rangeKeys: string[],
  { defaultPreset = "all", allowAll = true }: UrlFilterOptions = {},
) {
  const [params, setParams] = useSearchParams();
  const keys = rangeKeys.join(",");

  // Read once per mount. The stores are where the range and the car come from, not a
  // second source of truth to hold in step with the URL while the page is open.
  const [remembered] = useState(() => readRange(allowAll));
  const [rememberedCar] = useState(() => readCar());

  const read = useCallback(
    (search: URLSearchParams): FilterState => {
      const state = fromUrlParams(search, defaultSort, keys.split(","), defaultPreset);
      const seeded = { ...state };
      if (remembered && !describesRange(search)) Object.assign(seeded, remembered);
      // Seeded separately from the range: a link can well name one and not the other,
      // and each defers to its own store only for the part the URL is silent about.
      if (rememberedCar != null && !search.has("car")) seeded.carId = rememberedCar;
      return seeded;
    },
    [defaultSort, keys, defaultPreset, remembered, rememberedCar],
  );

  const state = useMemo(() => read(params), [read, params]);

  const setState = useCallback(
    (patch: FilterPatch) => {
      // The live query string: the router writes it during the event that changed
      // it, well before React gets round to rendering the change.
      const current = read(new URLSearchParams(window.location.search));
      const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
      // Only when the user actually moved the range, so a page that had to fall
      // back to its own default cannot quietly overwrite the choice made on
      // another one by way of an unrelated edit.
      if (!sameRange(next, current)) saveRange(next);
      // Every car included: clearing the filter is as much a choice as picking a car,
      // and one made on this page should still be the one the next page opens on.
      if (next.carId !== current.carId) saveCar(next.carId);
      // replace: true keeps filter tweaking out of the back-button history.
      // The range and the car are written out in full while something is remembered,
      // so that a pick which happens to match what a silent URL would have meant still
      // lands in it and is not overlaid straight back by the seed — see `toUrlParams`.
      setParams(
        toUrlParams(next, defaultSort, defaultPreset, {
          nameDefaultRange: remembered != null,
          nameAllCars: rememberedCar != null,
        }),
        { replace: true },
      );
    },
    [read, setParams, defaultSort, defaultPreset, remembered, rememberedCar],
  );

  return [state, setState] as const;
}
