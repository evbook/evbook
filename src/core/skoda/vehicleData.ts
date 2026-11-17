import { kmToMiles } from "../convert";
import type { VehicleData } from "../tesla/payload";
import { isCharging, type SkodaView } from "./normalize";

/**
 * Škoda readings → the `vehicle_data` payload the state machine reads, as the
 * Volvo bridge does (core/volvo/vehicleData.ts): one implementation of drive and
 * charge detection, fed by every provider in Tesla's shape and units.
 *
 * What Škoda does not report stays absent: speed, power, heading,
 * temperatures, tyres, sleep. There is no gear: the parking position's
 * "parked" or "in motion" stands in for it. That is a hint from the car, not a
 * measured gear, so it is trusted only while it is fresh: a motion reading not
 * confirmed for `MOTION_STALE_MS` (the section kept failing) counts as unknown.
 * Unknown motion reads as parked to the state machine, which closes a drive;
 * a drive whose end Škoda never reported is closed on the odometer it had.
 */

/** Two parked-pace reads missed: the "in motion" a car last said is no longer believable. */
export const MOTION_STALE_MS = 65 * 60_000;

export interface SkodaSnapshotContext {
  vin: string;
  /** The pass's own time: every value in the view is the latest known as of it. */
  at: number;
  /** Energy put into the battery this charging session, kWh, integrated from the reported power; null outside one. */
  sessionEnergyKwh: number | null;
  /**
   * Where a drive started from, for the first read that finds the car moving:
   * Škoda gives no position in motion, and the last parked one is where it left.
   */
  departedFrom?: { lat: number; lon: number } | null;
}

function chargingState(view: SkodaView, charging: boolean): string | null {
  if (charging) return "Charging";
  const plug = view.plug?.v;
  if (plug === "disconnected") return "Disconnected";
  if (plug === "connected") {
    const soc = view.soc?.v;
    const target = view.targetSoc?.v;
    return soc != null && target != null && soc >= target ? "Complete" : "Stopped";
  }
  // No plug field (a car or a firmware from before API 1.1.0): Škoda's own
  // rule is that a disconnected plug is always CONNECT_CABLE.
  if (view.chargeState?.v === "CONNECT_CABLE") return "Disconnected";
  return null;
}

function shiftState(view: SkodaView, at: number): string | null {
  const motion = view.motion;
  if (!motion || at - motion.seen > MOTION_STALE_MS) return null;
  return motion.v === "moving" ? "D" : "P";
}

function flag(b: boolean | null | undefined): number | null {
  return b == null ? null : b ? 1 : 0;
}

export function toVehicleData(view: SkodaView, ctx: SkodaSnapshotContext): VehicleData {
  const charging = isCharging(view);
  const dc = view.chargeType?.v === "DC";
  const plugged = view.plug?.v === "connected" || charging;
  // Kept unrounded so the round trip through createPosition lands on Škoda's whole kilometres.
  const rangeMi = kmToMiles(view.rangeKm?.v ?? null, 12);
  const shift = shiftState(view, ctx.at);
  const position = view.position?.v ?? (shift === "D" ? (ctx.departedFrom ?? null) : null);
  const soc = view.soc ? Math.round(view.soc.v) : null;
  return {
    vin: ctx.vin,
    // The state machine writes this over the car's name; a Škoda's is set from `info` by the poller.
    display_name: null,
    state: "online",
    drive_state: {
      timestamp: ctx.at,
      latitude: position?.lat ?? null,
      longitude: position?.lon ?? null,
      speed: null,
      power: null,
      shift_state: shift,
      heading: null,
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
      charge_energy_added: ctx.sessionEnergyKwh,
      // While charging with no power field (seen on a PHEV), the power is unknown, not 0.
      charger_power: charging ? (view.powerKw?.v ?? null) : view.powerKw ? 0 : null,
      charger_phases: null,
      charger_voltage: null,
      charger_actual_current: null,
      charger_pilot_current: null,
      conn_charge_cable: plugged ? (dc ? "CCS" : "IEC") : view.plug ? "<invalid>" : null,
      fast_charger_present: view.chargeType && view.chargeType.v !== "OFF" ? dc : null,
      fast_charger_brand: null,
      fast_charger_type: dc ? "CCS" : null,
      charge_limit_soc: view.targetSoc ? Math.round(view.targetSoc.v) : null,
      // A prediction, and only meaningful while charging.
      time_to_full_charge: charging && view.minutesToFull ? view.minutesToFull.v / 60 : null,
    },
    vehicle_state: {
      timestamp: ctx.at,
      odometer: kmToMiles(view.odometerKm?.v ?? null, 12),
      locked: view.locked?.v ?? null,
      // Škoda reports the doors and windows together, not one by one: an open
      // door shows on the driver's, which is what a "door open" row reads.
      df: flag(view.doorsOpen?.v),
      fd_window: flag(view.windowsOpen?.v),
      ft: flag(view.bonnetOpen?.v),
      rt: flag(view.trunkOpen?.v),
    },
    vehicle_config: {
      car_type: null,
      trim_badging: null,
      exterior_color: null,
    },
  };
}
