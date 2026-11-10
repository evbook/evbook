import { describe, expect, it } from "bun:test";
import { trendLine } from "./smooth";

/**
 * The fit under the capacity charts. Every case here is shaped like the real thing:
 * a pack losing a little capacity over a couple of dozen charging sessions, measured
 * by a method that is right on average and a kilowatt-hour out on any given day.
 */

/** A pack starting at 75 kWh and giving up a tenth of a kWh a session. */
const declining = (count: number) => Array.from({ length: count }, (_, i) => 75 - i * 0.1);
const indices = (count: number) => Array.from({ length: count }, (_, i) => i);

/**
 * Twenty sessions' worth of measurement error, written down rather than generated so
 * the fit is graded on the same misses every run — and so they can be read: they are
 * the size of a real one, and they do not lean one way.
 */
const MISSES = [
  0.6, -0.4, 0.9, -0.7, 0.2, -0.8, 0.5, 0.1, -0.6, 0.8, -0.3, 0.7, -0.9, 0.4, -0.2, 0.6, -0.7, 0.3, -0.5, 0.8,
];

const wobble = (values: number[], amount: number) => values.map((y, i) => y + MISSES[i % MISSES.length]! * amount);

describe("trendLine", () => {
  it("keeps the slope of a pack that is losing capacity steadily", () => {
    const clean = declining(20);
    const fit = trendLine(indices(20), clean);
    for (let i = 0; i < clean.length; i++) expect(fit[i]!).toBeCloseTo(clean[i]!, 6);
  });

  it("takes the jitter out without flattening the decline", () => {
    const clean = declining(20);
    const noisy = wobble(clean, 0.8);
    const fit = trendLine(indices(20), noisy);

    // What is left of the wobble against what went in — on the typical sample, and
    // on the worst one, which is always at an end where there is half a
    // neighbourhood to average against.
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const missBefore = noisy.map((y, i) => Math.abs(y - clean[i]!));
    const missAfter = fit.map((y, i) => Math.abs(y! - clean[i]!));
    expect(mean(missAfter)).toBeLessThan(mean(missBefore) / 3);
    expect(Math.max(...missAfter)).toBeLessThan(Math.max(...missBefore) / 2);

    // And the decline itself survives: a fit that smoothed the slope away would be
    // reporting a pack that never aged. Measured across the middle, away from the
    // ends, where the alternating noise leans on whichever sample comes last.
    expect(fit[5]! - fit[14]!).toBeCloseTo(0.9, 1);
  });

  it("does not let one bad session bend the line", () => {
    const clean = declining(21);
    const withOutlier = [...clean];
    withOutlier[10] = 82; // A session that measured seven kWh high.
    const fit = trendLine(indices(21), withOutlier);
    expect(fit[10]!).toBeCloseTo(clean[10]!, 1);
  });

  it("reads the ends off a slope rather than an average", () => {
    // An average has samples on one side only at the ends, which drags the line flat
    // there — right where the reader is looking for the pack's capacity today. A
    // slope has half a neighbourhood to work with there, so it is looser than the
    // middle, but it still lands nearer the truth than the samples it was fitted to.
    const clean = declining(20);
    const fit = trendLine(indices(20), wobble(clean, 0.5));
    expect(Math.abs(fit[19]! - clean[19]!)).toBeLessThan(0.25);
  });

  it("carries the line across a session with no reading", () => {
    const clean = declining(20);
    const gappy: (number | null)[] = [...clean];
    gappy[9] = null;
    const fit = trendLine(indices(20), gappy);
    expect(fit[9]!).toBeCloseTo(clean[9]!, 1);
  });

  it("still turns inside a winter on three years of sessions", () => {
    /*
      The window is counted in samples, not in axis, so that this holds: three hundred
      sessions over three years, a pack that reads a kWh and a half low every winter
      and comes back every spring. A window sized as a share of the axis is a season
      wide on a car that charges nightly, and it takes the seasons out — which is the
      one thing a capacity chart is worth reading against a cold snap.
    */
    const count = 300;
    const year = count / 3;
    const clean = Array.from({ length: count }, (_, i) => 70 - i * 0.005 + 1.5 * Math.sin((2 * Math.PI * i) / year));
    const fit = trendLine(indices(count), wobble(clean, 0.5));

    // One whole year out of the middle, where neither end of the series is in the way.
    const middle = fit.slice(year, 2 * year).map((value) => value!);
    const swing = Math.max(...middle) - Math.min(...middle);
    expect(swing).toBeGreaterThan(2.1); // Of the three kWh that went in.
    expect(swing).toBeLessThan(3.3); // And not inventing any.
  });

  it("weights by how far apart the samples are, not how many there are", () => {
    // Nineteen sessions in one week and one a year later: the far one is a different
    // stretch of the car's life and has the fit near it to itself.
    const xs = [...Array.from({ length: 19 }, (_, i) => i), 400];
    const ys = [...Array.from({ length: 19 }, () => 75), 70];
    const fit = trendLine(xs, ys);
    // Five kWh away and a year off: worth a tenth of a kWh at the near end, no more.
    expect(Math.abs(fit[0]! - 75)).toBeLessThan(0.1);
    expect(fit[19]!).toBeCloseTo(70, 1);
  });

  it("draws nothing from a handful of sessions", () => {
    expect(trendLine([0, 1, 2, 3], [75, 74.6, 74.9, 74.4])).toEqual([null, null, null, null]);
  });

  it("draws nothing when every sample is at the same x", () => {
    expect(trendLine([5, 5, 5, 5, 5], [75, 74, 76, 75, 74])).toEqual([null, null, null, null, null]);
  });

  it("has nowhere to put a sample with no x", () => {
    const fit = trendLine([0, 1, NaN, 3, 4, 5], [75, 74.9, 74.8, 74.7, 74.6, 74.5]);
    expect(fit[2]).toBeNull();
    expect(fit[3]).not.toBeNull();
  });
});
