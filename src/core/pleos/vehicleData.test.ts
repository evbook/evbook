import { describe, expect, it } from "bun:test";
import { ioniq5, readResponse, type FakePleosCar } from "../../../test/fake-pleos";
import { READS } from "./api";
import { mergeView, MOTION_STALE_MS, normalize, type PleosView } from "./normalize";
import { toVehicleData } from "./vehicleData";

const T = Date.UTC(2026, 10, 18, 10, 0, 0);

function viewOf(car: FakePleosCar): PleosView {
  let view: PleosView = {};
  for (const endpoint of READS) {
    view = mergeView(view, normalize(endpoint, { data: readResponse(endpoint, car), meta: {} }, T).patch);
  }
  return view;
}

const data = (car: Partial<FakePleosCar>, at = T) =>
  toVehicleData(viewOf(ioniq5({ sentAt: T, ...car })), { vin: "V", at });

describe("toVehicleData", () => {
  it("parks a car in P, with its position, range, odometer and charge limit in Tesla's units", () => {
    const v = data({});
    expect(v.drive_state?.shift_state).toBe("P");
    expect(v.drive_state?.latitude).toBe(52.3702);
    expect(v.drive_state?.speed).toBe(0);
    expect(v.charge_state?.battery_level).toBe(64);
    expect(v.charge_state?.charging_state).toBe("Disconnected");
    expect(v.charge_state?.charge_limit_soc).toBe(80);
    expect((v.charge_state?.battery_range ?? 0) * 1.609344).toBeCloseTo(301, 6);
    expect((v.vehicle_state?.odometer ?? 0) * 1.609344).toBeCloseTo(23_418.6, 6);
  });

  it("drives with P released and the car ready, with speed and heading while the upload is fresh", () => {
    const v = data({ parked: false, ign3: "on", ignition: "on", speedKph: 80, heading: 270 });
    expect(v.drive_state?.shift_state).toBe("D");
    expect((v.drive_state?.speed ?? 0) * 1.609344).toBeCloseTo(80, 6);
    expect(v.drive_state?.heading).toBe(270);
    const stale = data({ parked: false, ign3: "on", speedKph: 80 }, T + MOTION_STALE_MS + 1);
    expect(stale.drive_state?.shift_state).toBeNull();
    expect(stale.drive_state?.speed).toBeNull();
  });

  it("charges with no power and no energy figure, rather than a guessed one", () => {
    const v = data({ plugin: "connected", status: "fastCharging", charging: true, remainTime: 25 });
    expect(v.charge_state).toMatchObject({
      charging_state: "Charging",
      charger_power: null,
      charge_energy_added: null,
      fast_charger_present: true,
      conn_charge_cable: "CCS",
      charge_limit_soc: 90,
    });
    expect(v.charge_state?.time_to_full_charge).toBeCloseTo(25 / 60, 9);
  });

  it("is plugged but not charging while scheduled or powering a load, and complete at the limit", () => {
    expect(data({ plugin: "connected", status: "reservedCharging" }).charge_state?.charging_state).toBe("Stopped");
    expect(data({ plugin: "connected", status: "v2lOperating", charging: false }).charge_state?.charging_state).toBe(
      "Stopped",
    );
    expect(data({ plugin: "connected", soc: 80 }).charge_state?.charging_state).toBe("Complete");
    // remainTime 0 outside a charge is "none", not "done".
    expect(data({ plugin: "connected" }).charge_state?.time_to_full_charge).toBeNull();
  });
});
