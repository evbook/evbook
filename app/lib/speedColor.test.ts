import { describe, expect, it } from "bun:test";
import { SPEED_SCALE_TOP_KMH, SPEED_UNKNOWN_COLOR, speedColor, speedRuns } from "./speedColor";

const rgb = (color: string) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16)) as [number, number, number];

describe("speedColor", () => {
  it("runs from blue at a standstill to red at the top of the scale", () => {
    expect(speedColor(0)).toBe("#3b5bdb");
    expect(speedColor(SPEED_SCALE_TOP_KMH)).toBe("#e03131");
  });

  it("is redder the faster the car goes", () => {
    const [slowR, , slowB] = rgb(speedColor(30));
    const [fastR, , fastB] = rgb(speedColor(120));
    expect(fastR).toBeGreaterThan(slowR);
    expect(fastB).toBeLessThan(slowB);
  });

  it("holds at the ends of the scale", () => {
    expect(speedColor(250)).toBe(speedColor(SPEED_SCALE_TOP_KMH));
    expect(speedColor(-3)).toBe(speedColor(0));
  });

  it("gives speeds a few km/h apart one colour, and an unread speed its own", () => {
    expect(speedColor(50)).toBe(speedColor(51));
    expect(speedColor(50)).not.toBe(speedColor(80));
    expect(speedColor(null)).toBe(SPEED_UNKNOWN_COLOR);
  });
});

describe("speedRuns", () => {
  const at = (i: number, speedKmh: number | null) => ({ latitude: 48 + i * 0.001, longitude: 11, speedKmh });

  it("joins a steady stretch into one run and starts a new one where the speed changes", () => {
    const runs = speedRuns([at(0, 50), at(1, 50), at(2, 50), at(3, 120), at(4, 120)]);
    // Steady at 50, the segment that speeds up, steady at 120.
    expect(runs).toHaveLength(3);
    expect(runs[0]).toEqual({
      color: speedColor(50),
      coords: [
        [48, 11],
        [48.001, 11],
        [48.002, 11],
      ],
    });
    expect(runs[1]!.color).toBe(speedColor(85));
    expect(runs[2]!.color).toBe(speedColor(120));
  });

  it("leaves no gap between runs", () => {
    const runs = speedRuns([at(0, 10), at(1, 60), at(2, 110), at(3, 20)]);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.coords[0]).toEqual(runs[i - 1]!.coords.at(-1)!);
    }
  });

  it("colours a segment by the end whose speed is known, and marks one with neither", () => {
    const runs = speedRuns([at(0, null), at(1, 90), at(2, null), at(3, null)]);
    expect(runs.map((run) => run.color)).toEqual([speedColor(90), SPEED_UNKNOWN_COLOR]);
    expect(runs[0]!.coords).toHaveLength(3);
  });

  it("is empty for fewer than two points", () => {
    expect(speedRuns([])).toEqual([]);
    expect(speedRuns([at(0, 40)])).toEqual([]);
  });
});
