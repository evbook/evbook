import { describe, expect, it } from "bun:test";
import { estimateDriveOrigin, MAX_GAP_KM, MIN_GAP_KM, type ParkedPoint } from "./driveOrigin";

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
    const origin = estimateDriveOrigin(parked, first);
    expect(origin).not.toBeNull();
    expect(origin!.latitude).toBe(52.5);
    expect(origin!.longitude).toBe(13.4);
    expect(origin!.odometer).toBe(10_000);
    expect(origin!.elevation).toBe(34);
    // 0.5 km at 60 km/h is 30 s.
    expect(origin!.date_at).toBe(first.date_at - 30_000);
  });

  it("leaves telemetry unknown so aggregates skip the invented row", () => {
    const origin = estimateDriveOrigin(parked, first)!;
    expect(origin.speed).toBeNull();
    expect(origin.power).toBeNull();
    expect(origin.battery_level).toBeNull();
    expect(origin.ideal_battery_range_km).toBeNull();
  });

  it("assumes 30 km/h when the first sample is slower", () => {
    const origin = estimateDriveOrigin(parked, { ...first, speed: 5 })!;
    // 0.5 km at the assumed 30 km/h is 60 s.
    expect(origin.date_at).toBe(first.date_at - 60_000);
    expect(estimateDriveOrigin(parked, { ...first, speed: null })!.date_at).toBe(
      first.date_at - 60_000,
    );
  });

  it("never backdates past the parked point or into the first sample", () => {
    // Parked only 60 s before the sample: the estimate (60 s at 30 km/h)
    // must shrink to keep a 10 s margin on the parked side.
    const near = estimateDriveOrigin({ ...parked, date_at: first.date_at - 60_000 }, { ...first, speed: 5 })!;
    expect(near.date_at).toBe(first.date_at - 50_000);

    // A tiny gap at high speed still keeps a 10 s margin before the sample.
    const fast = estimateDriveOrigin(parked, { ...first, odometer: 10_000.06, speed: 120 })!;
    expect(fast.date_at).toBe(first.date_at - 10_000);
  });

  it("caps the backdate at 15 minutes for long undetected stretches", () => {
    const far = estimateDriveOrigin(parked, {
      date_at: T0 + 3_600_000,
      odometer: 10_015,
      speed: 50,
    })!;
    // 15 km at 50 km/h would be 18 min; the timestamp stops at 15.
    expect(far.date_at).toBe(T0 + 3_600_000 - 15 * 60_000);
  });

  it("returns null when there is nothing trustworthy to reconstruct", () => {
    // No parked point at all.
    expect(estimateDriveOrigin(null, first)).toBeNull();
    // No coordinates to anchor the origin to.
    expect(estimateDriveOrigin({ ...parked, latitude: null }, first)).toBeNull();
    // No odometer on either side.
    expect(estimateDriveOrigin({ ...parked, odometer: null }, first)).toBeNull();
    expect(estimateDriveOrigin(parked, { ...first, odometer: null })).toBeNull();
    // Gap below noise or beyond trust.
    expect(estimateDriveOrigin(parked, { ...first, odometer: parked.odometer! + MIN_GAP_KM / 2 })).toBeNull();
    expect(estimateDriveOrigin(parked, { ...first, odometer: parked.odometer! + MAX_GAP_KM + 1 })).toBeNull();
    // Dense polling: the previous position is seconds old, nothing was missed.
    expect(estimateDriveOrigin({ ...parked, date_at: first.date_at - 10_000 }, first)).toBeNull();
  });
});
