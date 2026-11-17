/**
 * MySkoda Public API JSON → the readings EVBook keeps.
 *
 * The same two rules as the Volvo normalizer (core/volvo/normalize.ts):
 *
 * 1. **Absent is not zero.** A missing field, an unknown enum value or a value
 *    of the wrong type is *unknown*. Nothing here substitutes 0, "" or false.
 *    An unknown charging state keeps the rest of the charging section: one
 *    library dropped a whole block, state of charge included, over a value it
 *    did not know.
 * 2. **Coverage is explicit.** A section that came back speaks for all of its
 *    fields: a field missing from it clears the previous value. A section that
 *    did not come back (unavailable, disabled, not supported) says nothing, and
 *    the previous values stand — they go stale rather than turning into zeros.
 *
 * One answer holds every section, under `vehicle`, and a list of what failed
 * under `errors`. Each section carries the car's own capture time
 * (`carCapturedTimestamp`) except the parking position, which has none.
 */

/** A value, the car's own time for it (epoch ms, null when Škoda gives none), and when EVBook last saw it. */
export interface Reading<T> {
  v: T;
  at: number | null;
  seen: number;
}

/** `state` as Škoda names it; kept as a string, since new values "may be added over time". */
export type ChargeState = string;
export type Plug = "connected" | "disconnected";
export type ChargeType = "AC" | "DC" | "OFF";
export type Motion = "parked" | "moving";

export type Section = "info" | "status" | "charging" | "odometer" | "parkingPosition" | "airConditioning";

/** What a section's error says about it; `available` when it came back. */
export type SectionState = "available" | "unsupported" | "disabled" | "unavailable" | "unknown";

export interface SkodaView {
  name?: Reading<string> | null;
  soc?: Reading<number> | null;
  rangeKm?: Reading<number> | null;
  powerKw?: Reading<number> | null;
  chargeState?: Reading<ChargeState> | null;
  chargeType?: Reading<ChargeType> | null;
  plug?: Reading<Plug> | null;
  plugLocked?: Reading<boolean> | null;
  targetSoc?: Reading<number> | null;
  minutesToFull?: Reading<number> | null;
  odometerKm?: Reading<number> | null;
  motion?: Reading<Motion> | null;
  /** Only while parked: Škoda gives no position for a car in motion. */
  position?: Reading<{ lat: number; lon: number }> | null;
  locked?: Reading<boolean> | null;
  doorsOpen?: Reading<boolean> | null;
  windowsOpen?: Reading<boolean> | null;
  trunkOpen?: Reading<boolean> | null;
  bonnetOpen?: Reading<boolean> | null;
}

export interface Normalized {
  vin: string | null;
  patch: SkodaView;
  sections: Partial<Record<Section, SectionState>>;
  /** Error types this code does not know, kept so a contract change is visible rather than lost. */
  unknownErrors: string[];
}

type Json = Record<string, unknown>;

function obj(x: unknown): Json | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : null;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function str(x: unknown): string | null {
  return typeof x === "string" && x !== "" ? x : null;
}

function time(x: unknown): number | null {
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}

function reading<T>(v: T | null, at: number | null, seen: number): Reading<T> | null {
  return v === null ? null : { v, at, seen };
}

/** YES/NO, OPEN/CLOSED and friends → a boolean, or null for UNKNOWN, UNSUPPORTED and anything new. */
function yesNo(x: unknown, yes: string, no: string): boolean | null {
  return x === yes ? true : x === no ? false : null;
}

const SECTION_OF_ERROR: Record<string, Section> = {
  VEHICLE_STATUS: "status",
  ODOMETER: "odometer",
  PARKING_POSITION: "parkingPosition",
  AIR_CONDITIONING: "airConditioning",
  CHARGING: "charging",
};

const KNOWN_OTHER_ERRORS = new Set([
  "RENDER_UNAVAILABLE",
  "OPERATIONS_UNAVAILABLE",
  // Sections EVBook does not ask for, should Škoda send them anyway.
  "FUEL_STATUS_UNSUPPORTED",
  "FUEL_STATUS_DISABLED",
  "FUEL_STATUS_UNAVAILABLE",
  "AUXILIARY_HEATING_UNSUPPORTED",
  "AUXILIARY_HEATING_DISABLED",
  "AUXILIARY_HEATING_UNAVAILABLE",
  "ACTIVE_VENTILATION_UNSUPPORTED",
  "ACTIVE_VENTILATION_DISABLED",
  "ACTIVE_VENTILATION_UNAVAILABLE",
  "CHARGING_PROFILES_UNSUPPORTED",
  "CHARGING_PROFILES_DISABLED",
  "CHARGING_PROFILES_UNAVAILABLE",
]);

/** `CHARGING_UNAVAILABLE` → charging, unavailable. */
export function sectionError(type: string): { section: Section; state: SectionState } | null {
  const m = /^(.*)_(UNSUPPORTED|DISABLED|UNAVAILABLE)$/.exec(type);
  if (!m) return null;
  const section = SECTION_OF_ERROR[m[1]!];
  if (!section) return null;
  const state = m[2] === "UNSUPPORTED" ? "unsupported" : m[2] === "DISABLED" ? "disabled" : "unavailable";
  return { section, state };
}

export function normalize(body: unknown, seen: number): Normalized {
  const root = obj(body);
  const vehicle = obj(root?.vehicle);
  const patch: SkodaView = {};
  const sections: Partial<Record<Section, SectionState>> = {};
  const unknownErrors: string[] = [];

  for (const e of Array.isArray(root?.errors) ? root.errors : []) {
    const type = str(obj(e)?.type);
    if (!type) continue;
    const hit = sectionError(type);
    if (hit) sections[hit.section] = hit.state;
    else if (!KNOWN_OTHER_ERRORS.has(type)) unknownErrors.push(type);
  }

  if (!vehicle) return { vin: null, patch, sections, unknownErrors };

  const name = str(vehicle.name);
  if (name !== null) {
    patch.name = reading(name, null, seen);
    sections.info = "available";
  }

  const charging = obj(vehicle.charging);
  if (charging) {
    sections.charging = "available";
    const at = time(charging.carCapturedTimestamp);
    const status = obj(charging.status);
    const battery = obj(status?.battery);
    const settings = obj(charging.settings);
    const soc = num(battery?.stateOfChargeInPercent);
    patch.soc = reading(soc !== null && soc >= 0 && soc <= 100 ? soc : null, at, seen);
    const range = num(battery?.remainingCruisingRangeInMeters);
    patch.rangeKm = reading(range !== null && range >= 0 ? range / 1000 : null, at, seen);
    const power = num(status?.chargePowerInKw);
    patch.powerKw = reading(power !== null && power >= 0 ? power : null, at, seen);
    patch.chargeState = reading(str(status?.state), at, seen);
    const type = str(status?.chargeType);
    patch.chargeType = reading(type === "AC" || type === "DC" || type === "OFF" ? type : null, at, seen);
    const plug = str(status?.plugConnectionState);
    patch.plug = reading<Plug>(
      plug === "CONNECTED" ? "connected" : plug === "DISCONNECTED" ? "disconnected" : null,
      at,
      seen,
    );
    patch.plugLocked = reading(yesNo(status?.plugLockState, "LOCKED", "UNLOCKED"), at, seen);
    const target = num(settings?.targetStateOfChargeInPercent);
    patch.targetSoc = reading(target !== null && target > 0 && target <= 100 ? target : null, at, seen);
    const minutes = num(status?.remainingTimeToFullyChargedInMinutes);
    patch.minutesToFull = reading(minutes !== null && minutes >= 0 ? minutes : null, at, seen);
  }

  const odometer = obj(vehicle.odometer);
  if (odometer) {
    sections.odometer = "available";
    const km = num(odometer.mileageInKm);
    patch.odometerKm = reading(km !== null && km >= 0 ? km : null, time(odometer.carCapturedTimestamp), seen);
  }

  const parking = obj(vehicle.parkingPosition);
  if (parking) {
    sections.parkingPosition = "available";
    const state = str(parking.state);
    const motion: Motion | null = state === "PARKED" ? "parked" : state === "IN_MOTION" ? "moving" : null;
    patch.motion = reading(motion, null, seen);
    const gps = obj(parking.gpsCoordinates);
    const lat = num(gps?.latitude);
    const lon = num(gps?.longitude);
    const valid =
      lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
    patch.position = reading(valid && motion === "parked" ? { lat, lon } : null, null, seen);
  }

  const status = obj(vehicle.status);
  if (status) {
    sections.status = "available";
    const at = time(status.carCapturedTimestamp);
    const overall = obj(status.overall);
    const detail = obj(status.detail);
    patch.locked = reading(yesNo(overall?.locked, "YES", "NO"), at, seen);
    patch.doorsOpen = reading(yesNo(overall?.doors, "OPEN", "CLOSED"), at, seen);
    patch.windowsOpen = reading(yesNo(overall?.windows, "OPEN", "CLOSED"), at, seen);
    patch.trunkOpen = reading(yesNo(detail?.trunk, "OPEN", "CLOSED"), at, seen);
    patch.bonnetOpen = reading(yesNo(detail?.bonnet, "OPEN", "CLOSED"), at, seen);
  }

  if (obj(vehicle.airConditioning)) sections.airConditioning = "available";

  return { vin: str(vehicle.vin), patch, sections, unknownErrors };
}

export function mergeView(view: SkodaView, patch: SkodaView): SkodaView {
  return { ...view, ...patch };
}

/**
 * Whether the car is charging, as far as the answer can say. An explicit
 * `CHARGING`, or power flowing through a cable that is not known to be out.
 * `CONSERVING` alone is neither: three clients read it three ways, so it never
 * opens a session by itself (it keeps one open only while power flows).
 */
export function isCharging(view: SkodaView): boolean {
  if (view.plug?.v === "disconnected") return false;
  if (view.chargeState?.v === "CHARGING") return true;
  return (view.powerKw?.v ?? 0) > 0;
}

/** Strip the keys that change on every answer, then hash: equal means nothing new. */
export async function fingerprint(raw: unknown): Promise<string> {
  const canonical = JSON.stringify(stripTimes(raw));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TIME_KEYS = new Set(["carCapturedTimestamp", "renderUrl"]);

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
