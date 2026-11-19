import { describe, expect, it } from "bun:test";
import { ioniq5, readResponse } from "../../../test/fake-pleos";
import {
  CHARGE_STALE_MS,
  FUTURE_TOLERANCE_MS,
  MOTION_STALE_MS,
  OWNED,
  ageMs,
  chargeLimit,
  isCharging,
  isDriving,
  mergeView,
  normalize,
  type PleosView,
} from "./normalize";

const T = Date.UTC(2026, 10, 18, 10, 0, 0);
const answer = (data: unknown) => ({ data, meta: { success: true, timestamp: "2026-11-18T10:00:00Z" } });
const at = (ms: number) => new Date(ms).toISOString();

describe("normalize", () => {
  it("reads the batteries answer, with the car's own time", () => {
    const n = normalize("batteries", answer(readResponse("batteries", ioniq5({ sentAt: T - 60_000 }))), T);
    expect(n.sentAt).toBe(T - 60_000);
    expect(n.patch.soc).toEqual({ v: 64, at: T - 60_000, seen: T });
    expect(n.patch.plug?.v).toBe("disconnected");
    expect(n.patch.activity?.v).toBe("idle");
    expect(n.patch.targetAc?.v).toBe(80);
    expect(n.patch.targetDc?.v).toBe(90);
    expect(n.unknown).toEqual([]);
  });

  it("keeps a state of charge of 0, and takes 255 or a sentinel for unknown, never clamped", () => {
    const soc = (v: unknown) => normalize("batteries", answer({ charge: { stateOfCharge: v } }), T).patch.soc;
    expect(soc(0)?.v).toBe(0);
    expect(soc(65.5)?.v).toBe(65.5);
    for (const bad of [255, 101, -1, null, "invalid", "-"]) expect(soc(bad)).toBeNull();
  });

  it("maps every documented charge status, keeps V2L apart, and records one it does not know", () => {
    const of = (status: string) =>
      normalize("batteries", answer({ charge: { status, plugin: "connected" }, timestamp: at(T) }), T);
    expect(of("charging").patch.activity?.v).toBe("active");
    expect(of("charging").patch.dc?.v).toBe(false);
    expect(of("fastCharging").patch.dc?.v).toBe(true);
    expect(of("wirelessCharging").patch.activity?.v).toBe("active");
    expect(of("reservedCharging").patch.activity?.v).toBe("scheduled");
    expect(of("v2lOperating").patch.activity?.v).toBe("discharging");
    expect(of("v2xOperating").patch.activity?.v).toBe("discharging");
    expect(of("v2lStop").patch.activity?.v).toBe("idle");
    const odd = of("plasmaCharging");
    expect(odd.patch.activity).toBeNull();
    expect(odd.patch.chargeStatus?.v).toBe("plasmaCharging");
    expect(odd.patch.plug?.v).toBe("connected");
    expect(odd.unknown).toEqual(["charge.status:plasmaCharging"]);
  });

  it("reads the driving answer: ignition, the high-voltage system, P, and the odometer in km", () => {
    const n = normalize("driving", answer(readResponse("driving", ioniq5({ ign3: "on", parked: false }))), T);
    expect(n.patch.ready?.v).toBe(true);
    expect(n.patch.inPark?.v).toBe(false);
    expect(n.patch.odometerKm?.v).toBe(23_418.6);
  });

  it("converts miles, metres and feet, and leaves an odometer at its 24-bit ceiling or in an unknown unit unknown", () => {
    const km = (value: unknown, unit: string) =>
      normalize("driving", answer({ odometer: { value, unit } }), T).patch.odometerKm?.v ?? null;
    expect(km(100, "mile")).toBeCloseTo(160.9344, 6);
    expect(km(1500, "meter")).toBeCloseTo(1.5, 9);
    expect(km(1000, "feet")).toBeCloseTo(0.3048, 9);
    expect(km(16_777_214, "km")).toBeNull();
    expect(km(10, "invalid")).toBeNull();
    const furlong = normalize("driving", answer({ odometer: { value: 10, unit: "furlong" } }), T);
    expect(furlong.patch.odometerKm).toBeNull();
    expect(furlong.unknown).toEqual(["unit:furlong"]);
  });

  it("plots only WGS84 positions, and converts the speed by its own unit", () => {
    const location = (over: object) =>
      normalize("locations", answer({ location: { latitude: 52.1, longitude: 5.1, type: 0, ...over } }), T).patch;
    expect(location({}).position?.v).toEqual({ lat: 52.1, lon: 5.1 });
    expect(location({ type: 1 }).position).toBeNull();
    expect(location({ type: 2 }).position).toBeNull();
    expect(location({ latitude: 0, longitude: 0 }).position).toBeNull();
    expect(location({ speed: { value: 10, unit: "mph" } }).speedKmh?.v).toBeCloseTo(16.09344, 6);
    expect(location({ speed: { value: 10, unit: "mps" } }).speedKmh?.v).toBe(36);
    expect(location({ speed: { value: 10, unit: "invalid" } }).speedKmh).toBeNull();
  });

  it("takes the electric range from a string, plural units included, and '-' as unknown", () => {
    const range = (entries: unknown[]) => normalize("powertrains", answer({ distanceToEmpties: entries }), T).patch;
    expect(range([{ type: "EV", value: "261", unit: "km" }]).rangeKm?.v).toBe(261);
    expect(range([{ type: "EV", value: "100", unit: "miles" }]).rangeKm?.v).toBeCloseTo(160.9344, 6);
    expect(range([{ type: "EV", value: "-", unit: "km" }]).rangeKm).toBeNull();
    // A plug-in hybrid's total range is not its electric range.
    expect(range([{ type: "PHEV", value: "600", unit: "km" }]).rangeKm).toBeNull();
  });

  it("speaks for every field its endpoint owns, and for no other", () => {
    for (const endpoint of ["batteries", "driving", "locations", "powertrains"] as const) {
      const patch = normalize(endpoint, answer({}), T).patch;
      expect(Object.keys(patch).sort()).toEqual([...OWNED[endpoint]].sort());
      for (const value of Object.values(patch)) expect(value).toBeNull();
    }
  });

  it("keeps the readings of an endpoint that did not answer", () => {
    const view = mergeView({}, normalize("batteries", answer({ charge: { stateOfCharge: 50 } }), T).patch);
    const next = mergeView(view, normalize("driving", answer({ transmission: { parkingPosition: true } }), T).patch);
    expect(next.soc?.v).toBe(50);
    expect(next.inPark?.v).toBe(true);
  });
});

const r = <V>(v: V, sent: number | null) => ({ v, at: sent, seen: T });

describe("isDriving", () => {
  it("drives with P released and the high-voltage system on, by a fresh upload", () => {
    const view: PleosView = { inPark: r(false, T - 60_000), ready: r(true, T - 60_000) };
    expect(isDriving(view, T)).toBe(true);
    expect(isDriving(view, T + MOTION_STALE_MS)).toBe(false);
  });

  it("does not drive while ready in P (climate, charging prep), or in accessory mode", () => {
    expect(isDriving({ inPark: r(true, T), ready: r(true, T) }, T)).toBe(false);
    expect(isDriving({ inPark: r(false, T), ready: r(false, T), ignition: r(true, T) }, T)).toBe(false);
  });

  it("never trusts a time from the car's future: a Kia's extra summer hour cannot open a drive", () => {
    const ahead = T + 3_600_000;
    expect(ageMs(r(true, ahead), T)).toBeNull();
    expect(ageMs(r(true, T + FUTURE_TOLERANCE_MS), T)).toBe(0);
    expect(isDriving({ inPark: r(false, ahead), ready: r(true, ahead) }, T)).toBe(false);
  });
});

describe("isCharging", () => {
  const plugged = r("connected" as const, T);
  it("charges on an active status, or on the flag where there is no status; not when the status says otherwise", () => {
    expect(isCharging({ plug: plugged, activity: r("active" as const, T) }, T)).toBe(true);
    expect(isCharging({ plug: plugged, chargingFlag: r(true, T) }, T)).toBe(true);
    expect(isCharging({ plug: plugged, activity: null, chargingFlag: r(true, T) }, T)).toBe(true);
    // `notCharging` or `v2lStop` with the flag still set: the status wins.
    expect(isCharging({ plug: plugged, activity: r("idle" as const, T), chargingFlag: r(true, T) }, T)).toBe(false);
    expect(isCharging({ plug: plugged, activity: r("scheduled" as const, T), chargingFlag: r(true, T) }, T)).toBe(
      false,
    );
    expect(isCharging({ plug: plugged, activity: r("discharging" as const, T) }, T)).toBe(false);
    expect(isCharging({ plug: r("disconnected" as const, T), activity: r("active" as const, T) }, T)).toBe(false);
  });

  it("stops believing a charge the car has not confirmed for two hours", () => {
    const view: PleosView = { plug: plugged, activity: r("active" as const, T) };
    expect(isCharging(view, T + CHARGE_STALE_MS)).toBe(true);
    expect(isCharging(view, T + CHARGE_STALE_MS + 1)).toBe(false);
  });

  it("gives the DC limit for a DC charge, else the AC one", () => {
    expect(chargeLimit({ targetAc: r(80, T), targetDc: r(90, T), dc: r(true, T) })).toBe(90);
    expect(chargeLimit({ targetAc: r(80, T), targetDc: r(90, T), dc: r(false, T) })).toBe(80);
    expect(chargeLimit({})).toBeNull();
  });
});
