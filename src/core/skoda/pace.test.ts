import { describe, expect, it } from "bun:test";
import { HOURLY_CAP, PACE_MS, budgetWaitMs, intervalFor, nextDelayMs, prune } from "./pace";

const MIN = 60_000;
const NOW = 10_000_000;

describe("pace", () => {
  it("reads every 5 minutes while active or settling, every 30 while parked", () => {
    expect(intervalFor("driving", 0)).toBe(5 * MIN);
    expect(intervalFor("charging", 0)).toBe(5 * MIN);
    expect(intervalFor("parked", 2)).toBe(5 * MIN);
    expect(intervalFor("parked", 0)).toBe(30 * MIN);
  });

  it("keeps an active car inside the hourly guard", () => {
    // Twelve reads an hour at five minutes: under the cap of 18, so no wait.
    const sent = Array.from({ length: 12 }, (_, i) => NOW - i * 5 * MIN);
    expect(nextDelayMs({ mode: "driving", settleLeft: 0, sent, now: NOW })).toBe(PACE_MS.active);
  });

  it("holds the next read back once the hour is full", () => {
    const sent = Array.from({ length: HOURLY_CAP }, (_, i) => NOW - i * MIN);
    // The oldest leaves the window 60 - 17 = 43 minutes from now.
    expect(budgetWaitMs(sent, NOW)).toBe(43 * MIN);
    expect(nextDelayMs({ mode: "driving", settleLeft: 0, sent, now: NOW })).toBe(43 * MIN);
  });

  it("waits for Škoda's window when Škoda says nothing is left", () => {
    expect(nextDelayMs({ mode: "driving", settleLeft: 0, sent: [], now: NOW, serverWaitMs: 40 * MIN })).toBe(40 * MIN);
  });

  it("forgets sends older than an hour", () => {
    expect(prune([NOW - 61 * MIN, NOW - 59 * MIN, NOW], NOW)).toEqual([NOW - 59 * MIN, NOW]);
  });
});
