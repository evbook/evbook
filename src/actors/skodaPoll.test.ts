import { describe, expect, it } from "bun:test";
import type { SkodaView } from "../core/skoda/normalize";
import { MOTION_STALE_MS } from "../core/skoda/vehicleData";
import { modeOf, nextSession } from "./skodaPoll";

const T = 1_700_000_000_000;
const MIN = 60_000;

const charging = (powerKw: number | null): SkodaView => ({
  chargeState: { v: "CHARGING", at: T, seen: T },
  plug: { v: "connected", at: T, seen: T },
  powerKw: powerKw === null ? null : { v: powerKw, at: T, seen: T },
});
const unplugged: SkodaView = { plug: { v: "disconnected", at: T, seen: T } };

describe("nextSession", () => {
  it("integrates the reported power between reads", () => {
    let s = nextSession(null, charging(11), T);
    s = nextSession(s, charging(11), T + 5 * MIN);
    s = nextSession(s, charging(11), T + 10 * MIN);
    expect(s?.energyKwh).toBeCloseTo((11 * 10) / 60, 2);
  });

  it("adds nothing across a gap it cannot vouch for, or for power it was not told", () => {
    let s = nextSession(null, charging(11), T);
    s = nextSession(s, charging(11), T + 40 * MIN);
    expect(s?.energyKwh).toBe(0);
    s = nextSession(s, charging(null), T + 45 * MIN);
    s = nextSession(s, charging(null), T + 50 * MIN);
    expect(s?.energyKwh).toBe(0);
  });

  it("closes on the read that sees charging over, then is gone, and a new charge starts afresh", () => {
    let s = nextSession(null, charging(7), T);
    s = nextSession(s, unplugged, T + 5 * MIN);
    expect(s?.ended).toBe(true);
    expect(nextSession(s, unplugged, T + 10 * MIN)).toBeNull();
    const again = nextSession(s, charging(7), T + 10 * MIN);
    expect(again).toMatchObject({ startedAt: T + 10 * MIN, energyKwh: 0 });
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
