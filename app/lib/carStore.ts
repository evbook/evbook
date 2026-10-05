/**
 * The car the user last picked, remembered across pages and visits.
 *
 * The car belongs in the same category as the date range — see `rangeStore` — in that
 * it is not really about the page you are on: having narrowed the drives to one car of
 * two, you mean it for the charges, the timeline and the statistics as well, and having
 * said so once you should not have to say it again on the next page or the next morning.
 *
 * Unlike the range it never goes stale. Which window you are working in is a fact about
 * today; which car you care about is not, so there is no day stamp here.
 *
 * This stays out of the URL for the same reason the range does: a URL means "this exact
 * view" and always wins over what is stored here.
 */

const KEY = "evbook.car";

/**
 * The stored car id, or null when there is nothing usable stored.
 *
 * The empty id is a choice — "all cars" — and a real answer to give back, which is why a
 * record is an object rather than the bare id: a missing key and a stored "all cars"
 * have to be told apart, and `null` from `getItem` alone cannot do that.
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
  return typeof carId === "string" ? carId : null;
}

/** The remembered car, or null to open on the page's own default. */
export function readCar(): string | null {
  try {
    return carFromStored(localStorage.getItem(KEY));
  } catch {
    // Storage can be missing or throw outright — Safari's private mode does.
    return null;
  }
}

export function saveCar(carId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ carId }));
  } catch {
    // Remembering the car is a convenience; failing to is not worth a broken page.
  }
}
