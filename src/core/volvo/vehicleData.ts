import { kmToMiles } from "../convert";
import type { VehicleData } from "../tesla/payload";
import type { Opening, VolvoView } from "./normalize";
import type { MaintenanceDto } from "@shared/api-types";

/**
 * Volvo readings → the `vehicle_data` payload the state machine reads.
 *
 * This is the same move the import adapters make: rather than a second
 * implementation of drive and charge detection, the vendor's readings are
 * expressed in the one shape `core/fsm.ts` already understands, so a Volvo
 * drive is opened, sampled and closed by exactly the rules a Tesla drive is.
 * Units follow Tesla's API (miles, mph) because `createPosition` and
 * `createCharge` convert from it.
 *
 * What Volvo does not report stays absent: speed, power while driving,
 * temperatures, tyre pressures, sleep. Volvo has no gear either; the engine
 * status stands in for it — running is "D", stopped is "P".
 */

export interface VolvoSnapshotContext {
  vin: string;
  /** The poll's own time: every value in the view is the latest known as of it. */
  at: number;
  /** Energy put into the battery since this charging session began, kWh; null outside one. */
  sessionEnergyKwh: number | null;
}

function openNumber(o: Opening | null | undefined): number | null {
  if (o == null) return null;
  return o === "closed" ? 0 : 1;
}

const TESLA_CHARGING: Record<string, string> = {
  charging: "Charging",
  done: "Complete",
  error: "Stopped",
  discharging: "Stopped",
};

function chargingState(view: VolvoView): string | null {
  const status = view.charging?.v;
  const cable = view.cable?.v;
  if (status && TESLA_CHARGING[status]) return TESLA_CHARGING[status]!;
  if (status === "idle" || status === "scheduled") {
    if (cable === "connected") return "Stopped";
    if (cable === "disconnected") return "Disconnected";
    return null;
  }
  if (cable === "disconnected") return "Disconnected";
  return null;
}

export function toVehicleData(view: VolvoView, ctx: VolvoSnapshotContext): VehicleData {
  const engine = view.engineRunning?.v;
  const charging = view.charging?.v === "charging";
  const doors = view.doors?.v;
  const windows = view.windows?.v;
  // Miles only because createPosition converts back from them: kept unrounded
  // so the round trip lands on the kilometres Volvo sent (an EX30's odometer
  // is whole kilometres, and 25408 must not come back as 25407.999999).
  const rangeMi = kmToMiles(view.rangeKm?.v ?? null, 12);
  const dc = view.chargeType?.v === "DC";
  return {
    vin: ctx.vin,
    // Not the model: the state machine writes this over the car's name, and a
    // Volvo's name is set once from its details (volvoPoll) and then the owner's.
    display_name: null,
    state: "online",
    drive_state: {
      timestamp: ctx.at,
      latitude: view.position?.v.lat ?? null,
      longitude: view.position?.v.lon ?? null,
      speed: null,
      power: null,
      shift_state: engine === true ? "D" : engine === false ? "P" : null,
      heading: null,
    },
    charge_state: {
      timestamp: ctx.at,
      charging_state: chargingState(view),
      battery_level: view.soc ? Math.round(view.soc.v) : null,
      usable_battery_level: view.soc ? Math.round(view.soc.v) : null,
      // One range figure exists; it fills both of Tesla's so neither reads 0.
      battery_range: rangeMi,
      est_battery_range: rangeMi,
      ideal_battery_range: rangeMi,
      charge_energy_added: ctx.sessionEnergyKwh,
      charger_power: charging ? (view.powerKw?.v ?? null) : view.powerKw ? 0 : null,
      charger_phases: null,
      charger_voltage: null,
      charger_actual_current: null,
      charger_pilot_current: view.currentLimitA?.v ?? null,
      conn_charge_cable: view.cable?.v === "connected" ? (dc ? "CCS" : "IEC") : view.cable ? "<invalid>" : null,
      fast_charger_present: view.chargeType ? dc : null,
      fast_charger_brand: null,
      fast_charger_type: dc ? "CCS" : null,
      charge_limit_soc: view.targetSoc ? Math.round(view.targetSoc.v) : null,
      // Only while charging: an unplugged EX30 reports one minute to its target.
      time_to_full_charge: charging && view.minutesToTarget ? view.minutesToTarget.v / 60 : null,
    },
    vehicle_state: {
      timestamp: ctx.at,
      odometer: kmToMiles(view.odometerKm?.v ?? null, 12),
      locked: view.locked?.v ?? null,
      df: openNumber(doors?.frontLeft),
      pf: openNumber(doors?.frontRight),
      dr: openNumber(doors?.rearLeft),
      pr: openNumber(doors?.rearRight),
      // Volvo's hood is the front trunk on an EV, its tailgate the rear one.
      ft: openNumber(doors?.hood),
      rt: openNumber(doors?.tailgate),
      fd_window: openNumber(windows?.frontLeft),
      fp_window: openNumber(windows?.frontRight),
      rd_window: openNumber(windows?.rearLeft),
      rp_window: openNumber(windows?.rearRight),
    },
    vehicle_config: {
      car_type: null,
      trim_badging: null,
      exterior_color: view.details?.colour ?? null,
    },
  };
}

/**
 * The maintenance readings for the car summary. Not part of `toVehicleData`:
 * Tesla's payload has no place for them, and the state machine needs none.
 * Null until any of the four endpoints has answered.
 */
export function maintenanceOf(view: VolvoView): MaintenanceDto | null {
  const s = view.service?.v;
  const parts = [
    view.service,
    view.washerFluidWarning,
    view.oilLevelWarning,
    view.coolantLevelWarning,
    view.brakeFluidWarning,
    view.lampFailures,
  ];
  if (parts.every((r) => r == null)) return null;
  return {
    serviceDue: s?.due ?? null,
    serviceReason: s?.reason ?? null,
    serviceDistanceKm: s?.distanceKm ?? null,
    serviceMonths: s?.months ?? null,
    washerFluidWarning: view.washerFluidWarning?.v ?? null,
    oilLevelWarning: view.oilLevelWarning?.v ?? null,
    coolantLevelWarning: view.coolantLevelWarning?.v ?? null,
    brakeFluidWarning: view.brakeFluidWarning?.v ?? null,
    lampFailures: view.lampFailures?.v ?? null,
  };
}
