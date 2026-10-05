import { useEffect, useMemo, useState } from "react";
import type { RangeContext } from "@/lib/filters";
import { localeWeekStart } from "@/lib/weekStart";

/** Now, to the top of the minute. */
const startOfMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

/**
 * The zone, week start and clock that every date range resolves against.
 *
 * `now` is held in state and stepped on a timer rather than read during render:
 * a render that reads the clock is not idempotent, and this value reaches the
 * react-query keys. Snapping to the calendar means it changes the resolved window
 * only when the day rolls over, so the timer is there to notice midnight, not to
 * keep a sliding window moving.
 *
 * The zone is the one from settings, because that is the zone every date on screen
 * is rendered in. It falls back to the browser's only while settings are loading.
 */
export function useRangeContext(timeZone: string | undefined): RangeContext {
  const [now, setNow] = useState(startOfMinute);

  useEffect(() => {
    const timer = setInterval(() => setNow(startOfMinute()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const firstDay = useMemo(() => localeWeekStart(), []);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return useMemo(() => ({ timeZone: zone, firstDay, now }), [zone, firstDay, now]);
}
