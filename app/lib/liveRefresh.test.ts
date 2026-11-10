import { describe, expect, it } from "bun:test";
import type { CarSummaryDto } from "@shared/api-types";
import { BOOST_MS, LIVE_REFRESH_MS, boostLiveRefresh, liveRefreshInterval } from "./liveRefresh";

/** The overview polls as fast as the busiest car moves, and no faster. */

const NOW = 1_700_000_000_000;

const car = (state: string) => ({ state }) as CarSummaryDto;

describe("liveRefreshInterval", () => {
  it("polls fast while any car is driving or charging", () => {
    expect(liveRefreshInterval([car("asleep"), car("driving")], NOW)).toBe(LIVE_REFRESH_MS.active);
    expect(liveRefreshInterval([car("charging")], NOW)).toBe(LIVE_REFRESH_MS.active);
  });

  it("polls at the actor's default cadence while a car is awake but parked", () => {
    expect(liveRefreshInterval([car("asleep"), car("online")], NOW)).toBe(LIVE_REFRESH_MS.awake);
    expect(liveRefreshInterval([car("falling_asleep")], NOW)).toBe(LIVE_REFRESH_MS.awake);
    expect(liveRefreshInterval([car("updating")], NOW)).toBe(LIVE_REFRESH_MS.awake);
  });

  it("slows right down when every car is asleep or offline", () => {
    expect(liveRefreshInterval([car("asleep"), car("offline")], NOW)).toBe(LIVE_REFRESH_MS.idle);
  });

  it("does not idle before it knows anything", () => {
    expect(liveRefreshInterval(undefined, NOW)).toBe(LIVE_REFRESH_MS.awake);
    expect(liveRefreshInterval([], NOW)).toBe(LIVE_REFRESH_MS.awake);
  });

  it("polls fast for a while after a wake, even while the car still reads asleep", () => {
    boostLiveRefresh(NOW);
    expect(liveRefreshInterval([car("asleep")], NOW + 1_000)).toBe(LIVE_REFRESH_MS.active);
    expect(liveRefreshInterval([car("asleep")], NOW + BOOST_MS)).toBe(LIVE_REFRESH_MS.idle);
  });
});
