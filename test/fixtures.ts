import type { VehicleData } from "../src/core/tesla/payload";

/**
 * Synthetic `vehicle_data` payloads in Tesla's own wire shape. Ranges/odometer
 * are miles and speed is mph, exactly as the API reports them.
 */

interface Overrides {
  at?: number;
  shiftState?: string | null;
  speed?: number | null;
  power?: number | null;
  odometer?: number;
  batteryLevel?: number;
  usableBatteryLevel?: number;
  idealRange?: number;
  ratedRange?: number;
  chargingState?: string | null;
  chargerPower?: number;
  chargerVoltage?: number;
  chargerActualCurrent?: number;
  chargerPhases?: number | null;
  chargeEnergyAdded?: number;
  fastChargerType?: string | null;
  locked?: boolean;
  sentryMode?: boolean;
  isUserPresent?: boolean;
  isPreconditioning?: boolean;
  climateKeeperMode?: string | null;
  doorOpen?: boolean;
  trunkOpen?: boolean;
  updateStatus?: string | null;
  downloadPerc?: number | null;
  carVersion?: string;
  latitude?: number;
  longitude?: number;
  tpmsSoftWarningRl?: boolean;
  dashcamState?: string | null;
  scheduledChargingPending?: boolean;
  cabinOverheatProtection?: string | null;
  activeRouteDestination?: string | null;
  activeRouteMilesToArrival?: number;
  activeRouteMinutesToArrival?: number;
}

export function vehicleData(o: Overrides = {}): VehicleData {
  const at = o.at ?? 1_700_000_000_000;
  return {
    id: 1234,
    vehicle_id: 5678,
    vin: "5YJ3E1EA7KF000001",
    display_name: "Bro",
    state: "online",
    drive_state: {
      timestamp: at,
      latitude: o.latitude ?? 52.52,
      longitude: o.longitude ?? 13.405,
      speed: o.speed ?? null,
      power: o.power ?? 0,
      shift_state: o.shiftState ?? null,
      heading: 90,
      active_route_destination: o.activeRouteDestination ?? null,
      active_route_latitude: o.activeRouteDestination ? 52.54 : null,
      active_route_longitude: o.activeRouteDestination ? 13.43 : null,
      active_route_miles_to_arrival: o.activeRouteDestination ? (o.activeRouteMilesToArrival ?? 4.6) : null,
      active_route_minutes_to_arrival: o.activeRouteDestination ? (o.activeRouteMinutesToArrival ?? 12.4) : null,
      active_route_traffic_minutes_delay: o.activeRouteDestination ? 2 : null,
      active_route_energy_at_arrival: o.activeRouteDestination ? 55 : null,
    },
    charge_state: {
      timestamp: at,
      charging_state: o.chargingState ?? "Disconnected",
      battery_level: o.batteryLevel ?? 70,
      usable_battery_level: o.usableBatteryLevel ?? o.batteryLevel ?? 70,
      battery_range: o.ratedRange ?? 180,
      est_battery_range: 170,
      ideal_battery_range: o.idealRange ?? 200,
      charge_energy_added: o.chargeEnergyAdded ?? 0,
      charger_actual_current: o.chargerActualCurrent ?? 0,
      charger_phases: o.chargerPhases === undefined ? null : o.chargerPhases,
      charger_pilot_current: 16,
      charger_power: o.chargerPower ?? 0,
      charger_voltage: o.chargerVoltage ?? 0,
      conn_charge_cable: "IEC",
      fast_charger_present: false,
      fast_charger_brand: "<invalid>",
      fast_charger_type: o.fastChargerType ?? "<invalid>",
      not_enough_power_to_heat: false,
      battery_heater_on: false,
      charge_limit_soc: 80,
      charge_port_door_open: false,
      time_to_full_charge: 0,
      scheduled_charging_start_time: null,
      charge_rate: o.chargingState === "Charging" ? 29.4 : 0,
      scheduled_charging_pending: o.scheduledChargingPending ?? false,
      trip_charging: false,
    },
    climate_state: {
      timestamp: at,
      outside_temp: 12.5,
      inside_temp: 21,
      is_preconditioning: o.isPreconditioning ?? false,
      climate_keeper_mode: o.climateKeeperMode ?? "off",
      battery_heater: false,
      battery_heater_no_power: false,
      fan_status: 0,
      is_climate_on: false,
      driver_temp_setting: 21,
      passenger_temp_setting: 21,
      is_rear_defroster_on: false,
      is_front_defroster_on: false,
      cabin_overheat_protection: o.cabinOverheatProtection ?? "On",
      cabin_overheat_protection_actively_cooling: false,
      auto_seat_climate_left: true,
      auto_seat_climate_right: false,
      auto_steering_wheel_heat: false,
    },
    vehicle_state: {
      timestamp: at,
      odometer: o.odometer ?? 10_000,
      car_version: o.carVersion ?? "2024.8.9 abc",
      locked: o.locked ?? true,
      sentry_mode: o.sentryMode ?? false,
      is_user_present: o.isUserPresent ?? false,
      service_mode: false,
      df: o.doorOpen ? 1 : 0,
      pf: 0,
      dr: 0,
      pr: 0,
      ft: o.trunkOpen ? 1 : 0,
      rt: 0,
      fd_window: 0,
      fp_window: 0,
      rd_window: 0,
      rp_window: 0,
      tpms_pressure_fl: 2.9,
      tpms_pressure_fr: 2.9,
      tpms_pressure_rl: 2.9,
      tpms_pressure_rr: 2.9,
      tpms_soft_warning_fl: false,
      tpms_soft_warning_fr: false,
      tpms_soft_warning_rl: o.tpmsSoftWarningRl ?? false,
      tpms_soft_warning_rr: false,
      dashcam_state: o.dashcamState ?? "Recording",
      software_update:
        o.updateStatus === undefined
          ? { status: "", version: "", download_perc: 0, install_perc: 0 }
          : {
              status: o.updateStatus,
              version: "2024.20.1",
              download_perc: o.downloadPerc ?? 0,
              install_perc: 0,
            },
    },
    vehicle_config: {
      car_type: "model3",
      trim_badging: "74d",
      exterior_color: "MidnightSilver",
      wheel_type: "Pinwheel18",
      spoiler_type: "None",
      car_special_type: "base",
    },
  };
}

export const driving = (o: Overrides = {}) => vehicleData({ shiftState: "D", speed: 30, power: 20, ...o });
export const parked = (o: Overrides = {}) => vehicleData({ shiftState: null, speed: null, power: 0, ...o });
export const charging = (o: Overrides = {}) =>
  vehicleData({
    chargingState: "Charging",
    chargerPower: 11,
    chargerVoltage: 230,
    chargerActualCurrent: 16,
    chargerPhases: 3,
    ...o,
  });
