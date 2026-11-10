import { useQuery } from "@tanstack/react-query";
import type { CarDto, GeofenceDto, GlobalSettingsDto, VersionInfoDto } from "@shared/api-types";
import { DEFAULT_CURRENCY } from "@shared/currency";
import { api } from "@/lib/api";

/**
 * What a page formats with while the settings request is still in flight.
 *
 * Pages draw their frame — headings, tiles, table headers — before any query
 * answers, and the formatters need a settings object to be called at all. This
 * one must only ever be handed placeholders: every page holds its real figures
 * back until `settings.data` is in, so a kilometre default can never briefly
 * relabel a miles user's numbers.
 */
export const PENDING_SETTINGS: GlobalSettingsDto = {
  unitOfLength: "km",
  unitOfTemperature: "C",
  unitOfPressure: "bar",
  currency: DEFAULT_CURRENCY,
  preferredRange: "rated",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  timezoneChosen: true,
  geocodeLanguage: "en",
  telemetryLevel: "off",
  documentStorage: "database",
  documentBucket: null,
};

/** Global settings drive every unit and date format, so most pages need them. */
export function useAppSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => api<GlobalSettingsDto>("/api/v1/settings"),
    staleTime: 60_000,
  });
}

/**
 * What version this instance runs, and what the last update check found.
 *
 * Nothing here does the checking — the server does that once a day from its
 * cron, so this is a cheap read of what it already knows. Kept for an hour,
 * because the answer changes at most daily and every page mounts the shell.
 */
export function useVersion() {
  return useQuery({
    queryKey: ["version"],
    queryFn: () => api<VersionInfoDto>("/api/v1/version"),
    staleTime: 60 * 60_000,
  });
}

export function useCars() {
  return useQuery({
    queryKey: ["cars"],
    queryFn: () => api<CarDto[]>("/api/v1/cars"),
    staleTime: 60_000,
  });
}

/** The named places, already sorted by name — what the location filters offer. */
export function useGeofences() {
  return useQuery({
    queryKey: ["geofences"],
    queryFn: () => api<GeofenceDto[]>("/api/v1/geofences"),
    staleTime: 60_000,
  });
}
