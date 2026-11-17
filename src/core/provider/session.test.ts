import { describe, expect, it } from "bun:test";
import { nextSession } from "./session";

const T = 1_700_000_000_000;
const MIN = 60_000;
const GAP = 15 * MIN;

const charging = (powerKw: number | null) => ({ charging: true, powerKw });
const idle = { charging: false, powerKw: null };

describe("nextSession", () => {
  it("integrates the reported power between reads", () => {
    let s = nextSession(null, charging(11), T, GAP);
    s = nextSession(s, charging(11), T + 5 * MIN, GAP);
    s = nextSession(s, charging(11), T + 10 * MIN, GAP);
    expect(s?.energyKwh).toBeCloseTo((11 * 10) / 60, 2);
  });

  it("adds nothing across a gap it cannot vouch for, or for power it was not told", () => {
    let s = nextSession(null, charging(11), T, GAP);
    s = nextSession(s, charging(11), T + 40 * MIN, GAP);
    expect(s?.energyKwh).toBe(0);
    s = nextSession(s, charging(null), T + 45 * MIN, GAP);
    s = nextSession(s, charging(null), T + 50 * MIN, GAP);
    expect(s?.energyKwh).toBe(0);
  });

  it("takes the gap from its caller", () => {
    let s = nextSession(null, charging(6), T, 60 * MIN);
    s = nextSession(s, charging(6), T + 40 * MIN, 60 * MIN);
    expect(s?.energyKwh).toBeCloseTo(4, 2);
  });

  it("closes on the read that sees charging over, ramping down to zero, then is gone", () => {
    let s = nextSession(null, charging(6), T, GAP);
    s = nextSession(s, idle, T + 10 * MIN, GAP);
    expect(s).toMatchObject({ ended: true, powerKw: 0 });
    expect(s?.energyKwh).toBeCloseTo(0.5, 2);
    expect(nextSession(s, idle, T + 20 * MIN, GAP)).toBeNull();
    expect(nextSession(null, idle, T, GAP)).toBeNull();
  });

  it("starts a new charge afresh after a closing sample, never carrying the old energy", () => {
    let s = nextSession(null, charging(7), T, GAP);
    s = nextSession(s, charging(7), T + 5 * MIN, GAP);
    s = nextSession(s, idle, T + 10 * MIN, GAP);
    const again = nextSession(s, charging(7), T + 15 * MIN, GAP);
    expect(again).toEqual({ startedAt: T + 15 * MIN, energyKwh: 0, powerKw: 7, at: T + 15 * MIN });
  });
});
