import type { GlobalSettingsDto, MaintenanceDto } from "@shared/api-types";
import * as u from "@/lib/units";

/** "brakeLightLeft" → "Brake light left": Volvo's lamp names as words. */
export function lampName(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether the service row should stand out: anything but fine or unknown. */
export function serviceWarns(m: MaintenanceDto): boolean {
  return m.serviceStatus != null && m.serviceStatus !== "ok";
}

/**
 * The service row: what is left, or how the car stands when Volvo warns.
 *
 * - fine: "in 29,631 km · 23 months"
 * - almost time: "Due soon · in 800 km · due this month"
 * - time: "Due now"; overdue: "Overdue", "Overdue by 500 km" when Volvo counts below zero
 * - a warning Volvo cannot name: "Service warning"
 *
 * A count at or below zero is never shown as "in -500 km". Under a month the
 * time reads "due this month" — `timeToService` can come in days and would
 * round to "0 months". Engine hours are left out: on an electric car they say
 * little, and the row stays short.
 */
export function serviceLeft(m: MaintenanceDto, settings: GlobalSettingsDto): string | null {
  const left: string[] = [];
  if (m.serviceDistanceKm != null && m.serviceDistanceKm > 0) left.push(u.distance(m.serviceDistanceKm, settings));
  if (m.serviceMonths != null && m.serviceMonths > 0) {
    const months = Math.round(m.serviceMonths);
    left.push(m.serviceMonths < 1 ? "due this month" : months === 1 ? "1 month" : `${months} months`);
  }
  const inLeft = left.length ? `in ${left.join(" · ")}` : null;
  switch (m.serviceStatus) {
    case "overdue": {
      const over =
        m.serviceDistanceKm != null && m.serviceDistanceKm < 0 ? u.distance(-m.serviceDistanceKm, settings) : null;
      return over ? `Overdue by ${over}` : "Overdue";
    }
    case "due":
      return "Due now";
    case "soon":
      return inLeft ? `Due soon · ${inLeft}` : "Due soon";
    case "warning":
      return "Service warning";
    default:
      return inLeft;
  }
}
