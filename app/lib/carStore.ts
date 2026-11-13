/**
 * The car the user is looking at, remembered across pages and visits.
 *
 * Every page that shows a car's data shows one car's — there is no view that mixes two
 * cars' drives or sums their charging — so which car that is belongs to the app, not to
 * a page. It is picked in one place, the switcher in each page's header, and the pick
 * holds on every page until it is changed. Like the date range (see `rangeStore`) it
 * outlives the visit; unlike the range it never goes stale, so there is no day stamp.
 *
 * It stays out of the URL: a car id is meaningless on anyone else's EVBook, and the
 * single owner of this one already has the switcher.
 *
 * The store notifies, because more than one component reads it at once — the page and
 * the switcher in its header, and the shell's Health dot — and a pick in one has to
 * reach the others in the same render rather than on the next navigation.
 */

const KEY = "evbook.car";

/**
 * The stored car id, or null when there is nothing usable stored.
 *
 * The empty id is what earlier versions stored for "all cars". That view is gone, so it
 * reads back as nothing picked, which opens on the first car.
 *
 * Split out from the reading so the rules can be tested without a `localStorage`, and
 * written defensively because the value is whatever is in the browser — an old shape, a
 * truncated write, or something else's key entirely.
 */
export function carFromStored(raw: string | null): string | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const carId = (parsed as Record<string, unknown>).carId;
  return typeof carId === "string" && carId !== "" ? carId : null;
}

/** The remembered car, or null to open on the first one. */
export function readCar(): string | null {
  try {
    return carFromStored(localStorage.getItem(KEY));
  } catch {
    // Storage can be missing or throw outright — Safari's private mode does.
    return null;
  }
}

const listeners = new Set<() => void>();

/**
 * The id last saved in this tab, for when storage refuses the write: the pick still has
 * to hold for the rest of the visit, just not beyond it.
 */
let unsaved: string | null = null;

/** The car to show: what storage says, or what this tab picked when storage would not keep it. */
export function currentCar(): string | null {
  return unsaved ?? readCar();
}

export function saveCar(carId: string): void {
  unsaved = null;
  try {
    localStorage.setItem(KEY, JSON.stringify({ carId }));
  } catch {
    // Remembering the car across visits is a convenience; this visit still follows the pick.
    unsaved = carId;
  }
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: a pick here, or in another tab, re-renders every reader. */
export function subscribeCar(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
