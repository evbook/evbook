import { describe, expect, it } from "bun:test";
import { findHiddenEvents, MAX_HIDDEN_SPAN_MS, type Reading } from "./gaps";

const T = 1_700_000_000_000;
const H = 3_600_000;

const parked = (at: number, km: number, soc: number | null): Reading => ({ at, km, soc, positionId: at });
const end = (kind: "drive" | "charge", id: number, which: "start" | "end", r: Reading): Reading => ({
  ...r,
  event: { kind, id, end: which },
});

describe("finding what happened while nothing was reading", () => {
  it("finds a drive in an odometer increase between two readings", () => {
    const found = findHiddenEvents([parked(T, 1000, 80), parked(T + 2 * H, 1033, 72)]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "drive", km: 33 });
    expect(found[0]!.from.at).toBe(T);
    expect(found[0]!.to.at).toBe(T + 2 * H);
  });

  it("finds a charge in a state-of-charge rise", () => {
    const found = findHiddenEvents([parked(T, 1000, 40), parked(T + 5 * H, 1000, 78)]);
    expect(found).toEqual([expect.objectContaining({ kind: "charge", socFrom: 40, socTo: 78 })]);
  });

  it("finds both when the car was driven to a charger and back unseen", () => {
    const found = findHiddenEvents([parked(T, 1000, 30), parked(T + 3 * H, 1024, 75)]);
    expect(found.map((e) => e.kind)).toEqual(["drive", "charge"]);
  });

  it("leaves recorded events, and the readings inside them, alone", () => {
    const found = findHiddenEvents([
      parked(T, 1000, 80),
      end("drive", 1, "start", parked(T + H, 1000, 80)),
      // A wake row inside the drive's span, out of step with the samples.
      parked(T + H + 1000, 1004, 79),
      end("drive", 1, "end", parked(T + 2 * H, 1020, 70)),
      end("charge", 2, "start", parked(T + 3 * H, 1020, 70)),
      end("charge", 2, "end", parked(T + 4 * H, 1020, 90)),
      parked(T + 5 * H, 1020, 90),
    ]);
    expect(found).toEqual([]);
  });

  it("ignores noise: rounding, nudges, and a point or two of state of charge", () => {
    expect(findHiddenEvents([parked(T, 1000, 80), parked(T + H, 1000.3, 82)])).toEqual([]);
  });

  it("reads a drive whose origin was extended as starting where the car was parked", () => {
    // The origin row carries the parked odometer, so nothing is left unexplained.
    const start = end("drive", 1, "start", parked(T + H, 1000, null));
    expect(findHiddenEvents([parked(T, 1000, 80), start, end("drive", 1, "end", parked(T + 2 * H, 1010, 75))])).toEqual(
      [],
    );
  });

  it("calls a hiatus a hiatus, and a jumping odometer an error", () => {
    // Weeks between an imported history and live logging: not one event.
    expect(findHiddenEvents([parked(T, 1000, 80), parked(T + MAX_HIDDEN_SPAN_MS + 1, 2127, 60)])).toEqual([]);
    // 900 km in an hour.
    expect(findHiddenEvents([parked(T, 1000, 80), parked(T + H, 1900, 80)])).toEqual([]);
    // Odometers never run backwards; a reading that does is not a drive.
    expect(findHiddenEvents([parked(T, 1000, 80), parked(T + H, 990, 80)])).toEqual([]);
  });

  it("skips what is unknown rather than reading it as zero", () => {
    expect(
      findHiddenEvents([
        { at: T, km: null, soc: null, positionId: 1 },
        { at: T + H, km: 1050, soc: 90, positionId: 2 },
      ]),
    ).toEqual([]);
  });
});
