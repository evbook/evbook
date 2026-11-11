import { describe, expect, it } from "bun:test";
import { estimateDriveOrigin, MAX_GAP_KM, MIN_GAP_KM, type ParkedPoint } from "./driveOrigin";

/** The position alone, for the tests that only look at where and when. */
const originOf = (...args: Parameters<typeof estimateDriveOrigin>) => estimateDriveOrigin(...args)?.position ?? null;

const T0 = 1_700_000_000_000;

const parked: ParkedPoint = {
  date_at: T0,
  latitude: 52.5,
  longitude: 13.4,
  odometer: 10_000,
  elevation: 34,
};

/** A sample 10 minutes later, 0.5 km down the road at 60 km/h. */
const first = { date_at: T0 + 600_000, odometer: 10_000.5, speed: 60 };

describe("estimateDriveOrigin", () => {
  it("places the origin at the parked point, backdated by gap over speed", () => {
    const origin = originOf(parked, first);
    expect(origin).not.toBeNull();
    expect(origin!.latitude).toBe(52.5);
    expect(origin!.longitude).toBe(13.4);
    expect(origin!.odometer).toBe(10_000);
    expect(origin!.elevation).toBe(34);
    // 0.5 km at 60 km/h is 30 s.
    expect(origin!.date_at).toBe(first.date_at - 30_000);
  });

  it("leaves telemetry unknown so aggregates skip the invented row", () => {
    const origin = originOf(parked, first)!;
    expect(origin.speed).toBeNull();
    expect(origin.power).toBeNull();
    expect(origin.battery_level).toBeNull();
    expect(origin.ideal_battery_range_km).toBeNull();
  });

  it("assumes 30 km/h when the first sample is slower", () => {
    const origin = originOf(parked, { ...first, speed: 5 })!;
    // 0.5 km at the assumed 30 km/h is 60 s.
    expect(origin.date_at).toBe(first.date_at - 60_000);
    expect(originOf(parked, { ...first, speed: null })!.date_at).toBe(first.date_at - 60_000);
  });

  it("never backdates past the parked point or into the first sample", () => {
    // Parked only 60 s before the sample: the estimate (60 s at 30 km/h)
    // must shrink to keep a 10 s margin on the parked side.
    const near = originOf({ ...parked, date_at: first.date_at - 60_000 }, { ...first, speed: 5 })!;
    expect(near.date_at).toBe(first.date_at - 50_000);

    // A tiny gap at high speed still keeps a 10 s margin before the sample.
    const fast = originOf(parked, { ...first, odometer: 10_000.06, speed: 120 })!;
    expect(fast.date_at).toBe(first.date_at - 10_000);
  });

  it("caps the backdate at 15 minutes for long undetected stretches", () => {
    const far = originOf(parked, {
      date_at: T0 + 3_600_000,
      odometer: 10_015,
      speed: 50,
    })!;
    // 15 km at 50 km/h would be 18 min; the timestamp stops at 15.
    expect(far.date_at).toBe(T0 + 3_600_000 - 15 * 60_000);
  });

  it("returns null when there is nothing trustworthy to reconstruct", () => {
    // No parked point at all.
    expect(originOf(null, first)).toBeNull();
    // No coordinates to anchor the origin to.
    expect(originOf({ ...parked, latitude: null }, first)).toBeNull();
    // No odometer on either side.
    expect(originOf({ ...parked, odometer: null }, first)).toBeNull();
    expect(originOf(parked, { ...first, odometer: null })).toBeNull();
    // Gap below noise or beyond trust.
    expect(originOf(parked, { ...first, odometer: parked.odometer! + MIN_GAP_KM / 2 })).toBeNull();
    expect(originOf(parked, { ...first, odometer: parked.odometer! + MAX_GAP_KM + 1 })).toBeNull();
    // Dense polling: the previous position is seconds old, nothing was missed.
    expect(originOf({ ...parked, date_at: first.date_at - 10_000 }, first)).toBeNull();
  });

  it("bounds the start between the last quiet reading and the first sample", () => {
    // Drive 7765: parked at 20:42, read offline until a probe 90 s before the
    // first sample, which is 290 m from home at 58 km/h.
    const night = { ...parked, odometer: 27_006.198 };
    const wake = { date_at: T0 + 10 * 3_600_000, odometer: 27_006.488, speed: 58 };
    const result = estimateDriveOrigin(night, wake, wake.date_at - 90_000)!;
    expect(result.startAfter).toBe(wake.date_at - 90_000);
    expect(result.startBefore).toBe(wake.date_at);
    expect(result.position.date_at).toBeGreaterThanOrEqual(result.startAfter);
    expect(result.position.date_at).toBeLessThan(wake.date_at);
    expect(result.position.latitude).toBe(parked.latitude);

    // Without a quiet reading the parked row is the bound.
    expect(estimateDriveOrigin(night, wake)!.startAfter).toBe(night.date_at);
  });

  it("places no origin when the odometer moved further than the quiet span explains", () => {
    // 8 km in the 90 s since the car was last read as offline: it was driven
    // while unreachable, and the stretch becomes a reconstructed drive instead.
    const wake = { date_at: T0 + 3_600_000, odometer: 10_008, speed: 50 };
    expect(estimateDriveOrigin(parked, wake, wake.date_at - 90_000)).toBeNull();
    // With an hour of quiet nobody vouched for, the same gap is a missed start.
    expect(estimateDriveOrigin(parked, wake)).not.toBeNull();
  });
});
