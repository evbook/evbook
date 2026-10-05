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

/**
 * The synthetic origin position for a drive whose start went unobserved, or
 * null when there is nothing to reconstruct (no parked point, no odometer on
 * either side, a gap too small to matter or too large to trust).
 */
export function estimateDriveOrigin(
  parked: ParkedPoint | null | undefined,
  first: FirstSample,
): PositionAttrs | null {
  if (!parked || parked.latitude == null || parked.longitude == null) return null;
  if (parked.odometer == null || first.odometer == null) return null;

  const gapKm = first.odometer - parked.odometer;
  if (gapKm < MIN_GAP_KM || gapKm > MAX_GAP_KM) return null;
  if (first.date_at - parked.date_at < MIN_SPAN_MS) return null;

  const speedKmh = Math.max(first.speed ?? 0, ASSUMED_MIN_SPEED_KMH);
  const estimateMs = (gapKm / speedKmh) * 3_600_000;
  const backdateMs = Math.min(
    Math.max(estimateMs, MARGIN_MS),
    MAX_BACKDATE_MS,
    first.date_at - parked.date_at - MARGIN_MS,
  );

  return {
    date_at: first.date_at - Math.round(backdateMs),
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
