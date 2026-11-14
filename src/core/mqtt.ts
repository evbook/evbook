import type { CarSummaryDto } from "@shared/api-types";

/**
 * What the MQTT publisher sends for one car: topic names and payloads, worked
 * out from a `CarSummaryDto` without touching a broker. The topic list is
 * documented in docs/mqtt.md, and a test keeps the two in step.
 *
 * Topics are the summary's own field names in snake_case, as MQTT topics
 * usually are, with the unit appended where the field name leaves it out:
 * `batteryLevel` becomes `battery_level_pct`, `odometerKm` stays `odometer_km`.
 * Latitude and longitude keep their plain names: they are degrees by
 * definition, and that is what a map or a device tracker looks for.
 * A new field in the summary is published under its translated name without
 * further work; a field with a unit needs its suffix here (the test says so).
 */

/** Fields with a unit that their name does not already carry. */
const UNIT_SUFFIX: Partial<Record<keyof CarSummaryDto, string>> = {
  batteryLevel: "pct",
  usableBatteryLevel: "pct",
  chargeLimitSoc: "pct",
  power: "kw",
  heading: "deg",
  insideTemp: "c",
  outsideTemp: "c",
  driverTempSetting: "c",
  passengerTempSetting: "c",
  chargerPower: "kw",
  chargerVoltage: "v",
  chargerCurrent: "a",
  chargeEnergyAdded: "kwh",
  timeToFullCharge: "h",
  tpmsPressureFl: "bar",
  tpmsPressureFr: "bar",
  tpmsPressureRl: "bar",
  tpmsPressureRr: "bar",
};

/**
 * Instants, published as ISO 8601 rather than epoch milliseconds so a
 * dashboard can show them as they are.
 */
const INSTANTS = new Set<keyof CarSummaryDto>(["since", "dataAt", "lastFetchAt"]);

/**
 * Not single values: the tyre list, maintenance and the active route are
 * nested objects, and the car id is in the topic already. They follow with
 * the shared entity definitions.
 */
const NOT_PUBLISHED = new Set<keyof CarSummaryDto>(["carId", "tyres", "maintenance", "activeRoute"]);

/** `chargeLimitSoc` → `charge_limit_soc`, `tpmsPressureFl` → `tpms_pressure_fl`. */
export function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** The topic name of a summary field, below `<prefix>/cars/<id>/`. */
export function topicName(field: keyof CarSummaryDto): string {
  const suffix = UNIT_SUFFIX[field];
  return suffix ? `${snakeCase(field)}_${suffix}` : snakeCase(field);
}

/**
 * The payload of one value. Unknown (null) is an empty payload — never "0" or
 * "false", which would read as a measurement — so a retained topic is cleared
 * rather than left showing the last known value as if it were current.
 */
export function payloadOf(field: keyof CarSummaryDto, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (INSTANTS.has(field) && typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value;
  return "";
}

/** What the publisher adds to the summary from outside it. */
export interface CarExtras {
  /** The car's name in EVBook. */
  displayName: string | null;
  /** Name of the geofence the car is in; null when it is in none or its position is unknown. */
  geofence: string | null;
}

/** Every topic (below `<prefix>/cars/<id>/`) and payload for one car. */
export function carTopics(summary: CarSummaryDto, extras: CarExtras): Map<string, string> {
  const topics = new Map<string, string>();
  topics.set("display_name", extras.displayName ?? "");
  topics.set("geofence", extras.geofence ?? "");
  for (const [field, value] of Object.entries(summary) as [keyof CarSummaryDto, unknown][]) {
    if (NOT_PUBLISHED.has(field)) continue;
    if (value !== null && typeof value === "object") continue;
    topics.set(topicName(field), payloadOf(field, value));
  }
  return topics;
}

/** A topic prefix as typed: trimmed, no leading or trailing slash, no wildcards; empty = "evbook". */
export function normalizePrefix(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "evbook" : trimmed;
}

/** Whether a prefix can be published under: no wildcards, no empty levels, no NUL. */
export function isValidPrefix(prefix: string): boolean {
  return (
    prefix.length <= 128 &&
    !prefix.includes("#") &&
    !prefix.includes("+") &&
    !prefix.includes(String.fromCharCode(0)) &&
    !prefix.split("/").some((level) => level === "")
  );
}
