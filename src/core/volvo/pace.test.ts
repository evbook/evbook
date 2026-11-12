import { describe, expect, it } from "bun:test";
import { DAILY_QUOTA, PACE_MS, bucketShape, dueEndpoints, freshBudget, nextDueAt, spend, take } from "./pace";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe("dueEndpoints", () => {
  it("reads everything on a first pass, battery first", () => {
    const due = dueEndpoints({}, "parked", T0);
    expect(due[0]).toBe("energy-state");
    expect(due[1]).toBe("engine-status");
    expect(due).toContain("details");
  });

  it("parked: battery and engine every ten minutes, the rest hourly", () => {
    const fetched = Object.fromEntries(dueEndpoints({}, "parked", T0).map((e) => [e, T0]));
    expect(dueEndpoints(fetched, "parked", T0 + 5 * MIN)).toEqual([]);
    expect(dueEndpoints(fetched, "parked", T0 + 10 * MIN)).toEqual(["energy-state", "engine-status"]);
    expect(dueEndpoints(fetched, "parked", T0 + 60 * MIN)).toEqual([
      "energy-state",
      "engine-status",
      "odometer",
      "location",
      "statistics",
      "doors",
      "windows",
      "tyres",
    ]);
  });

  it("driving: the samples every minute; charging: the battery every minute", () => {
    const fetched = Object.fromEntries(dueEndpoints({}, "parked", T0).map((e) => [e, T0]));
    expect(dueEndpoints(fetched, "driving", T0 + MIN)).toEqual([
      "energy-state",
      "engine-status",
      "odometer",
      "location",
    ]);
    expect(dueEndpoints(fetched, "charging", T0 + MIN)).toEqual(["energy-state"]);
  });

  it("forgives a pass that ran a few seconds late", () => {
    const fetched = { "energy-state": T0 + 5_000 };
    expect(dueEndpoints(fetched, "driving", T0 + MIN)).toContain("energy-state");
  });

  it("skips what it is told to", () => {
    expect(dueEndpoints({}, "parked", T0, new Set(["location", "tyres"]))).not.toContain("location");
  });
});

describe("nextDueAt", () => {
  it("is never sooner than a minute — the cron's period — and never later than the parked pace", () => {
    const fetched = Object.fromEntries(dueEndpoints({}, "parked", T0).map((e) => [e, T0]));
    expect(nextDueAt(fetched, "parked", T0)).toBe(T0 + PACE_MS.parked);
    expect(nextDueAt(fetched, "driving", T0)).toBe(T0 + PACE_MS.active);
    expect(nextDueAt({}, "parked", T0)).toBe(T0 + PACE_MS.active);
  });
});

describe("quota budget", () => {
  it("allows an hour's worth at once and the usable quota over a day", () => {
    const { capacity, ratePerMs } = bucketShape(1);
    expect(capacity).toBe(375);
    expect(capacity + ratePerMs * 24 * 60 * MIN).toBeCloseTo(DAILY_QUOTA * 0.9);
  });

  it("splits the key's quota between the instance's Volvo cars", () => {
    expect(bucketShape(2).capacity).toBe(187.5);
  });

  it("refuses a call once the bucket is empty, then refills", () => {
    const budget = freshBudget(1, T0);
    let taken = 0;
    while (take(budget, "energy", 1, T0)) taken++;
    expect(taken).toBe(375);
    expect(take(budget, "energy", 1, T0)).toBe(false);
    // Other APIs are separate pools.
    expect(take(budget, "location", 1, T0)).toBe(true);
    // ~0.1 calls/s: twenty seconds later there is a call to spend.
    expect(take(budget, "energy", 1, T0 + 20_000)).toBe(true);
  });

  it("charges retries the client made on top of the call it paid for", () => {
    const budget = freshBudget(1, T0);
    spend(budget, "energy", 2);
    expect(budget.energy.tokens).toBe(373);
  });
});
