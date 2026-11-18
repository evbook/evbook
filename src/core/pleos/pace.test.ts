import { describe, expect, it } from "bun:test";
import { READS } from "./api";
import {
  HOURLY_CAP,
  MIN_DELAY_MS,
  PACE_MS,
  SETTLE_MS,
  budgetWaitMs,
  dueNow,
  nextDelayMs,
  schedule,
  settle,
} from "./pace";

const T = 1_800_000_000_000;
const MIN = 60_000;

describe("pace", () => {
  it("reads everything on the first pass, then each read at its own pace", () => {
    expect(dueNow({}, T)).toEqual([...READS]);
    const due = schedule({}, READS, "parked", T);
    expect(due).toEqual({
      batteries: T + 10 * MIN,
      driving: T + 10 * MIN,
      locations: T + 60 * MIN,
      powertrains: T + 60 * MIN,
    });
    expect(dueNow(due, T + 10 * MIN)).toEqual(["batteries", "driving"]);
    expect(nextDelayMs(due, [T, T, T, T], T)).toBe(10 * MIN);
  });

  it("brings reads forward when the car starts driving, and settles every read after", () => {
    const parked = schedule({}, READS, "parked", T);
    const driving = schedule(parked, ["driving"], "driving", T + MIN);
    expect(driving.locations).toBe(T + 3 * MIN);
    expect(driving.driving).toBe(T + 3 * MIN);
    const settled = settle(driving, T + 2 * MIN);
    for (const endpoint of READS) expect(settled[endpoint]).toBeLessThanOrEqual(T + 2 * MIN + SETTLE_MS);
  });

  it("stays well under the hourly cap in every mode", () => {
    for (const mode of ["parked", "driving", "charging"] as const) {
      const perHour = READS.reduce((sum, endpoint) => sum + 60 / (PACE_MS[mode][endpoint] / MIN), 0);
      expect(perHour).toBeLessThanOrEqual(HOURLY_CAP - 4);
    }
  });

  it("holds the next pass back until the cap has room", () => {
    const sent = Array.from({ length: HOURLY_CAP }, (_, i) => T - 59 * MIN + i * 1000);
    expect(budgetWaitMs(sent, T)).toBe(MIN);
    expect(budgetWaitMs(sent.slice(2), T, 4)).toBe(MIN + 3_000);
    expect(budgetWaitMs(sent.slice(4), T, 4)).toBe(0);
    expect(budgetWaitMs([], T, 4)).toBe(0);
  });

  it("never schedules under a minute, and waits for Pleos when it says so", () => {
    expect(nextDelayMs({ batteries: T, driving: T, locations: T, powertrains: T }, [], T)).toBe(MIN_DELAY_MS);
    expect(nextDelayMs(schedule({}, READS, "parked", T), [], T, 30 * MIN)).toBe(30 * MIN);
  });
});
