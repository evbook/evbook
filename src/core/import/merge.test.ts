import { describe, expect, it } from "bun:test";
import { mergeTracks, type MergeTrack, type TimedRow } from "./merge";

function track(name: string, maxAgeMs: number, rows: [number, string][]): MergeTrack<string> {
  return {
    name,
    maxAgeMs,
    rows: (async function* (): AsyncIterable<TimedRow<string>> {
      for (const [at, row] of rows) yield { at, row };
    })(),
  };
}

/** The merged sample is reused between iterations, so snapshot what we compare. */
async function merged(tracks: MergeTrack<string>[]): Promise<{ at: number; tracks: Record<string, string | null> }[]> {
  const out: { at: number; tracks: Record<string, string | null> }[] = [];
  for await (const sample of mergeTracks(tracks)) out.push({ at: sample.at, tracks: { ...sample.tracks } });
  return out;
}

const MINUTE = 60_000;

describe("track merging", () => {
  it("yields one sample per distinct timestamp, ascending", async () => {
    const result = await merged([
      track("a", MINUTE, [
        [1000, "a1"],
        [3000, "a2"],
      ]),
      track("b", MINUTE, [[2000, "b1"]]),
    ]);
    expect(result.map((sample) => sample.at)).toEqual([1000, 2000, 3000]);
  });

  it("carries a row forward until it goes stale", async () => {
    const result = await merged([
      track("slow", 2 * MINUTE, [[0, "s1"]]),
      track("fast", MINUTE, [
        [MINUTE, "f1"],
        [3 * MINUTE, "f2"],
      ]),
    ]);
    expect(result[0]).toEqual({ at: 0, tracks: { slow: "s1", fast: null } });
    // One minute later the slow row is still valid...
    expect(result[1]).toEqual({ at: MINUTE, tracks: { slow: "s1", fast: "f1" } });
    // ...three minutes later it is past its max age, and so is the fast one.
    expect(result[2]).toEqual({ at: 3 * MINUTE, tracks: { slow: null, fast: "f2" } });
  });

  it("reports the age of each track's row", async () => {
    const ages: Record<string, number>[] = [];
    for await (const sample of mergeTracks([
      track("a", MINUTE, [
        [0, "a1"],
        [30_000, "a2"],
      ]),
      track("b", 10 * MINUTE, [[0, "b1"]]),
    ])) {
      ages.push({ ...sample.ages });
    }
    expect(ages[0]).toEqual({ a: 0, b: 0 });
    expect(ages[1]).toEqual({ a: 0, b: 30_000 });
  });

  it("keeps the last row when a track repeats a timestamp", async () => {
    const result = await merged([
      track("a", MINUTE, [
        [1000, "first"],
        [1000, "second"],
      ]),
    ]);
    expect(result).toEqual([{ at: 1000, tracks: { a: "second" } }]);
  });

  it("never goes backwards on an unsorted export", async () => {
    const result = await merged([
      track("a", MINUTE, [
        [2000, "a1"],
        [1000, "out of order"],
        [3000, "a2"],
      ]),
    ]);
    expect(result.map((sample) => sample.at)).toEqual([2000, 3000]);
    expect(result[0]!.tracks.a).toBe("out of order"); // clamped to 2000, last wins
  });

  it("handles a track with no rows at all", async () => {
    const result = await merged([track("empty", MINUTE, []), track("a", MINUTE, [[1000, "a1"]])]);
    expect(result).toEqual([{ at: 1000, tracks: { empty: null, a: "a1" } }]);
  });

  it("yields nothing when every track is empty", async () => {
    expect(await merged([track("a", MINUTE, []), track("b", MINUTE, [])])).toEqual([]);
  });
});
