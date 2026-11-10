import { describe, expect, it } from "bun:test";
import { driving, parked } from "../../../test/fixtures";
import { parseVehicleData } from "./payload";

/**
 * The schema mirrors Tesla's wire shape with every field optional, so the one
 * regression that matters is a payload failing to parse — an old firmware
 * missing the newer fields must ingest exactly as it did before they existed.
 */

describe("parseVehicleData", () => {
  it("round-trips the diagnostic fields", () => {
    const v = parseVehicleData(driving({ activeRouteDestination: "Depot", tpmsSoftWarningRl: true }));
    expect(v).not.toBeNull();
    expect(v!.drive_state).toMatchObject({
      active_route_destination: "Depot",
      active_route_minutes_to_arrival: 12.4,
      active_route_traffic_minutes_delay: 2,
    });
    expect(v!.charge_state).toMatchObject({ scheduled_charging_pending: false, trip_charging: false });
    expect(v!.climate_state).toMatchObject({
      cabin_overheat_protection: "On",
      auto_seat_climate_left: true,
      auto_steering_wheel_heat: false,
    });
    expect(v!.vehicle_state).toMatchObject({ dashcam_state: "Recording", tpms_soft_warning_rl: true });
  });

  it("parses a payload from firmware that predates the diagnostic fields", () => {
    const raw = JSON.parse(JSON.stringify(parked())) as {
      drive_state: Record<string, unknown>;
      charge_state: Record<string, unknown>;
      climate_state: Record<string, unknown>;
      vehicle_state: Record<string, unknown>;
    };
    for (const key of Object.keys(raw.drive_state)) {
      if (key.startsWith("active_route_")) delete raw.drive_state[key];
    }
    for (const key of ["charge_rate", "scheduled_charging_pending", "trip_charging"]) {
      delete raw.charge_state[key];
    }
    for (const key of [
      "cabin_overheat_protection",
      "cabin_overheat_protection_actively_cooling",
      "auto_seat_climate_left",
      "auto_seat_climate_right",
      "auto_steering_wheel_heat",
    ]) {
      delete raw.climate_state[key];
    }
    delete raw.vehicle_state.dashcam_state;

    const v = parseVehicleData(raw);
    expect(v).not.toBeNull();
    expect(v!.vehicle_state?.odometer).toBe(10_000);
  });

  it("parses the barest payload a car can send", () => {
    const v = parseVehicleData({ id: 1, vehicle_id: 2, vin: "VIN1", display_name: null, state: "online" });
    expect(v).not.toBeNull();
  });
});
