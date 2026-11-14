/**
 * Whether coming back to the tab should refresh what the page shows.
 *
 * Polling stops while the tab is hidden, and when it resumes it waits a whole
 * interval before its first request, so a tab left for hours went on showing
 * hours-old figures for another 30–60 s; and pages that do not poll at all
 * (drives, charges, stats) stayed as they were until the next navigation.
 *
 * Refetching on every return would cost a page's worth of Worker and Durable
 * Object requests each time you glance at another window, which is what the
 * polling cadence was tuned to avoid. So only an absence longer than the
 * longest poll counts: by then something on the page may well be out of date.
 */
export const RETURN_AFTER_MS = 2 * 60_000;

export function createReturnTracker(now: () => number = Date.now) {
  let hiddenAt: number | null = null;
  return {
    /** Call on every visibility change. */
    note(hidden: boolean) {
      if (hidden) hiddenAt = now();
    },
    /** True when the tab is visible again after being hidden long enough. */
    cameBack(): boolean {
      return hiddenAt !== null && now() - hiddenAt >= RETURN_AFTER_MS;
    },
  };
}

/**
 * The app's tracker, fed by the page's own visibility. React Query's focus
 * manager fires on the same event; the order of the two listeners does not
 * matter, because only the hide sets the clock and only the show reads it.
 */
export function trackReturns() {
  const tracker = createReturnTracker();
  if (typeof document !== "undefined") {
    tracker.note(document.hidden);
    document.addEventListener("visibilitychange", () => tracker.note(document.hidden));
  }
  return tracker;
}
