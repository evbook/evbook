import { num, obj, reading, str, time, type Json, type Reading } from "../provider/reading";
import type { Endpoint } from "./api";

/**
 * Pleos Vehicle Data API JSON → the readings EVBook keeps.
 *
 * The rules every normalizer keeps (docs/providers.md):
 *
 * 1. **Absent is not zero.** Pleos marks a value it does not have as `null`,
 *    the string `"invalid"`, or `"-"` (seen as an Ioniq 5's range). All of them
 *    are unknown, as are an unknown enum value, a unit EVBook cannot convert,
 *    and a number out of its documented range (a state of charge of 255, an
 *    odometer at its 24-bit ceiling). Only that one field degrades: one client
 *    dropped a whole car's update over a unit code it did not know.
 * 2. **Coverage is explicit.** Each endpoint owns a set of fields. An answer
 *    from it speaks for all of them, so a field it leaves out is cleared; an
 *    endpoint that did not answer says nothing, and its previous values stand.
 *
 * Every answer's `data.timestamp` is when the car sent it, which can be hours
 * before EVBook asked (a parked car uploads nothing). That is each reading's
 * `at`; `meta.timestamp`, the answer's own time, is not a measurement and is
 * not used.
 */

export type { Reading } from "../provider/reading";

export type Plug = "connected" | "disconnected";

/**
 * What the car's charging is doing, from `charge.status`:
 *
 * - `active`: energy is going in (`charging` AC, `fastCharging` DC, `wirelessCharging`).
 * - `scheduled`: plugged in, waiting for a timer (`reservedCharging`).
 * - `discharging`: vehicle-to-load or vehicle-to-grid. Never energy added.
 * - `idle`: `notCharging`, `v2lStop`.
 */
export type ChargeActivity = "active" | "scheduled" | "discharging" | "idle";

export interface PleosView {
  // batteries
  soc?: Reading<number> | null;
  plug?: Reading<Plug> | null;
  /** `charge.status` as Pleos names it; kept so an unmapped value is visible. */
  chargeStatus?: Reading<string> | null;
  activity?: Reading<ChargeActivity> | null;
  /** `charge.charging`: a second word on charging, which can disagree with the status. */
  chargingFlag?: Reading<boolean> | null;
  /** `charge.status` is `fastCharging`: a DC charge. */
  dc?: Reading<boolean> | null;
  /** The AC ("standard") and DC ("quick") charge limits, %. */
  targetAc?: Reading<number> | null;
  targetDc?: Reading<number> | null;
  minutesLeft?: Reading<number> | null;
  /** `charge.batteryCapacity` as stated. The unit is not documented (one car suggests kJ); never used as kWh. */
  capacityStated?: Reading<number> | null;
  // driving
  ignition?: Reading<boolean> | null;
  /** `ign3`: the high-voltage system is on, the car ready to drive. */
  ready?: Reading<boolean> | null;
  /** `transmission.parkingPosition`: P is selected. */
  inPark?: Reading<boolean> | null;
  odometerKm?: Reading<number> | null;
  // locations
  position?: Reading<{ lat: number; lon: number }> | null;
  heading?: Reading<number> | null;
  speedKmh?: Reading<number> | null;
  // powertrains
  rangeKm?: Reading<number> | null;
}

/** The fields each endpoint answers for: an answer clears those of them it leaves out. */
export const OWNED: Record<Endpoint, readonly (keyof PleosView)[]> = {
  batteries: [
    "soc",
    "plug",
    "chargeStatus",
    "activity",
    "chargingFlag",
    "dc",
    "targetAc",
    "targetDc",
    "minutesLeft",
    "capacityStated",
  ],
  driving: ["ignition", "ready", "inPark", "odometerKm"],
  locations: ["position", "heading", "speedKmh"],
  powertrains: ["rangeKm"],
};

/** What normalizing one answer gives: the patch and when the car sent it. */
export interface Normalized {
  patch: PleosView;
  /** `data.timestamp`: the car's upload time, epoch ms; null when absent. */
  sentAt: number | null;
  /** Values this code does not know (an enum value, a unit), kept so a contract change is visible. */
  unknown: string[];
}

/** A number, or a numeric string ("261"); the sentinels `"-"`, `"invalid"`, `"null"` and anything else are null. */
function numeric(x: unknown): number | null {
  if (typeof x === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(x)) return Number(x);
  return num(x);
}

const DISTANCE_KM: Record<string, number> = {
  km: 1,
  kilometer: 1,
  kilometers: 1,
  mile: 1.609344,
  miles: 1.609344,
  mi: 1.609344,
  meter: 0.001,
  meters: 0.001,
  m: 0.001,
  feet: 0.0003048,
  foot: 0.0003048,
  ft: 0.0003048,
};

const SPEED_KMH: Record<string, number> = { kph: 1, kmh: 1, "km/h": 1, mph: 1.609344, mps: 3.6, "m/s": 3.6 };

/** `{value, unit}` → kilometres; null for an unknown unit (recorded in `unknown`) or value. */
function distanceKm(field: unknown, unknown: string[], max = Infinity): number | null {
  const o = obj(field);
  const value = numeric(o?.value);
  const unit = str(o?.unit)?.toLowerCase();
  if (value === null || value < 0 || value >= max || !unit) return null;
  const factor = DISTANCE_KM[unit];
  if (factor === undefined) {
    if (unit !== "invalid") unknown.push(`unit:${unit}`);
    return null;
  }
  return value * factor;
}

/** `on` / `off`; `invalid` and anything else unknown. */
function onOff(x: unknown): boolean | null {
  return x === "on" ? true : x === "off" ? false : null;
}

function bool(x: unknown): boolean | null {
  return typeof x === "boolean" ? x : null;
}

function percent(x: unknown): number | null {
  const v = numeric(x);
  return v !== null && v >= 0 && v <= 100 ? v : null;
}

const ACTIVITY: Record<string, ChargeActivity> = {
  charging: "active",
  fastCharging: "active",
  wirelessCharging: "active",
  reservedCharging: "scheduled",
  v2lOperating: "discharging",
  v2xOperating: "discharging",
  notCharging: "idle",
  v2lStop: "idle",
};

/** The odometer is a 24-bit field: 16,777,215 and the value below it are its ceiling, not a distance. */
const ODOMETER_CEILING = 16_777_214;

function batteries(data: Json, at: number | null, seen: number, unknown: string[]): PleosView {
  const charge = obj(data.charge);
  const plugin = str(charge?.plugin);
  const status = str(charge?.status);
  if (status !== null && !(status in ACTIVITY) && status !== "invalid") unknown.push(`charge.status:${status}`);
  const targets = obj(charge?.targetStateOfCharge);
  const minutes = numeric(charge?.remainTime);
  const capacity = numeric(charge?.batteryCapacity);
  return {
    soc: reading(percent(charge?.stateOfCharge), at, seen),
    plug: reading<Plug>(
      plugin === "connected" ? "connected" : plugin === "disconnected" ? "disconnected" : null,
      at,
      seen,
    ),
    chargeStatus: reading(status, at, seen),
    activity: reading(status !== null ? (ACTIVITY[status] ?? null) : null, at, seen),
    chargingFlag: reading(bool(charge?.charging), at, seen),
    dc: reading(status === null || !(status in ACTIVITY) ? null : status === "fastCharging", at, seen),
    targetAc: reading(percent(targets?.standard), at, seen),
    targetDc: reading(percent(targets?.quick), at, seen),
    minutesLeft: reading(minutes !== null && minutes >= 0 && minutes < 65_535 ? minutes : null, at, seen),
    capacityStated: reading(capacity !== null && capacity > 0 ? capacity : null, at, seen),
  };
}

function driving(data: Json, at: number | null, seen: number, unknown: string[]): PleosView {
  const ignition = obj(data.ignition);
  const details = Array.isArray(ignition?.ignitionDetails) ? ignition.ignitionDetails : [];
  const detail = (type: string) => onOff(details.map(obj).find((d) => d?.type === type)?.status);
  const transmission = obj(data.transmission);
  return {
    ignition: reading(onOff(ignition?.status), at, seen),
    ready: reading(detail("ign3"), at, seen),
    inPark: reading(bool(transmission?.parkingPosition), at, seen),
    odometerKm: reading(distanceKm(data.odometer, unknown, ODOMETER_CEILING), at, seen),
  };
}

function locations(data: Json, at: number | null, seen: number, unknown: string[]): PleosView {
  const location = obj(data.location);
  const type = location?.type;
  // 0 is WGS84. 1 (Bessel) and 2 (CoordShift) are other datums: not plotted as WGS84 without a transform.
  const wgs84 = type === 0 || type === "0";
  const lat = num(location?.latitude);
  const lon = num(location?.longitude);
  const valid =
    wgs84 && lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  const heading = num(location?.heading);
  const speed = obj(location?.speed);
  const speedValue = numeric(speed?.value);
  const speedUnit = str(speed?.unit)?.toLowerCase();
  let speedKmh: number | null = null;
  if (speedValue !== null && speedValue >= 0 && speedUnit) {
    const factor = SPEED_KMH[speedUnit];
    if (factor !== undefined) speedKmh = speedValue * factor;
    else if (speedUnit !== "invalid") unknown.push(`speed.unit:${speedUnit}`);
  }
  return {
    position: reading(valid ? { lat, lon } : null, at, seen),
    heading: reading(valid && heading !== null && heading >= 0 && heading <= 360 ? heading : null, at, seen),
    speedKmh: reading(speedKmh, at, seen),
  };
}

function powertrains(data: Json, at: number | null, seen: number, unknown: string[]): PleosView {
  const ranges = Array.isArray(data.distanceToEmpties) ? data.distanceToEmpties : [];
  // The electric range only: a plug-in hybrid's total range is not its electric range.
  const ev = ranges.map(obj).find((r) => str(r?.type)?.toUpperCase() === "EV");
  return { rangeKm: reading(ev ? distanceKm(ev, unknown) : null, at, seen) };
}

const NORMALIZERS: Record<Endpoint, (data: Json, at: number | null, seen: number, unknown: string[]) => PleosView> = {
  batteries,
  driving,
  locations,
  powertrains,
};

/** One endpoint's answer (the whole envelope) → a patch for every field the endpoint owns. */
export function normalize(endpoint: Endpoint, body: unknown, seen: number): Normalized {
  const data = obj(obj(body)?.data) ?? {};
  const sentAt = time(data.timestamp);
  const unknown: string[] = [];
  const patch = NORMALIZERS[endpoint](data, sentAt, seen, unknown);
  // Coverage: every owned field is in the patch, null where the answer did not have it.
  for (const key of OWNED[endpoint]) if (!(key in patch)) (patch as Record<string, unknown>)[key] = null;
  return { patch, sentAt, unknown };
}

export function mergeView(view: PleosView, patch: PleosView): PleosView {
  return { ...view, ...patch };
}

/** A car clock this far ahead of EVBook's is not believed (a Kia's reported extra summer hour, say). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

/**
 * How old a reading is by the car's own clock; null when the car gave no time,
 * or a time in the future. Pleos's Kia feed may carry an extra daylight-saving
 * hour (a fault Kia acknowledged on its fleet feed): such a time is not
 * corrected and not trusted, so it can never keep a drive or a charge open.
 */
export function ageMs(r: Reading<unknown> | null | undefined, now: number): number | null {
  if (!r || r.at === null) return null;
  if (r.at > now + FUTURE_TOLERANCE_MS) return null;
  return Math.max(0, now - r.at);
}

/** Whether a reading was sent by the car within `maxAgeMs` of `now`. */
export function fresh(r: Reading<unknown> | null | undefined, now: number, maxAgeMs: number): boolean {
  const age = ageMs(r, now);
  return age !== null && age <= maxAgeMs;
}

/** A "driving" upload older than this is not believed: the car stopped sending, so it is not on the road. */
export const MOTION_STALE_MS = 20 * 60_000;
/** A "charging" upload older than this is not believed either. */
export const CHARGE_STALE_MS = 2 * 60 * 60_000;

/**
 * Whether the car is being driven: P not selected and the high-voltage system
 * on (or, where the car does not report `ign3`, the ignition), by a fresh
 * upload. Ready in P (pre-conditioning, waiting) is not a drive, and nor is
 * accessory mode. A car that reports neither but a speed is moving.
 */
export function isDriving(view: PleosView, now: number): boolean {
  if (!fresh(view.inPark, now, MOTION_STALE_MS)) return false;
  if (view.inPark?.v !== false) return false;
  const on = view.ready ?? view.ignition;
  if (on && fresh(on, now, MOTION_STALE_MS)) return on.v;
  return fresh(view.speedKmh, now, MOTION_STALE_MS) && (view.speedKmh?.v ?? 0) > 0;
}

/**
 * Whether energy is going into the battery, by a fresh upload: an active
 * charge status, or the `charging` flag while the status does not say
 * otherwise. Scheduled, V2L and V2G never count, nor does an unplugged car.
 */
export function isCharging(view: PleosView, now: number): boolean {
  if (view.plug?.v === "disconnected") return false;
  const activity = view.activity?.v;
  if (activity === "discharging" || activity === "scheduled") return false;
  const source = activity === "active" ? view.activity : view.chargingFlag?.v === true ? view.chargingFlag : null;
  return source !== null && source !== undefined && fresh(source, now, CHARGE_STALE_MS);
}

/** The limit of the charge under way, or the AC one when none is. */
export function chargeLimit(view: PleosView): number | null {
  return (view.dc?.v ? view.targetDc?.v : view.targetAc?.v) ?? null;
}

/**
 * The keys that change on every answer without the car changing
 * (core/provider/snapshot.ts): `meta`, the answer's own time and request id.
 * `data.timestamp` stays in: the same upload asked for again is a repeat, but a
 * new upload with the same values is a new observation, and is kept.
 */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set(["meta"]);
