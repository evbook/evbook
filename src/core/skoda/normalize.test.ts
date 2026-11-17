import { describe, expect, it } from "bun:test";
import { elroq, vehicleResponse } from "../../../test/fake-skoda";
import { fingerprint, isCharging, mergeView, normalize, sectionError } from "./normalize";

const ALL = new Set(["info", "status", "charging", "odometer", "parkingPosition"]);
const T = 1_700_000_000_000;

describe("normalize", () => {
  it("reads a parked Elroq", () => {
    const { vin, patch, sections } = normalize(vehicleResponse(elroq({ at: T }), ALL), T);
    expect(vin).toBe("TMBJC7NY0SF000001");
    expect(patch.name?.v).toBe("Elroq");
    expect(patch.soc).toEqual({ v: 52, at: T, seen: T });
    expect(patch.rangeKm?.v).toBe(248);
    expect(patch.plug?.v).toBe("disconnected");
    expect(patch.odometerKm?.v).toBe(8_412);
    expect(patch.motion?.v).toBe("parked");
    expect(patch.position?.v).toEqual({ lat: 50.0755, lon: 14.4378 });
    expect(patch.locked?.v).toBe(true);
    expect(sections).toMatchObject({ charging: "available", odometer: "available", parkingPosition: "available" });
  });

  it("keeps the whole charging block when the state is one it does not know", () => {
    // The Elroq of 7 Nov 2026: CHARGING_ERROR with a connected plug, 0 kW and a valid 52 %.
    const body = {
      vehicle: {
        vin: "TMBJC7NY0SF000001",
        charging: {
          isVehicleInSavedLocation: false,
          carCapturedTimestamp: "2026-11-07T07:28:53Z",
          status: {
            battery: { remainingCruisingRangeInMeters: 248000, stateOfChargeInPercent: 52 },
            chargePowerInKw: 0.0,
            chargingErrorReason: "ERROR_CHARGING_SYSTEM",
            plugConnectionState: "CONNECTED",
            plugLockState: "UNLOCKED",
            state: "CHARGING_ERROR",
          },
          settings: { targetStateOfChargeInPercent: 100 },
        },
      },
      errors: [],
    };
    const { patch } = normalize(body, T);
    expect(patch.soc?.v).toBe(52);
    expect(patch.chargeState?.v).toBe("CHARGING_ERROR");
    expect(patch.plug?.v).toBe("connected");
    expect(patch.plugLocked?.v).toBe(false);
    expect(isCharging(patch)).toBe(false);
  });

  it("leaves a section that failed alone instead of clearing it", () => {
    const first = normalize(vehicleResponse(elroq({ at: T }), ALL), T);
    const second = normalize(vehicleResponse(elroq({ at: T, soc: 40 }), ALL, ["CHARGING_UNAVAILABLE"]), T + 1);
    expect(second.sections.charging).toBe("unavailable");
    expect("soc" in second.patch).toBe(false);
    const view = mergeView(first.patch, second.patch);
    expect(view.soc?.v).toBe(52);
  });

  it("keeps the error types it does not know, and ignores the harmless ones", () => {
    const body = { vehicle: { vin: "V" }, errors: [{ type: "RENDER_UNAVAILABLE" }, { type: "BRAND_NEW_THING" }] };
    expect(normalize(body, T).unknownErrors).toEqual(["BRAND_NEW_THING"]);
    expect(sectionError("PARKING_POSITION_DISABLED")).toEqual({ section: "parkingPosition", state: "disabled" });
    expect(sectionError("RENDER_UNAVAILABLE")).toBeNull();
  });

  it("gives no position while in motion, and refuses 0,0", () => {
    const moving = normalize(vehicleResponse(elroq({ parking: "IN_MOTION" }), ALL), T);
    expect(moving.patch.motion?.v).toBe("moving");
    expect(moving.patch.position).toBeNull();
    const nowhere = normalize(vehicleResponse(elroq({ lat: 0, lon: 0 }), ALL), T);
    expect(nowhere.patch.position).toBeNull();
  });

  it("treats an omitted charging state as unknown, and a missing power while charging as unknown power", () => {
    const quiet = normalize(vehicleResponse(elroq({ state: null, plug: "CONNECTED" }), ALL), T);
    expect(quiet.patch.chargeState).toBeNull();
    expect(isCharging(quiet.patch)).toBe(false);
    const phev = normalize(vehicleResponse(elroq({ state: "CHARGING", plug: "CONNECTED", powerKw: null }), ALL), T);
    expect(phev.patch.powerKw).toBeNull();
    expect(isCharging(phev.patch)).toBe(true);
  });
});

describe("isCharging", () => {
  it("does not count CONSERVING alone, but does count power flowing", () => {
    const base = elroq({ plug: "CONNECTED", state: "CONSERVING", powerKw: 0 });
    expect(isCharging(normalize(vehicleResponse(base, ALL), T).patch)).toBe(false);
    expect(isCharging(normalize(vehicleResponse({ ...base, powerKw: 1.2 }, ALL), T).patch)).toBe(true);
    // A disconnected plug wins over a stale power figure.
    expect(isCharging(normalize(vehicleResponse({ ...base, plug: "DISCONNECTED", powerKw: 3 }, ALL), T).patch)).toBe(
      false,
    );
  });
});

describe("fingerprint", () => {
  it("ignores the capture times, so an unchanged car is one stored answer", async () => {
    const a = vehicleResponse(elroq({ at: T }), ALL);
    const b = vehicleResponse(elroq({ at: T + 60_000 }), ALL);
    const c = vehicleResponse(elroq({ at: T, soc: 51 }), ALL);
    expect(await fingerprint(a)).toBe(await fingerprint(b));
    expect(await fingerprint(a)).not.toBe(await fingerprint(c));
  });
});
