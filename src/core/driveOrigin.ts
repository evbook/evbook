import type { PositionAttrs } from "./tesla/payload";

/**
 * Reconstructs the start of a drive the poller could not see.
 *
 * A parked car is polled on the cron's minute clock, and a wake needs a second
 * probe INTERVALS.wakeConfirm later before vehicle_data is spent — so a driver
 * who wakes the car and pulls away immediately is well down the road by the
 * time the first sample arrives, and the drive appears to begin there. The car
 * cannot have teleported: it left from wherever its last recorded position is.
 * When the first sample's odometer confirms unseen driving, that parked point
 * becomes the drive's origin, backdated by the time the gap would have taken.
 *
 * Everything downstream comes along for free — closeDrive derives distance,
 * duration, start address and geofence from the drive's position rows — at the
 * price of one straight map segment for the stretch nobody saw.
 *
 * The start itself stays a span: no earlier than the last reading that showed
 * the car not driving (an asleep or offline probe, or a parked snapshot), no
 * later than the first sample. The backdated timestamp is only the best guess
 * inside it.
 *
 * That span is also the sanity check. If the odometer moved further than the
 * car could have driven since that quiet reading, the drive did not simply
 * begin unseen: the car was driven while nothing could read it (offline in a
 * garage, a dead token, the Worker down) and maybe parked again somewhere. Then
 * extending this drive back would invent one continuous trip and a start time
 * nobody knows, so no origin is placed; the hidden-event sweep records the
 * stretch as a reconstructed drive of its own (core/gaps.ts).
 */

/** Below this the gap is odometer noise or a car creeping in its spot. */
export const MIN_GAP_KM = 0.05;
/**
 * Above this it is a data gap — logging off, an import seam — not a missed
 * drive start, and a single invented segment would claim continuous driving
 * that may never have happened.
 */
export const MAX_GAP_KM = 20;
/**
 * The parked point must be at least this much older than the first sample,
 * so there is room to place the origin between them. Anything closer means
 * polling was dense and nothing meaningful was missed.
 */
const MIN_SPAN_MS = 60_000;

/**
 * The fastest the unseen stretch is believed to have been driven. Generous on
 * purpose: it only has to rule out distance the quiet span cannot hold.
 */
export const MAX_PLAUSIBLE_KMH = 150;

/**
 * How long before the first sample a car that woke into a drive was last read
 * as asleep or offline, when no reading of it survives: the parked probe
 * cadence (INTERVALS.asleep), the wake guard's second probe
 * (INTERVALS.wakeConfirm) and a cron minute of slack. Only for drives recorded
 * before the quiet reading was kept with the drive.
 */
export const WAKE_WINDOW_MS = 3 * 60_000;

/** Assumed speed for the unseen stretch when the first sample's is lower. */
const ASSUMED_MIN_SPEED_KMH = 30;
/** The origin never sits closer than this to either neighbour. */
const MARGIN_MS = 10_000;
/**
 * The longest stretch worth backdating. A drive undetected past this (a car
 * driven off during a suspend window, mostly) still gets its origin, but the
 * timestamp stops pretending to know when it left.
 */
const MAX_BACKDATE_MS = 15 * 60_000;

export interface ParkedPoint {
  date_at: number;
  latitude: number | null;
  longitude: number | null;
  odometer: number | null;
  elevation: number | null;
}

export interface FirstSample {
  date_at: number;
  odometer: number | null;
  speed: number | null;
}

export interface DriveOrigin {
  /** The synthetic first position: the parked point, unknown telemetry. */
  position: PositionAttrs;
  /** The start's span: the last quiet reading, and the first sample. */
  startAfter: number;
  startBefore: number;
}

/**
 * The synthetic origin for a drive whose start went unobserved, or null when
 * there is nothing to reconstruct (no parked point, no odometer on either side,
 * a gap too small to matter, too large to trust, or larger than the time since
 * the car was last read as not driving can explain).
 *
 * `quietAt` is that last quiet reading, when it is known; the parked row itself
 * is the fallback, and the bound is never earlier than it.
 */
export function estimateDriveOrigin(
  parked: ParkedPoint | null | undefined,
  first: FirstSample,
  quietAt: number | null = null,
): DriveOrigin | null {
  if (!parked || parked.latitude == null || parked.longitude == null) return null;
  if (parked.odometer == null || first.odometer == null) return null;

  const gapKm = first.odometer - parked.odometer;
  if (gapKm < MIN_GAP_KM || gapKm > MAX_GAP_KM) return null;
  if (first.date_at - parked.date_at < MIN_SPAN_MS) return null;

  const startAfter = Math.min(Math.max(parked.date_at, quietAt ?? parked.date_at), first.date_at);
  const windowMs = first.date_at - startAfter;
  if (gapKm > (MAX_PLAUSIBLE_KMH * windowMs) / 3_600_000) return null;

  const speedKmh = Math.max(first.speed ?? 0, ASSUMED_MIN_SPEED_KMH);
  const estimateMs = (gapKm / speedKmh) * 3_600_000;
  const upper = Math.min(MAX_BACKDATE_MS, windowMs - MARGIN_MS);
  const backdateMs = upper < MARGIN_MS ? windowMs / 2 : Math.min(Math.max(estimateMs, MARGIN_MS), upper);

  return {
    position: originPosition(parked, first.date_at - Math.round(backdateMs)),
    startAfter,
    startBefore: first.date_at,
  };
}

function originPosition(parked: ParkedPoint, at: number): PositionAttrs {
  return {
    date_at: at,
    latitude: parked.latitude,
    longitude: parked.longitude,
    // The parked odometer, so the drive's start_km covers the unseen stretch.
    odometer: parked.odometer,
    elevation: parked.elevation,
    // Unknown, not zero: the aggregates and the driving indexes must skip it.
    speed: null,
    power: null,
    // Null so closeDrive's range window starts at the first real sample —
    // the parked values would bill hours of vampire drain to the drive.
    ideal_battery_range_km: null,
    rated_battery_range_km: null,
    est_battery_range_km: null,
    battery_level: null,
    usable_battery_level: null,
    outside_temp: null,
    inside_temp: null,
    fan_status: null,
    driver_temp_setting: null,
    passenger_temp_setting: null,
    is_climate_on: null,
    is_rear_defroster_on: null,
    is_front_defroster_on: null,
    battery_heater: null,
    battery_heater_on: null,
    battery_heater_no_power: null,
    tpms_pressure_fl: null,
    tpms_pressure_fr: null,
    tpms_pressure_rl: null,
    tpms_pressure_rr: null,
  };
}
