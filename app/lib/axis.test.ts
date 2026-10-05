import { describe, expect, it } from "vitest";
import { paddedBounds, roundedDomain, sharedIntervals, ticksFor } from "./axis";

/**
 * The scales the charts are read against. Every case here is a real one from a
 * charging session: a battery that climbs 28 → 80%, a wall box holding 11 kW, the
 * energy counter that starts at nothing.
 */

const NO_LIMIT: [number, number] = [-Infinity, Infinity];
const NON_NEGATIVE: [number, number] = [0, Infinity];
const PERCENT: [number, number] = [0, 100];

describe("paddedBounds", () => {
  it("leaves a tenth of the span at each end", () => {
    expect(paddedBounds([28, 80], NO_LIMIT)).toEqual([22.8, 85.2]);
  });

  it("keeps a quantity that never goes negative off the negative side", () => {
    // Energy added starts at nothing. The gap belongs above it, not below zero.
    const [min, max] = paddedBounds([0, 38.4], NON_NEGATIVE)!;
    expect(min).toBe(0);
    expect(max).toBeCloseTo(42.24, 6);
  });

  it("stops a percentage at 100", () => {
    expect(paddedBounds([90, 100], PERCENT)).toEqual([89, 100]);
  });

  it("gives a flat series a band to sit in rather than a line of zero height", () => {
    const [min, max] = paddedBounds([11, 11], NO_LIMIT)!;
    expect(max).toBeGreaterThan(11);
    expect(min).toBeLessThan(11);
  });

  it("has nothing to say about no samples", () => {
    expect(paddedBounds([], NO_LIMIT)).toBeUndefined();
  });
});

describe("roundedDomain", () => {
  it("rounds out to steps a reader can do arithmetic on", () => {
    expect(roundedDomain([3.6, 11.7], 4)).toEqual([2.5, 12.5]);
    expect(roundedDomain([22.8, 85.2], 4)).toEqual([20, 100]);
  });

  it("covers the top even when rounding the start down eats into the room", () => {
    for (const [min, max] of [
      [3.6, 11.7],
      [22.8, 85.2],
      [0, 42.24],
      [112.35, 413.2],
      [-18, 7.4],
      [0.004, 0.019],
    ] as [number, number][]) {
      for (const intervals of [4, 5, 6]) {
        const [from, to] = roundedDomain([min, max], intervals);
        expect(from).toBeLessThanOrEqual(min);
        expect(to).toBeGreaterThanOrEqual(max);
      }
    }
  });

  it("divides into exactly the intervals asked for", () => {
    const [from, to] = roundedDomain([22.8, 85.2], 5);
    expect(ticksFor([from, to], 5)).toHaveLength(6);
  });
});

describe("ticksFor", () => {
  it("puts a tick on every step, free of binary-float dust", () => {
    expect(ticksFor([2.5, 12.5], 4)).toEqual([2.5, 5, 7.5, 10, 12.5]);
    expect(ticksFor([0, 0.5], 5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });
});

describe("sharedIntervals", () => {
  it("counts the same for every axis, so the right one lands on the gridlines", () => {
    const power = paddedBounds([4, 11], NON_NEGATIVE)!;
    const battery = paddedBounds([28, 80], PERCENT)!;
    const intervals = sharedIntervals([power, battery]);
    expect(ticksFor(roundedDomain(power, intervals), intervals)).toHaveLength(intervals + 1);
    expect(ticksFor(roundedDomain(battery, intervals), intervals)).toHaveLength(intervals + 1);
  });

  it("picks the count that leaves the worst-fitting axis the least empty height", () => {
    // Energy against range: four intervals would run the energy axis to 80 for a
    // series that stops at 38, wasting half the panel.
    const energy = paddedBounds([0, 38.36], NON_NEGATIVE)!;
    const range = paddedBounds([137.42, 388.13], NON_NEGATIVE)!;
    const intervals = sharedIntervals([energy, range]);
    expect(roundedDomain(energy, intervals)).toEqual([0, 50]);
  });
});
