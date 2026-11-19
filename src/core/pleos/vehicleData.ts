import { kmToMiles } from "../convert";
import type { VehicleData } from "../tesla/payload";
import { chargeLimit, fresh, isCharging, isDriving, MOTION_STALE_MS, type PleosView } from "./normalize";

/**
 * Pleos readings → the `vehicle_data` payload the state machine reads: one
 * implementation of drive and charge detection, fed by every provider in
 * Tesla's shape and units.
 *
 * - **Gear.** P selected or not, from `driving`, stands in for it, and only
 *   while the car's upload is fresh (`isDriving`): a "not in P" the car sent
 *   twenty minutes ago is no drive. Unknown reads as parked to the state
 *   machine, which closes a drive on the odometer it had.
 * - **Speed and heading** come with a position upload and are passed on only
 *   while that upload is fresh; an old position is still where the car is.
 * - **Charging power and energy** do not exist in the API. Both stay null:
 *   the energy a charge added is unknown, never state of charge times a
 *   capacity (whose unit Pleos does not even state).
 */

export interface PleosSnapshotContext {
  vin: string;
  /** The pass's own time: every value in the view is the latest known as of it. */
  at: number;
}

function chargingState(view: PleosView, charging: boolean): string | null {
  if (charging) return "Charging";
  const plug = view.plug?.v;
  if (plug === "disconnected") return "Disconnected";
  if (plug === "connected") {
    const soc = view.soc?.v;
    const limit = chargeLimit(view);
    return soc != null && limit != null && soc >= limit ? "Complete" : "Stopped";
  }
  return null;
}

function shiftState(view: PleosView, at: number): string | null {
  if (isDriving(view, at)) return "D";
  if (fresh(view.inPark, at, MOTION_STALE_MS) && view.inPark?.v === true) return "P";
  return null;
}

export function toVehicleData(view: PleosView, ctx: PleosSnapshotContext): VehicleData {
  const charging = isCharging(view, ctx.at);
  const dc = charging && view.dc?.v === true;
  const plugged = view.plug?.v === "connected" || charging;
  // Kept unrounded so the round trip through createPosition lands on Pleos's figures.
  const rangeMi = kmToMiles(view.rangeKm?.v ?? null, 12);
  const moving = fresh(view.speedKmh, ctx.at, MOTION_STALE_MS);
  const soc = view.soc ? Math.round(view.soc.v) : null;
  const limit = chargeLimit(view);
  return {
    vin: ctx.vin,
    // The state machine writes this over the car's name; a Pleos car's is set from the consent list.
    display_name: null,
    state: "online",
    drive_state: {
      timestamp: ctx.at,
      latitude: view.position?.v.lat ?? null,
      longitude: view.position?.v.lon ?? null,
      speed: moving ? kmToMiles(view.speedKmh?.v ?? null, 12) : null,
      power: null,
      shift_state: shiftState(view, ctx.at),
      heading: moving ? (view.heading?.v ?? null) : null,
    },
    charge_state: {
      timestamp: ctx.at,
      charging_state: chargingState(view, charging),
      battery_level: soc,
      usable_battery_level: soc,
      // One range figure exists; it fills all three of Tesla's so none reads 0.
      battery_range: rangeMi,
      est_battery_range: rangeMi,
      ideal_battery_range: rangeMi,
      charge_energy_added: null,
      charger_power: null,
      charger_phases: null,
      charger_voltage: null,
      charger_actual_current: null,
      charger_pilot_current: null,
      conn_charge_cable: plugged ? (dc ? "CCS" : "IEC") : view.plug ? "<invalid>" : null,
      fast_charger_present: charging ? dc : view.plug ? false : null,
      fast_charger_brand: null,
      fast_charger_type: dc ? "CCS" : null,
      charge_limit_soc: limit !== null ? Math.round(limit) : null,
      // A prediction, and only meaningful while charging: 0 outside a charge means "none", not "done".
      time_to_full_charge: charging && view.minutesLeft ? view.minutesLeft.v / 60 : null,
    },
    vehicle_state: {
      timestamp: ctx.at,
      odometer: kmToMiles(view.odometerKm?.v ?? null, 12),
      locked: null,
    },
    vehicle_config: {
      car_type: null,
      trim_badging: null,
      exterior_color: null,
    },
  };
}
