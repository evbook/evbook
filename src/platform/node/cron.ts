import { runScheduled } from "../../app";
import type { AppEnv } from "../env";

/**
 * The Node stand-in for the wrangler cron trigger: `runScheduled` on every
 * minute boundary. Chained `setTimeout` re-aligned to the wall clock each time
 * — not `setInterval` — because the ten-minute geocoding-repair gate inside is
 * `getUTCMinutes() % 10`, and a drifting interval would skip minutes.
 */
export function startCron(env: AppEnv): { stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
  };

  const tick = () => {
    arm();
    if (inFlight) {
      // The Nominatim-throttled repair pass can outlive a minute; skipping a
      // beat is what the deadline slack in runScheduled exists to absorb.
      console.warn("[cron] previous run still going, skipping this minute");
      return;
    }
    inFlight = true;
    void runScheduled(env, Date.now())
      .catch((error) => console.error("[cron] scheduled run failed:", error))
      .finally(() => {
        inFlight = false;
      });
  };

  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
