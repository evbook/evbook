import { describe, expect, it } from "bun:test";
import type { SkodaView } from "../core/skoda/normalize";
import { MOTION_STALE_MS } from "../core/skoda/vehicleData";
import { chargeSample, modeOf } from "./skodaPoll";

const T = 1_700_000_000_000;

const charging = (powerKw: number | null): SkodaView => ({
  chargeState: { v: "CHARGING", at: T, seen: T },
  plug: { v: "connected", at: T, seen: T },
  powerKw: powerKw === null ? null : { v: powerKw, at: T, seen: T },
});
const unplugged: SkodaView = { plug: { v: "disconnected", at: T, seen: T } };

describe("chargeSample", () => {
  it("is charging with the reported power, unknown when Škoda gives none, and idle once unplugged", () => {
    expect(chargeSample(charging(11))).toEqual({ charging: true, powerKw: 11 });
    expect(chargeSample(charging(null))).toEqual({ charging: true, powerKw: null });
    expect(chargeSample(unplugged).charging).toBe(false);
  });
});

describe("modeOf", () => {
  it("drives on a fresh 'in motion', charges on charging, and is parked otherwise", () => {
    const moving: SkodaView = { motion: { v: "moving", at: null, seen: T } };
    expect(modeOf(moving, T)).toBe("driving");
    expect(modeOf(moving, T + MOTION_STALE_MS + 1)).toBe("parked");
    expect(modeOf(charging(3), T)).toBe("charging");
    expect(modeOf(unplugged, T)).toBe("parked");
  });
});
