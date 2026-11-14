import type { GlobalSettingsDto, MaintenanceDto } from "@shared/api-types";
import * as u from "@/lib/units";

/** "brakeLightLeft" → "Brake light left": Volvo's lamp names as words. */
export function lampName(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * "in 29,631 km · 23 months": what is left until the next service, in the units
 * Volvo counts down. Engine hours are left out — on an electric car they say
 * little, and the row stays short.
 */
export function serviceLeft(m: MaintenanceDto, settings: GlobalSettingsDto): string | null {
  const parts: string[] = [];
  if (m.serviceDistanceKm != null) parts.push(u.distance(m.serviceDistanceKm, settings));
  if (m.serviceMonths != null) {
    const months = Math.round(m.serviceMonths);
    parts.push(months === 1 ? "1 month" : `${months} months`);
  }
  if (m.serviceDue) return parts.length ? `Due · ${parts.join(" · ")}` : "Due";
  return parts.length ? `in ${parts.join(" · ")}` : null;
}
