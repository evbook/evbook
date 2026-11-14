import type { Endpoint } from "./api";

/**
 * Volvo JSON → the readings EVBook keeps, one endpoint at a time.
 *
 * Two rules, both non-negotiable:
 *
 * 1. **Absent is not zero.** `null`, a missing key, `UNSPECIFIED`, an Energy v2
 *    property whose `status` is not `OK` (`PROPERTY_NOT_SUPPORTED`, …), an unknown
 *    unit or an unknown enum value is *unknown*. Nothing here ever substitutes 0,
 *    "" or false: a phantom 0 % battery is a phantom drive and a phantom charge.
 * 2. **Coverage is explicit.** A normalizer returns a patch whose keys are the
 *    fields that response speaks about. A key present with `null` clears the
 *    previous value — the car stopped reporting it; a key absent leaves it alone
 *    — that response says nothing about it. Without this a stale state of charge
 *    would survive for ever once the car stopped sending it.
 *
 * Volvo sends three envelopes: Connected Vehicle v2 under `data` with
 * `{value, unit, timestamp}` fields, Energy v2 flat with `{status, value, unit,
 * updatedAt}`, and Location v1 as GeoJSON under `data`, longitude first.
 */

/** A value and the vehicle's own time for it (epoch ms), not the fetch time. */
export interface Reading<T> {
  v: T;
  at: number | null;
}

export type ChargingStatus = "idle" | "charging" | "done" | "scheduled" | "discharging" | "error";
export type CableStatus = "connected" | "disconnected" | "fault";
export type ChargeType = "AC" | "DC" | "none";
export type Opening = "open" | "ajar" | "closed";
export type TyreWarning = "ok" | "low" | "very-low" | "high" | "fault";
export type Powertrain = "electric" | "plug-in-hybrid" | "other";

export interface VolvoDetails {
  model: string | null;
  modelYear: number | null;
  /** As Volvo reports it — gross, by most accounts. */
  batteryCapacityKwh: number | null;
  powertrain: Powertrain | null;
  colour: string | null;
  /** The picture Volvo renders of the car (needs a browser-like UA to fetch). */
  imageUrl: string | null;
}

export interface VolvoView {
  soc?: Reading<number> | null;
  rangeKm?: Reading<number> | null;
  charging?: Reading<ChargingStatus> | null;
  cable?: Reading<CableStatus> | null;
  chargeType?: Reading<ChargeType> | null;
  powerKw?: Reading<number> | null;
  targetSoc?: Reading<number> | null;
  currentLimitA?: Reading<number> | null;
  minutesToTarget?: Reading<number> | null;
  engineRunning?: Reading<boolean> | null;
  odometerKm?: Reading<number> | null;
  tripMeterKm?: Reading<number> | null;
  consumptionKwhPer100Km?: Reading<number> | null;
  position?: Reading<{ lat: number; lon: number; alt: number | null }> | null;
  doors?: Reading<
    Record<"frontLeft" | "frontRight" | "rearLeft" | "rearRight" | "hood" | "tailgate", Opening | null>
  > | null;
  locked?: Reading<boolean> | null;
  windows?: Reading<Record<"frontLeft" | "frontRight" | "rearLeft" | "rearRight" | "sunroof", Opening | null>> | null;
  tyres?: Reading<Record<"frontLeft" | "frontRight" | "rearLeft" | "rearRight", TyreWarning | null>> | null;
  // Maintenance, from diagnostics, engine, brakes and warnings. Every warning is
  // `true` when Volvo warns, `false` on NO_WARNING, and absent on UNSPECIFIED.
  service?: Reading<VolvoService> | null;
  washerFluidWarning?: Reading<boolean> | null;
  oilLevelWarning?: Reading<boolean> | null;
  coolantLevelWarning?: Reading<boolean> | null;
  brakeFluidWarning?: Reading<boolean> | null;
  /** Exterior lamps that report a failure, by Volvo's field name without "Warning"; [] when all are fine. */
  lampFailures?: Reading<string[]> | null;
  details?: VolvoDetails | null;
}

export interface VolvoService {
  /** Whether a service is due or close; null when Volvo does not say. */
  due: boolean | null;
  /** Volvo's reason when a service is due, e.g. REGULAR_MAINTENANCE_ALMOST_TIME_FOR_SERVICE. */
  reason: string | null;
  distanceKm: number | null;
  months: number | null;
  engineHours: number | null;
}

// ---- value readers ----

type Json = Record<string, unknown>;

function obj(x: unknown): Json | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : null;
}

export function timestamp(x: unknown): number | null {
  if (typeof x !== "string" || !x) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}

function num(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return null;
}

function text(x: unknown): string | null {
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
}

/** A unit → a factor to EVBook's unit, or null when the unit is not one we know. */
type Units = Record<string, number>;
const DISTANCE: Units = { km: 1, kilometers: 1, mi: 1.609344, miles: 1.609344 };
const PERCENT: Units = { percentage: 1, "%": 1, percent: 1 };
const POWER_KW: Units = { kw: 1, watts: 0.001, w: 0.001 };
const CURRENT: Units = { ampere: 1, a: 1 };
const MINUTES: Units = { minutes: 1, min: 1 };
const CONSUMPTION: Units = { "kwh/100km": 1 };
const MONTHS: Units = { months: 1, month: 1, weeks: 7 / 30.4375, days: 1 / 30.4375 };
const HOURS: Units = { h: 1, hours: 1 };

function convert(value: unknown, unit: unknown, units: Units): number | null {
  const n = num(value);
  if (n === null || typeof unit !== "string") return null;
  const factor = units[unit.trim().toLowerCase()];
  return factor === undefined ? null : n * factor;
}

/** Connected Vehicle v2: `{value, unit, timestamp}`. */
function cvNumber(field: unknown, units: Units): Reading<number> | null {
  const f = obj(field);
  if (!f) return null;
  const v = convert(f.value, f.unit, units);
  return v === null ? null : { v, at: timestamp(f.timestamp) };
}

function cvEnum<T>(field: unknown, map: Record<string, T>): Reading<T> | null {
  const f = obj(field);
  if (!f || typeof f.value !== "string") return null;
  const v = map[f.value];
  return v === undefined ? null : { v, at: timestamp(f.timestamp) };
}

/** Energy v2: usable only when `status` is "OK". */
function energyOk(field: unknown): Json | null {
  const f = obj(field);
  return f && f.status === "OK" ? f : null;
}

function energyNumber(field: unknown, units: Units): Reading<number> | null {
  const f = energyOk(field);
  if (!f) return null;
  const v = convert(f.value, f.unit, units);
  return v === null ? null : { v, at: timestamp(f.updatedAt) };
}

function energyEnum<T>(field: unknown, map: Record<string, T>): Reading<T> | null {
  const f = energyOk(field);
  if (!f || typeof f.value !== "string") return null;
  const v = map[f.value];
  return v === undefined ? null : { v, at: timestamp(f.updatedAt) };
}

const CHARGING: Record<string, ChargingStatus> = {
  IDLE: "idle",
  CHARGING: "charging",
  DONE: "done",
  SCHEDULED: "scheduled",
  DISCHARGING: "discharging",
  ERROR: "error",
};
const CABLE: Record<string, CableStatus> = { CONNECTED: "connected", DISCONNECTED: "disconnected", FAULT: "fault" };
const CHARGE_TYPE: Record<string, ChargeType> = { AC: "AC", DC: "DC", NONE: "none" };
const ENGINE: Record<string, boolean> = { RUNNING: true, STOPPED: false };
const OPENING: Record<string, Opening> = { OPEN: "open", AJAR: "ajar", CLOSED: "closed" };
const LOCK: Record<string, boolean> = { LOCKED: true, UNLOCKED: false };
const TYRE: Record<string, TyreWarning> = {
  NO_WARNING: "ok",
  LOW_PRESSURE: "low",
  VERY_LOW_PRESSURE: "very-low",
  HIGH_PRESSURE: "high",
};

/** A map of `{value, timestamp}` fields as one reading, stamped with the latest. */
function cvGroup<K extends string, T>(
  data: Json,
  keys: Record<K, string>,
  read: (field: unknown) => Reading<T> | null,
): Reading<Record<K, T | null>> | null {
  const out = {} as Record<K, T | null>;
  let at: number | null = null;
  let any = false;
  for (const [key, volvoKey] of Object.entries(keys) as [K, string][]) {
    const r = read(data[volvoKey]);
    out[key] = r?.v ?? null;
    if (r) {
      any = true;
      if (r.at !== null && (at === null || r.at > at)) at = r.at;
    }
  }
  return any ? { v: out, at } : null;
}

// ---- per endpoint ----

function dataOf(raw: unknown): Json {
  return obj(obj(raw)?.data) ?? {};
}

export function normalizeEnergyState(raw: unknown): VolvoView {
  const r = obj(raw) ?? {};
  const minutes = energyNumber(r.estimatedChargingTimeToTargetBatteryChargeLevel, MINUTES);
  return {
    soc: energyNumber(r.batteryChargeLevel, PERCENT),
    rangeKm: energyNumber(r.electricRange, DISTANCE),
    charging: energyEnum(r.chargingStatus, CHARGING),
    cable: energyEnum(r.chargerConnectionStatus, CABLE),
    chargeType: energyEnum(r.chargingType, CHARGE_TYPE),
    powerKw: energyNumber(r.chargingPower, POWER_KW),
    targetSoc: energyNumber(r.targetBatteryChargeLevel, PERCENT),
    currentLimitA: energyNumber(r.chargingCurrentLimit, CURRENT),
    // 0 means "not charging", not "done in no time".
    minutesToTarget: minutes && minutes.v > 0 ? minutes : null,
  };
}

export function normalizeEngineStatus(raw: unknown): VolvoView {
  return { engineRunning: cvEnum(dataOf(raw).engineStatus, ENGINE) };
}

export function normalizeOdometer(raw: unknown): VolvoView {
  return { odometerKm: cvNumber(dataOf(raw).odometer, DISTANCE) };
}

export function normalizeStatistics(raw: unknown): VolvoView {
  const d = dataOf(raw);
  return {
    tripMeterKm: cvNumber(d.tripMeterAutomatic, DISTANCE),
    consumptionKwhPer100Km: cvNumber(d.averageEnergyConsumptionAutomatic, CONSUMPTION),
  };
}

export function normalizeLocation(raw: unknown): VolvoView {
  const d = dataOf(raw);
  const coords = obj(d.geometry)?.coordinates;
  const at = timestamp(obj(d.properties)?.timestamp);
  if (!Array.isArray(coords) || coords.length < 2) return { position: null };
  const lon = num(coords[0]);
  const lat = num(coords[1]);
  // (0, 0) is in the Gulf of Guinea; a car "there" is a car that sent nothing.
  if (lon === null || lat === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
    return { position: null };
  }
  // An EX30 sends 0.0 for altitude: that is "not measured", not sea level.
  const alt = num(coords[2]);
  return { position: { v: { lat, lon, alt: alt ? alt : null }, at } };
}

export function normalizeDoors(raw: unknown): VolvoView {
  const d = dataOf(raw);
  return {
    doors: cvGroup(
      d,
      {
        frontLeft: "frontLeftDoor",
        frontRight: "frontRightDoor",
        rearLeft: "rearLeftDoor",
        rearRight: "rearRightDoor",
        hood: "hood",
        tailgate: "tailgate",
      },
      (f) => cvEnum(f, OPENING),
    ),
    locked: cvEnum(d.centralLock, LOCK),
  };
}

export function normalizeWindows(raw: unknown): VolvoView {
  return {
    windows: cvGroup(
      dataOf(raw),
      {
        frontLeft: "frontLeftWindow",
        frontRight: "frontRightWindow",
        rearLeft: "rearLeftWindow",
        rearRight: "rearRightWindow",
        sunroof: "sunroof",
      },
      (f) => cvEnum(f, OPENING),
    ),
  };
}

/**
 * A Connected Vehicle warning field: `true` for any value but NO_WARNING, so an
 * enum value added later warns rather than passes; UNSPECIFIED is unknown.
 */
function cvWarning(field: unknown): Reading<boolean> | null {
  const f = obj(field);
  if (!f || typeof f.value !== "string" || f.value === "UNSPECIFIED") return null;
  return { v: f.value !== "NO_WARNING", at: timestamp(f.timestamp) };
}

/**
 * Service interval and washer fluid. The interval counts down in three units at
 * once — distance, time and engine hours — and the service warning says which
 * runs out first.
 */
export function normalizeDiagnostics(raw: unknown): VolvoView {
  const d = dataOf(raw);
  const due = cvWarning(d.serviceWarning);
  const distance = cvNumber(d.distanceToService, DISTANCE);
  const months = cvNumber(d.timeToService, MONTHS);
  const hours = cvNumber(d.engineHoursToService, HOURS);
  const parts = [due, distance, months, hours].filter((r): r is Reading<number> | Reading<boolean> => r !== null);
  const reason = obj(d.serviceWarning)?.value;
  return {
    service: parts.length
      ? {
          v: {
            due: due?.v ?? null,
            reason: due?.v && typeof reason === "string" ? reason : null,
            distanceKm: distance?.v ?? null,
            months: months?.v ?? null,
            engineHours: hours?.v ?? null,
          },
          at: Math.max(...parts.map((r) => r.at ?? 0)) || null,
        }
      : null,
    washerFluidWarning: cvWarning(d.washerFluidLevelWarning),
  };
}

export function normalizeEngine(raw: unknown): VolvoView {
  const d = dataOf(raw);
  return { oilLevelWarning: cvWarning(d.oilLevelWarning), coolantLevelWarning: cvWarning(d.engineCoolantLevelWarning) };
}

export function normalizeBrakes(raw: unknown): VolvoView {
  return { brakeFluidWarning: cvWarning(dataOf(raw).brakeFluidLevelWarning) };
}

/** The exterior lamps: which report a failure. Null when Volvo knows none of them. */
export function normalizeWarnings(raw: unknown): VolvoView {
  const d = dataOf(raw);
  const failures: string[] = [];
  let at: number | null = null;
  let any = false;
  for (const [key, field] of Object.entries(d)) {
    const r = cvWarning(field);
    if (!r) continue;
    any = true;
    if (r.at !== null && (at === null || r.at > at)) at = r.at;
    if (r.v) failures.push(key.replace(/Warning$/, ""));
  }
  return { lampFailures: any ? { v: failures.sort(), at } : null };
}

/** Volvo reports a warning per tyre, never a pressure. Unknown values are a fault. */
export function normalizeTyres(raw: unknown): VolvoView {
  return {
    tyres: cvGroup(
      dataOf(raw),
      { frontLeft: "frontLeft", frontRight: "frontRight", rearLeft: "rearLeft", rearRight: "rearRight" },
      (field) => {
        const f = obj(field);
        if (!f || typeof f.value !== "string" || f.value === "UNSPECIFIED") return null;
        return { v: TYRE[f.value] ?? "fault", at: timestamp(f.timestamp) };
      },
    ),
  };
}

/** `fuelType` → powertrain. An EX30 reports NONE; a PHEV reports PETROL/ELECTRIC. */
export function powertrainOf(fuelType: unknown): Powertrain | null {
  if (typeof fuelType !== "string" || !fuelType) return null;
  if (fuelType === "ELECTRIC" || fuelType === "NONE") return "electric";
  if (fuelType.includes("/") && fuelType.split("/").includes("ELECTRIC")) return "plug-in-hybrid";
  return "other";
}

/** `details` has no timestamp at all; it describes the car, not a moment. */
export function normalizeDetails(raw: unknown): VolvoView {
  const d = dataOf(raw);
  const descriptions = obj(d.descriptions) ?? {};
  const year = num(d.modelYear);
  const capacity = num(d.batteryCapacityKWH);
  return {
    details: {
      model: text(descriptions.model),
      modelYear: year !== null && year > 0 ? Math.round(year) : null,
      batteryCapacityKwh: capacity !== null && capacity > 0 ? capacity : null,
      powertrain: powertrainOf(d.fuelType),
      colour: text(d.externalColour),
      imageUrl: text(obj(d.images)?.exteriorImageUrl),
    },
  };
}

export function normalize(endpoint: Endpoint, raw: unknown): VolvoView {
  switch (endpoint) {
    case "energy-state":
      return normalizeEnergyState(raw);
    case "engine-status":
      return normalizeEngineStatus(raw);
    case "odometer":
      return normalizeOdometer(raw);
    case "statistics":
      return normalizeStatistics(raw);
    case "location":
      return normalizeLocation(raw);
    case "doors":
      return normalizeDoors(raw);
    case "windows":
      return normalizeWindows(raw);
    case "tyres":
      return normalizeTyres(raw);
    case "details":
      return normalizeDetails(raw);
    case "diagnostics":
      return normalizeDiagnostics(raw);
    case "engine":
      return normalizeEngine(raw);
    case "brakes":
      return normalizeBrakes(raw);
    case "warnings":
      return normalizeWarnings(raw);
    default:
      // Stored raw; nothing EVBook maps yet.
      return {};
  }
}

/** Apply a patch: covered keys replace (null clears), uncovered keys stay. */
export function mergeView(view: VolvoView, patch: VolvoView): VolvoView {
  return { ...view, ...patch };
}

/** Strip the keys that change on every poll, then hash: equal means nothing new. */
export async function fingerprint(raw: unknown): Promise<string> {
  const canonical = JSON.stringify(stripTimes(raw));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TIME_KEYS = new Set(["timestamp", "updatedAt", "operationId"]);

function stripTimes(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripTimes);
  const o = obj(x);
  if (!o) return x;
  const out: Json = {};
  for (const key of Object.keys(o).sort()) {
    if (!TIME_KEYS.has(key)) out[key] = stripTimes(o[key]);
  }
  return out;
}
