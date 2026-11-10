import { describe, expect, it } from "bun:test";
import { bearingDeg, routeCursorAt } from "./geo";

/**
 * The cursor under the drive detail's telemetry chart. The tracks here are shaped
 * like the real thing: a few seconds between samples, a couple of ten-thousandths
 * of a degree between fixes.
 */

/** Roughly Munich, heading due north sample by sample. */
const northbound = [
  { latitude: 48.1351, longitude: 11.582 },
  { latitude: 48.1361, longitude: 11.582 },
  { latitude: 48.1371, longitude: 11.582 },
];

describe("bearingDeg", () => {
  it("reads the compass points off straight segments", () => {
    const at = (latitude: number, longitude: number) => ({ latitude, longitude });
    expect(bearingDeg(at(48, 11), at(48.001, 11))).toBeCloseTo(0, 3);
    expect(bearingDeg(at(0, 11), at(0, 11.001))).toBeCloseTo(90, 3);
    expect(bearingDeg(at(48.001, 11), at(48, 11))).toBeCloseTo(180, 3);
    expect(bearingDeg(at(0, 11.001), at(0, 11))).toBeCloseTo(270, 3);
  });

  it("stays in compass range on a southwest leg", () => {
    const heading = bearingDeg({ latitude: 48.001, longitude: 11.001 }, { latitude: 48, longitude: 11 });
    expect(heading).toBeGreaterThan(180);
    expect(heading).toBeLessThan(270);
  });
});

describe("routeCursorAt", () => {
  it("points a mid-drive sample towards the next one", () => {
    const cursor = routeCursorAt(northbound, 1);
    expect(cursor).toMatchObject({ latitude: 48.1361, longitude: 11.582 });
    expect(cursor!.headingDeg).toBeCloseTo(0, 3);
  });

  it("keeps the last sample facing the way it arrived", () => {
    expect(routeCursorAt(northbound, 2)!.headingDeg).toBeCloseTo(0, 3);
  });

  it("looks past a stop for the direction the car will leave in", () => {
    // Two samples at a red light, then a turn east: the light faces east, not north.
    const stopped = [northbound[0]!, northbound[1]!, northbound[1]!, { latitude: 48.1361, longitude: 11.583 }];
    expect(routeCursorAt(stopped, 1)!.headingDeg).toBeCloseTo(90, 3);
  });

  it("declines to place a sample that has no fix", () => {
    const gap = [northbound[0]!, { latitude: null, longitude: null }, northbound[2]!];
    expect(routeCursorAt(gap, 1)).toBeNull();
  });

  it("gives up the heading, not the spot, when the drive never moved", () => {
    const parked = [northbound[0]!, northbound[0]!];
    expect(routeCursorAt(parked, 0)).toMatchObject({ latitude: 48.1351, headingDeg: null });
  });
});
