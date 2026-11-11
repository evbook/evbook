import { describe, expect, it } from "bun:test";
import { createCharge, createPosition, parseVehicleData } from "../tesla/payload";
import type { VolvoView } from "./normalize";
import { toVehicleData } from "./vehicleData";

const AT = 1_760_000_000_000;
const r = <T>(v: T) => ({ v, at: AT - 1000 });

describe("toVehicleData", () => {
  it("expresses a Volvo drive in the shape the state machine reads", () => {
    const view: VolvoView = {
      engineRunning: r(true),
      soc: r(61.6),
      rangeKm: r(250),
      odometerKm: r(12_345.6),
      position: r({ lat: 52.52, lon: 13.405, alt: 34 }),
    };
    const v = toVehicleData(view, { vin: "V", at: AT, sessionEnergyKwh: null });
    expect(parseVehicleData(v)).not.toBeNull();
    expect(v.drive_state?.shift_state).toBe("D");
    const position = createPosition(v);
    expect(position.date_at).toBe(AT);
    expect(position.odometer).toBeCloseTo(12_345.6, 3);
    expect(position.battery_level).toBe(62);
    expect(position.rated_battery_range_km).toBeCloseTo(250, 1);
    expect(position.latitude).toBe(52.52);
    // What Volvo does not report stays unknown.
    expect(position.speed).toBeNull();
    expect(position.power).toBeNull();
    expect(position.outside_temp).toBeNull();
  });

  it("parks on a stopped engine, and knows nothing when the engine status is unknown", () => {
    expect(
      toVehicleData({ engineRunning: r(false) }, { vin: "V", at: AT, sessionEnergyKwh: null }).drive_state?.shift_state,
    ).toBe("P");
    expect(toVehicleData({}, { vin: "V", at: AT, sessionEnergyKwh: null }).drive_state?.shift_state).toBeNull();
  });

  it("expresses a DC charge, with the session's integrated energy", () => {
    const view: VolvoView = {
      charging: r("charging"),
      cable: r("connected"),
      chargeType: r("DC"),
      powerKw: r(120),
      soc: r(40),
      targetSoc: r(80),
      minutesToTarget: r(30),
    };
    const v = toVehicleData(view, { vin: "V", at: AT, sessionEnergyKwh: 12.5 });
    expect(v.charge_state?.charging_state).toBe("Charging");
    expect(v.charge_state?.charge_limit_soc).toBe(80);
    expect(v.charge_state?.time_to_full_charge).toBe(0.5);
    const charge = createCharge(v);
    expect(charge.charger_power).toBe(120);
    expect(charge.charge_energy_added).toBe(12.5);
    expect(charge.fast_charger_present).toBe(true);
    expect(charge.charger_phases).toBeNull();
  });

  it("maps a finished, an idle and an unplugged car to Tesla's words", () => {
    const at = { vin: "V", at: AT, sessionEnergyKwh: 3 };
    expect(toVehicleData({ charging: r("done"), cable: r("connected") }, at).charge_state?.charging_state).toBe(
      "Complete",
    );
    expect(toVehicleData({ charging: r("idle"), cable: r("connected") }, at).charge_state?.charging_state).toBe(
      "Stopped",
    );
    expect(toVehicleData({ charging: r("idle"), cable: r("disconnected") }, at).charge_state?.charging_state).toBe(
      "Disconnected",
    );
    expect(toVehicleData({ charging: r("idle") }, at).charge_state?.charging_state).toBeNull();
  });

  it("reads open doors and windows as Tesla's numbers, unknown as null", () => {
    const v = toVehicleData(
      {
        doors: r({
          frontLeft: "open",
          frontRight: "closed",
          rearLeft: null,
          rearRight: "ajar",
          hood: null,
          tailgate: "closed",
        }),
        locked: r(false),
      },
      { vin: "V", at: AT, sessionEnergyKwh: null },
    );
    expect(v.vehicle_state).toMatchObject({ df: 1, pf: 0, dr: null, pr: 1, ft: null, rt: 0, locked: false });
  });
});
