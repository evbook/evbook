import { z } from "zod";
import { milesToKm, mphToKmh } from "../convert";
import type { TyreReadingLike } from "@shared/tyres";

/**
 * Shape of Tesla's `vehicle_data` payload. Field names are kept exactly as the
 * API sends them so recorded API responses can be used verbatim as test
 * fixtures, and so the mapping code below reads like TeslaMate's.
 * Unknown keys are stripped; every known field is optional and nullable.
 */

const num = z.number().nullish();
const bool = z.boolean().nullish();
const str = z.string().nullish();

const DriveState = z.object({
  timestamp: num,
  latitude: num,
  longitude: num,
  speed: num,
  power: num,
  shift_state: str,
  heading: num,
  active_route_destination: str,
  active_route_latitude: num,
  active_route_longitude: num,
  active_route_miles_to_arrival: num,
  active_route_minutes_to_arrival: num,
  active_route_traffic_minutes_delay: num,
  active_route_energy_at_arrival: num,
});

const ChargeState = z.object({
  timestamp: num,
  charging_state: str,
  battery_level: num,
  usable_battery_level: num,
  battery_range: num,
  est_battery_range: num,
  ideal_battery_range: num,
  charge_energy_added: num,
  charger_actual_current: num,
  charger_phases: num,
  charger_pilot_current: num,
  charger_power: num,
  charger_voltage: num,
  conn_charge_cable: str,
  fast_charger_present: bool,
  fast_charger_brand: str,
  fast_charger_type: str,
  not_enough_power_to_heat: bool,
  battery_heater_on: bool,
  charge_limit_soc: num,
  charge_port_door_open: bool,
  time_to_full_charge: num,
  scheduled_charging_start_time: num,
  charge_rate: num,
  scheduled_charging_pending: bool,
  trip_charging: bool,
});

const ClimateState = z.object({
  timestamp: num,
  outside_temp: num,
  inside_temp: num,
  is_preconditioning: bool,
  climate_keeper_mode: str,
  battery_heater: bool,
  battery_heater_no_power: bool,
  fan_status: num,
  is_climate_on: bool,
  driver_temp_setting: num,
  passenger_temp_setting: num,
  is_rear_defroster_on: bool,
  is_front_defroster_on: bool,
  cabin_overheat_protection: str,
  cabin_overheat_protection_actively_cooling: bool,
  auto_seat_climate_left: bool,
  auto_seat_climate_right: bool,
  auto_steering_wheel_heat: bool,
});

const SoftwareUpdate = z.object({
  status: str,
  version: str,
  download_perc: num,
  install_perc: num,
});

const VehicleStateObj = z.object({
  timestamp: num,
  odometer: num,
  car_version: str,
  locked: bool,
  sentry_mode: bool,
  is_user_present: bool,
  service_mode: bool,
  df: num,
  pf: num,
  dr: num,
  pr: num,
  ft: num,
  rt: num,
  fd_window: num,
  fp_window: num,
  rd_window: num,
  rp_window: num,
  tpms_pressure_fl: num,
  tpms_pressure_fr: num,
  tpms_pressure_rl: num,
  tpms_pressure_rr: num,
  tpms_soft_warning_fl: bool,
  tpms_soft_warning_fr: bool,
  tpms_soft_warning_rl: bool,
  tpms_soft_warning_rr: bool,
  tpms_hard_warning_fl: bool,
  tpms_hard_warning_fr: bool,
  tpms_hard_warning_rl: bool,
  tpms_hard_warning_rr: bool,
  /** The recommended cold pressure for each axle, bar. */
  tpms_rcp_front_value: num,
  tpms_rcp_rear_value: num,
  dashcam_state: str,
  software_update: SoftwareUpdate.nullish(),
});

const VehicleConfig = z.object({
  car_type: str,
  trim_badging: str,
  exterior_color: str,
  wheel_type: str,
  spoiler_type: str,
  car_special_type: str,
});

/**
 * Pack readings `vehicle_data` does not carry. Tesla's own API has nothing on the
 * temperature of the battery — only whether its heater is running — but sources
 * that log the car over CAN or a fleet feed do, and it is what explains a cold
 * session's missing kilowatts. Kept in a block of its own rather than added to
 * the blocks above, so those stay a faithful mirror of the API and a recorded
 * response can still be used verbatim as a fixture.
 */
const PackState = z.object({
  timestamp: num,
  /** Coldest and warmest module, °C. */
  temp_min: num,
  temp_max: num,
});

export const VehicleData = z.object({
  id: num,
  vehicle_id: num,
  vin: str,
  display_name: str,
  state: str,
  drive_state: DriveState.nullish(),
  charge_state: ChargeState.nullish(),
  climate_state: ClimateState.nullish(),
  vehicle_state: VehicleStateObj.nullish(),
  vehicle_config: VehicleConfig.nullish(),
  pack_state: PackState.nullish(),
});

export type VehicleData = z.infer<typeof VehicleData>;

export function parseVehicleData(raw: unknown): VehicleData | null {
  const parsed = VehicleData.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The car's own timestamp for this snapshot, in epoch ms. */
export function snapshotDate(v: VehicleData): number {
  return v.drive_state?.timestamp ?? v.vehicle_state?.timestamp ?? Date.now();
}

export interface PositionAttrs {
  date_at: number;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;
  power: number | null;
  odometer: number | null;
  elevation: number | null;
  ideal_battery_range_km: number | null;
  rated_battery_range_km: number | null;
  est_battery_range_km: number | null;
  battery_level: number | null;
  usable_battery_level: number | null;
  outside_temp: number | null;
  inside_temp: number | null;
  fan_status: number | null;
  driver_temp_setting: number | null;
  passenger_temp_setting: number | null;
  is_climate_on: boolean | null;
  is_rear_defroster_on: boolean | null;
  is_front_defroster_on: boolean | null;
  battery_heater: boolean | null;
  battery_heater_on: boolean | null;
  battery_heater_no_power: boolean | null;
  tpms_pressure_fl: number | null;
  tpms_pressure_fr: number | null;
  tpms_pressure_rl: number | null;
  tpms_pressure_rr: number | null;
}

/** Port of TeslaMate's create_position/2. Telemetry is converted to SI here. */
export function createPosition(v: VehicleData): PositionAttrs {
  const d = v.drive_state;
  const c = v.charge_state;
  const cl = v.climate_state;
  const vs = v.vehicle_state;
  return {
    date_at: snapshotDate(v),
    latitude: d?.latitude ?? null,
    longitude: d?.longitude ?? null,
    speed: mphToKmh(d?.speed),
    power: d?.power ?? null,
    odometer: milesToKm(vs?.odometer, 6),
    // No Tesla endpoint reports altitude. `Repo.enrichElevations` fills this in
    // from a terrain service when the drive closes, which is why it is written
    // null here rather than left out of the row.
    elevation: null,
    ideal_battery_range_km: milesToKm(c?.ideal_battery_range, 2),
    rated_battery_range_km: milesToKm(c?.battery_range, 2),
    est_battery_range_km: milesToKm(c?.est_battery_range, 2),
    battery_level: c?.battery_level ?? null,
    usable_battery_level: c?.usable_battery_level ?? null,
    outside_temp: cl?.outside_temp ?? null,
    inside_temp: cl?.inside_temp ?? null,
    fan_status: cl?.fan_status ?? null,
    driver_temp_setting: cl?.driver_temp_setting ?? null,
    passenger_temp_setting: cl?.passenger_temp_setting ?? null,
    is_climate_on: cl?.is_climate_on ?? null,
    is_rear_defroster_on: cl?.is_rear_defroster_on ?? null,
    is_front_defroster_on: cl?.is_front_defroster_on ?? null,
    battery_heater: cl?.battery_heater ?? null,
    battery_heater_on: c?.battery_heater_on ?? null,
    battery_heater_no_power: cl?.battery_heater_no_power ?? null,
    tpms_pressure_fl: vs?.tpms_pressure_fl ?? null,
    tpms_pressure_fr: vs?.tpms_pressure_fr ?? null,
    tpms_pressure_rl: vs?.tpms_pressure_rl ?? null,
    tpms_pressure_rr: vs?.tpms_pressure_rr ?? null,
  };
}

/**
 * One row of `tyre_readings`: the four pressures, what the car recommends for
 * each axle, and its own warnings — null wherever the car did not say.
 */
export interface TyreAttrs {
  date_at: number;
  pressure_fl: number | null;
  pressure_fr: number | null;
  pressure_rl: number | null;
  pressure_rr: number | null;
  recommended_front: number | null;
  recommended_rear: number | null;
  soft_warning_fl: boolean | null;
  soft_warning_fr: boolean | null;
  soft_warning_rl: boolean | null;
  soft_warning_rr: boolean | null;
  hard_warning_fl: boolean | null;
  hard_warning_fr: boolean | null;
  hard_warning_rl: boolean | null;
  hard_warning_rr: boolean | null;
}

/**
 * The tyre reading in a snapshot, or null when it carries no pressure at all —
 * a response without `vehicle_state`, or a car whose sensors have not woken yet.
 * A row of nothing but nulls would say "read, and unknown", which is not what
 * happened: nothing was read.
 */
export function createTyreReading(v: VehicleData): TyreAttrs | null {
  const vs = v.vehicle_state;
  if (!vs) return null;
  const pressures = [vs.tpms_pressure_fl, vs.tpms_pressure_fr, vs.tpms_pressure_rl, vs.tpms_pressure_rr];
  // Some firmware reports 0 for a tyre whose sensor has not been heard from:
  // that is "unknown", never a flat tyre.
  const bar = (n: number | null | undefined) => (n == null || n <= 0 ? null : Math.round(n * 1000) / 1000);
  if (pressures.every((n) => bar(n) == null)) return null;
  return {
    date_at: snapshotDate(v),
    pressure_fl: bar(vs.tpms_pressure_fl),
    pressure_fr: bar(vs.tpms_pressure_fr),
    pressure_rl: bar(vs.tpms_pressure_rl),
    pressure_rr: bar(vs.tpms_pressure_rr),
    recommended_front: bar(vs.tpms_rcp_front_value),
    recommended_rear: bar(vs.tpms_rcp_rear_value),
    soft_warning_fl: vs.tpms_soft_warning_fl ?? null,
    soft_warning_fr: vs.tpms_soft_warning_fr ?? null,
    soft_warning_rl: vs.tpms_soft_warning_rl ?? null,
    soft_warning_rr: vs.tpms_soft_warning_rr ?? null,
    hard_warning_fl: vs.tpms_hard_warning_fl ?? null,
    hard_warning_fr: vs.tpms_hard_warning_fr ?? null,
    hard_warning_rl: vs.tpms_hard_warning_rl ?? null,
    hard_warning_rr: vs.tpms_hard_warning_rr ?? null,
  };
}

/** A reading in the shape `shared/tyres` decides statuses from. */
export function tyreReadingOf(t: TyreAttrs): TyreReadingLike {
  return {
    fl: t.pressure_fl,
    fr: t.pressure_fr,
    rl: t.pressure_rl,
    rr: t.pressure_rr,
    rcpFront: t.recommended_front,
    rcpRear: t.recommended_rear,
    softFl: t.soft_warning_fl,
    softFr: t.soft_warning_fr,
    softRl: t.soft_warning_rl,
    softRr: t.soft_warning_rr,
    hardFl: t.hard_warning_fl,
    hardFr: t.hard_warning_fr,
    hardRl: t.hard_warning_rl,
    hardRr: t.hard_warning_rr,
  };
}

export interface ChargeAttrs {
  date_at: number;
  battery_heater: boolean | null;
  battery_heater_on: boolean | null;
  battery_heater_no_power: boolean | null;
  battery_level: number | null;
  usable_battery_level: number | null;
  charge_energy_added: number;
  charger_actual_current: number | null;
  charger_phases: number | null;
  charger_pilot_current: number | null;
  charger_power: number;
  charger_voltage: number | null;
  conn_charge_cable: string | null;
  fast_charger_present: boolean | null;
  fast_charger_brand: string | null;
  fast_charger_type: string | null;
  ideal_battery_range_km: number;
  rated_battery_range_km: number | null;
  not_enough_power_to_heat: boolean | null;
  outside_temp: number | null;
  battery_temp_min: number | null;
  battery_temp_max: number | null;
}

/** Port of TeslaMate's insert_charge attrs, plus the pack temperatures TeslaMate has no source for. */
export function createCharge(v: VehicleData): ChargeAttrs {
  const c = v.charge_state;
  const cl = v.climate_state;
  const p = v.pack_state;
  return {
    date_at: c?.timestamp ?? snapshotDate(v),
    battery_heater: cl?.battery_heater ?? null,
    battery_heater_on: c?.battery_heater_on ?? null,
    battery_heater_no_power: cl?.battery_heater_no_power ?? null,
    battery_level: c?.battery_level ?? null,
    usable_battery_level: c?.usable_battery_level ?? null,
    charge_energy_added: c?.charge_energy_added ?? 0,
    charger_actual_current: c?.charger_actual_current ?? null,
    charger_phases: c?.charger_phases ?? null,
    charger_pilot_current: c?.charger_pilot_current ?? null,
    charger_power: c?.charger_power ?? 0,
    charger_voltage: c?.charger_voltage ?? null,
    conn_charge_cable: c?.conn_charge_cable ?? null,
    fast_charger_present: c?.fast_charger_present ?? null,
    fast_charger_brand: c?.fast_charger_brand ?? null,
    fast_charger_type: c?.fast_charger_type ?? null,
    ideal_battery_range_km: milesToKm(c?.ideal_battery_range, 2) ?? 0,
    rated_battery_range_km: milesToKm(c?.battery_range, 2),
    not_enough_power_to_heat: c?.not_enough_power_to_heat ?? null,
    outside_temp: cl?.outside_temp ?? null,
    battery_temp_min: p?.temp_min ?? null,
    battery_temp_max: p?.temp_max ?? null,
  };
}

export interface CarAttrs {
  model: string | null;
  trim_badging: string | null;
  exterior_color: string | null;
  wheel_type: string | null;
  spoiler_type: string | null;
  name: string | null;
}

/** Port of TeslaMate's identify/1 (model letter from car_type). */
export function identify(v: VehicleData): CarAttrs {
  const cfg = v.vehicle_config;
  const carType = cfg?.car_type ?? null;
  const model = carType ? (MODEL_BY_CAR_TYPE[carType.toLowerCase()] ?? null) : null;
  return {
    model,
    trim_badging: cfg?.trim_badging ?? null,
    exterior_color: cfg?.exterior_color ?? null,
    wheel_type: cfg?.wheel_type ?? null,
    spoiler_type: cfg?.spoiler_type ?? null,
    name: v.display_name ?? null,
  };
}

const MODEL_BY_CAR_TYPE: Record<string, string> = {
  models: "S",
  models2: "S",
  modelx: "X",
  model3: "3",
  modely: "Y",
};
