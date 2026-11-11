import { describe, expect, it } from "bun:test";
import { COLLAPSE_MS, durationRange, isWide, spanOf } from "./uncertainty";

const T = 1_700_000_000_000;
const MIN = 60_000;

describe("spans", () => {
  it("is nothing when the bounds are the point itself", () => {
    expect(spanOf(T, null, null)).toBeNull();
    expect(spanOf(T, T, T)).toBeNull();
    expect(spanOf(null, T - MIN, T)).toBeNull();
  });

  it("always contains the point estimate", () => {
    expect(spanOf(T, T - 6 * MIN, null)).toEqual({ after: T - 6 * MIN, before: T });
    expect(spanOf(T, null, T + 3 * MIN)).toEqual({ after: T, before: T + 3 * MIN });
    // A bound recorded on the wrong side of the point widens to include it.
    expect(spanOf(T, T + MIN, T + 2 * MIN)).toEqual({ after: T, before: T + 2 * MIN });
  });

  it("collapses two minutes or less into one time", () => {
    expect(isWide({ after: T, before: T + COLLAPSE_MS })).toBe(false);
    expect(isWide({ after: T, before: T + COLLAPSE_MS + 1 })).toBe(true);
    expect(isWide(null)).toBe(false);
  });
});

describe("duration ranges", () => {
  it("runs from the latest start to the earliest end, and back", () => {
    // Started 06:55–07:01, ended 07:39–07:40.
    const range = durationRange(
      { at: T + 6 * MIN, span: { after: T, before: T + 6 * MIN } },
      { at: T + 45 * MIN, span: null },
    );
    expect(range).toEqual({ min: 39, max: 45 });
  });

  it("stands as measured when both ends are tight", () => {
    expect(durationRange({ at: T, span: { after: T - MIN, before: T } }, { at: T + 30 * MIN, span: null })).toBeNull();
  });

  it("has nothing to say about an event still going", () => {
    expect(durationRange({ at: T, span: { after: T - 10 * MIN, before: T } }, { at: null, span: null })).toBeNull();
  });
});
