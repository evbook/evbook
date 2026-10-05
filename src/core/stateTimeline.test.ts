import { describe, expect, it } from "vitest";
import { mergeSpans, totalsFor, type Span } from "./stateTimeline";

/**
 * Known-answer tests for the state band. Times are plain small integers — the
 * merge is scale-free, so readable numbers beat epochs here.
 */

const h = (n: number) => n * 3_600_000;

describe("merging state spans", () => {
  it("returns a base state untouched", () => {
    const band = mergeSpans([{ state: "asleep", from: h(0), to: h(8) }], h(0), h(8));
    expect(band).toEqual([{ state: "asleep", from: h(0), to: h(8) }]);
  });

  it("punches a drive out of the surrounding online period", () => {
    const spans: Span[] = [
      { state: "online", from: h(0), to: h(6) },
      { state: "driving", from: h(2), to: h(3) },
    ];
    expect(mergeSpans(spans, h(0), h(6))).toEqual([
      { state: "online", from: h(0), to: h(2) },
      { state: "driving", from: h(2), to: h(3) },
      { state: "online", from: h(3), to: h(6) },
    ]);
  });

  it("prefers driving over charging, and updating over both", () => {
    const spans: Span[] = [
      { state: "online", from: 0, to: 40 },
      { state: "charging", from: 10, to: 30 },
      { state: "driving", from: 15, to: 25 },
      { state: "updating", from: 18, to: 20 },
    ];
    expect(mergeSpans(spans, 0, 40)).toEqual([
      { state: "online", from: 0, to: 10 },
      { state: "charging", from: 10, to: 15 },
      { state: "driving", from: 15, to: 18 },
      { state: "updating", from: 18, to: 20 },
      { state: "driving", from: 20, to: 25 },
      { state: "charging", from: 25, to: 30 },
      { state: "online", from: 30, to: 40 },
    ]);
  });

  it("joins neighbouring spans of the same state into one", () => {
    const spans: Span[] = [
      { state: "asleep", from: 0, to: 10 },
      { state: "asleep", from: 10, to: 20 },
    ];
    expect(mergeSpans(spans, 0, 20)).toEqual([{ state: "asleep", from: 0, to: 20 }]);
  });

  it("reports a stretch nothing covers as unknown rather than dropping it", () => {
    const spans: Span[] = [
      { state: "online", from: 0, to: 10 },
      { state: "asleep", from: 30, to: 40 },
    ];
    expect(mergeSpans(spans, 0, 40)).toEqual([
      { state: "online", from: 0, to: 10 },
      { state: "unknown", from: 10, to: 30 },
      { state: "asleep", from: 30, to: 40 },
    ]);
  });

  it("clips spans to the window on both sides", () => {
    const spans: Span[] = [{ state: "driving", from: -50, to: 150 }];
    expect(mergeSpans(spans, 0, 100)).toEqual([{ state: "driving", from: 0, to: 100 }]);
  });

  it("ignores a zero-length span", () => {
    const spans: Span[] = [
      { state: "online", from: 0, to: 10 },
      { state: "driving", from: 5, to: 5 },
    ];
    expect(mergeSpans(spans, 0, 10)).toEqual([{ state: "online", from: 0, to: 10 }]);
  });

  it("has nothing to say about an empty or inverted window", () => {
    expect(mergeSpans([{ state: "online", from: 0, to: 10 }], 5, 5)).toEqual([]);
    expect(mergeSpans([{ state: "online", from: 0, to: 10 }], 10, 0)).toEqual([]);
  });
});

describe("state totals", () => {
  it("sums each state and divides by the window", () => {
    const band = mergeSpans(
      [
        { state: "asleep", from: h(0), to: h(6) },
        { state: "driving", from: h(6), to: h(7) },
        { state: "online", from: h(7), to: h(8) },
      ],
      h(0),
      h(8),
    );
    expect(totalsFor(band, h(0), h(8))).toEqual([
      { state: "asleep", ms: h(6), share: 0.75 },
      { state: "driving", ms: h(1), share: 0.125 },
      { state: "online", ms: h(1), share: 0.125 },
    ]);
  });

  it("adds up separated stretches of the same state", () => {
    const band = mergeSpans(
      [
        { state: "online", from: 0, to: 10 },
        { state: "driving", from: 10, to: 20 },
        { state: "online", from: 20, to: 30 },
      ],
      0,
      30,
    );
    const online = totalsFor(band, 0, 30).find((t) => t.state === "online");
    expect(online).toEqual({ state: "online", ms: 20, share: 2 / 3 });
  });
});
