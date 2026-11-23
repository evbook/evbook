import { describe, expect, it } from "bun:test";
import { bearingDeg, routeCoverage, routeCursorAt, trackStretches } from "./geo";

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

describe("trackStretches", () => {
  const MIN = 60_000;
  /** Limassol, a sample a minute, as a Volvo is polled while driving. */
  const at = (minute: number, latitude: number, longitude: number) => ({ at: minute * MIN, latitude, longitude });
  const home = [34.689, 33.05] as const;
  const stadium = [34.705, 32.99] as const;

  it("dashes the whole way when only the two ends were reported", () => {
    // Volvo answered the parked position all drive, then the new one at the end.
    const track = [at(0, ...home), at(1, ...home), at(2, ...home), at(30, ...stadium), at(31, ...stadium)];
    const stretches = trackStretches(track);
    expect(stretches.map((s) => [s.recorded, s.points.length])).toEqual([
      [true, 3],
      [false, 2],
      [true, 2],
    ]);
    expect(routeCoverage(stretches)).toBe("none");
  });

  it("dashes each five-minute hop of a Volvo that did refresh its position", () => {
    const track = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => at(m, 34.689 + Math.floor(m / 5) * 0.01, 33.05));
    const stretches = trackStretches(track);
    expect(stretches.filter((s) => !s.recorded)).toHaveLength(2);
    expect(routeCoverage(stretches)).toBe("partial");
  });

  it("keeps a track sampled every few seconds solid", () => {
    const track = Array.from({ length: 60 }, (_, i) => ({
      at: i * 5_000,
      latitude: 48.1351 + i * 0.0002,
      longitude: 11.582,
    }));
    expect(trackStretches(track)).toEqual([{ recorded: true, points: track }]);
    expect(routeCoverage(trackStretches(track))).toBe("full");
  });

  it("keeps the moment after a long red light solid", () => {
    const track = [
      at(0, 48.1351, 11.582),
      at(5, 48.1351, 11.582),
      { at: 5 * MIN + 5_000, latitude: 48.1353, longitude: 11.582 },
    ];
    expect(routeCoverage(trackStretches(track))).toBe("full");
  });

  it("dashes a tunnel between recorded stretches", () => {
    const before = [at(0, 48.1, 11.5), { at: 10_000, latitude: 48.1003, longitude: 11.5 }];
    const after = [at(6, 48.13, 11.5), { at: 6 * MIN + 10_000, latitude: 48.1303, longitude: 11.5 }];
    const stretches = trackStretches([...before, ...after]);
    expect(stretches.map((s) => s.recorded)).toEqual([true, false, true]);
    expect(routeCoverage(stretches)).toBe("partial");
  });

  it("has nothing to cut on a drive with one fix", () => {
    expect(trackStretches([at(0, ...home)])).toEqual([]);
    expect(routeCoverage([])).toBe("full");
  });
});
