import { describe, expect, it } from "bun:test";
import { elroq, vehicleResponse } from "../../../test/fake-skoda";
import { milesToKm } from "../convert";
import { normalize, type SkodaView } from "./normalize";
import { MOTION_STALE_MS, toVehicleData } from "./vehicleData";

const ALL = new Set(["info", "status", "charging", "odometer", "parkingPosition"]);
const AT = 1_700_000_000_000;

function view(overrides: Parameters<typeof elroq>[0] = {}): SkodaView {
  return normalize(vehicleResponse(elroq(overrides), ALL), AT).patch;
}

describe("toVehicleData", () => {
  it("expresses a parked Škoda in Tesla's units", () => {
    const v = toVehicleData(view(), { vin: "V", at: AT, sessionEnergyKwh: null });
    expect(v.drive_state?.shift_state).toBe("P");
    expect(v.drive_state?.speed).toBeNull();
    expect(v.drive_state?.latitude).toBe(50.0755);
    expect(v.charge_state?.battery_level).toBe(52);
    expect(v.charge_state?.charging_state).toBe("Disconnected");
    expect(v.charge_state?.charge_limit_soc).toBe(80);
    expect(milesToKm(v.vehicle_state!.odometer!, 6)).toBeCloseTo(8_412, 6);
    expect(milesToKm(v.charge_state!.battery_range!, 6)).toBeCloseTo(248, 6);
  });

  it("is driving while the car says it is in motion, starting from where it was parked", () => {
    const v = toVehicleData(view({ parking: "IN_MOTION" }), {
      vin: "V",
      at: AT,
      sessionEnergyKwh: null,
      departedFrom: { lat: 1, lon: 2 },
    });
    expect(v.drive_state?.shift_state).toBe("D");
    expect(v.drive_state?.latitude).toBe(1);
    const later = toVehicleData(view({ parking: "IN_MOTION" }), { vin: "V", at: AT, sessionEnergyKwh: null });
    expect(later.drive_state?.latitude).toBeNull();
  });

  it("stops believing an old 'in motion'", () => {
    const v = toVehicleData(view({ parking: "IN_MOTION" }), {
      vin: "V",
      at: AT + MOTION_STALE_MS + 1,
      sessionEnergyKwh: null,
    });
    expect(v.drive_state?.shift_state).toBeNull();
  });

  it("charges with power, energy and time to full; unknown power stays unknown", () => {
    const charging = toVehicleData(
      view({ state: "CHARGING", plug: "CONNECTED", chargeType: "DC", powerKw: 95, minutesToFull: 30 }),
      { vin: "V", at: AT, sessionEnergyKwh: 7.5 },
    );
    expect(charging.charge_state).toMatchObject({
      charging_state: "Charging",
      charger_power: 95,
      charge_energy_added: 7.5,
      fast_charger_present: true,
      time_to_full_charge: 0.5,
    });
    const phev = toVehicleData(view({ state: "CHARGING", plug: "CONNECTED", powerKw: null }), {
      vin: "V",
      at: AT,
      sessionEnergyKwh: null,
    });
    expect(phev.charge_state?.charger_power).toBeNull();
  });

  it("is plugged in and done at the target, plugged in and stopped below it", () => {
    const full = toVehicleData(view({ state: "READY_FOR_CHARGING", plug: "CONNECTED", soc: 80 }), {
      vin: "V",
      at: AT,
      sessionEnergyKwh: null,
    });
    expect(full.charge_state?.charging_state).toBe("Complete");
    const waiting = toVehicleData(view({ state: null, plug: "CONNECTED", soc: 60 }), {
      vin: "V",
      at: AT,
      sessionEnergyKwh: null,
    });
    expect(waiting.charge_state?.charging_state).toBe("Stopped");
  });
});
