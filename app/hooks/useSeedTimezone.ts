import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GlobalSettingsDto } from "@shared/api-types";
import { api } from "@/lib/api";

/**
 * Fills in the instance's time zone from this browser, once.
 *
 * A fresh install's zone is the column default, UTC, and nothing used to ask
 * for a better one — so anyone who never opened Settings read their clock and
 * their days in UTC. The browser already knows where its owner is. The first
 * visit after install (or after the update that brought this) saves that zone,
 * which marks it chosen, and from then on only Settings changes it.
 *
 * Not in the demo: that session is shared, its zone comes from the seed, and the
 * first visitor's zone has no business becoming everyone's.
 */
export function useSeedTimezone(settings: GlobalSettingsDto | undefined, demo: boolean | undefined) {
  const queryClient = useQueryClient();
  const tried = useRef(false);

  useEffect(() => {
    if (!settings || settings.timezoneChosen || demo || tried.current) return;
    const zone = browserTimeZone();
    if (!zone) return;
    tried.current = true;
    api<GlobalSettingsDto>("/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ timezone: zone }),
    })
      .then((updated) => {
        queryClient.setQueryData(["settings"], updated);
        // Statistics are bucketed into days on the server, in this zone, so
        // anything fetched before the switch was cut at the wrong midnight.
        if (updated.timezone !== settings.timezone) void queryClient.invalidateQueries();
      })
      // Nothing to tell anyone: the zone stays as it was, and Settings can set it.
      .catch(() => undefined);
  }, [settings, demo, queryClient]);
}

/** The browser's IANA zone, or null where it cannot say (some locked-down browsers). */
function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length <= 64 ? zone : null;
  } catch {
    return null;
  }
}
