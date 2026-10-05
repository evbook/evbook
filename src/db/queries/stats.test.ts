import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLoggedCar } from "../../../test/seed";
import { zonedTimeToUtc } from "../../../shared/timeBuckets";
import { periodStats } from "./stats";
import type { SqlDatabase } from "../../platform/ports";

/**
 * `periodStats` used to run two queries for every bucket it returned, so asking for
 * a year by day meant seven hundred and thirty round trips to D1. It groups the
 * buckets in SQL now. The behavioural tests live in src/api/stats.test.ts, which
 * goes through the router; what is pinned here is the cost, because that is the
 * part a later refactor can quietly undo without any assertion noticing.
 */

const CAR_ID = 44;
const BERLIN = "Europe/Berlin";

/** Counts how many statements a body prepares against the database. */
function counting(db: SqlDatabase): { db: SqlDatabase; prepared: () => number } {
  let prepared = 0;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          prepared++;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, prepared: () => prepared };
}

async function addDrive(at: number, distance: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO drives (car_id, start_date_at, end_date_at, distance, duration_min,
                         start_rated_range_km, end_rated_range_km)
     VALUES (?, ?, ?, ?, 30, 300, 290)`,
  )
    .bind(CAR_ID, at, at + 1_800_000, distance)
    .run();
}

async function addCharge(at: number, addedKwh: number, usedKwh: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, charge_energy_used)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(CAR_ID, at, at + 1_800_000, addedKwh, usedKwh)
    .run();
}

const options = (from: number, to: number, period: "day" | "month" | "year") =>
  ({ from, to, period, timezone: BERLIN, preferredRange: "rated" }) as const;

describe("period statistics cost", () => {
  beforeEach(async () => {
    await resetLoggedCar(CAR_ID, { timezone: BERLIN, efficiency: 0.15 });
  });

  it("takes the same two queries for one bucket as for hundreds", async () => {
    const oneDay = counting(env.DB);
    await periodStats(
      oneDay.db,
      options(zonedTimeToUtc(BERLIN, 2026, 7, 1, 0), zonedTimeToUtc(BERLIN, 2026, 7, 2, 0), "day"),
    );

    const oneYear = counting(env.DB);
    const result = await periodStats(
      oneYear.db,
      options(zonedTimeToUtc(BERLIN, 2026, 1, 1, 0), zonedTimeToUtc(BERLIN, 2026, 12, 31, 0), "day"),
    );

    expect(result.buckets.length).toBeGreaterThan(360);
    expect(oneDay.prepared()).toBe(2);
    expect(oneYear.prepared()).toBe(2);
  });

  it("still totals correctly across hundreds of buckets", async () => {
    await addDrive(zonedTimeToUtc(BERLIN, 2026, 1, 15, 12), 100);
    await addDrive(zonedTimeToUtc(BERLIN, 2026, 6, 20, 12), 50);
    await addDrive(zonedTimeToUtc(BERLIN, 2026, 12, 24, 12), 25);

    const result = await periodStats(
      env.DB,
      options(zonedTimeToUtc(BERLIN, 2026, 1, 1, 0), zonedTimeToUtc(BERLIN, 2026, 12, 31, 0), "day"),
    );

    const byKey = new Map(result.buckets.map((b) => [b.key, b]));
    expect(byKey.get("2026-01-15")?.driveCount).toBe(1);
    expect(byKey.get("2026-01-15")?.distanceKm).toBeCloseTo(100, 5);
    expect(byKey.get("2026-06-20")?.distanceKm).toBeCloseTo(50, 5);
    expect(byKey.get("2026-12-24")?.distanceKm).toBeCloseTo(25, 5);
    // Every other day is present and empty rather than missing.
    expect(byKey.get("2026-03-03")?.driveCount).toBe(0);
    expect(byKey.get("2026-03-03")?.distanceKm).toBeNull();
    expect(result.buckets.reduce((sum, b) => sum + b.driveCount, 0)).toBe(3);
  });

  it("reports one charged-energy total however the sessions are grouped", async () => {
    // Two sessions on opposite sides of the year where the two energy figures
    // disagree in opposite directions: the pack drew more than the wall added on
    // one, less on the other. Summing the per-session maxima gives 20 + 30 = 50.
    // Taking max(Σadded, Σused) per bucket — the old rule — gives max(40, 25) = 40
    // for a single year bucket but 20 + 30 = 50 for two month buckets, so the same
    // sessions read back two different totals depending on the grouping.
    await addCharge(zonedTimeToUtc(BERLIN, 2026, 1, 15, 12), 10, 20);
    await addCharge(zonedTimeToUtc(BERLIN, 2026, 7, 20, 12), 30, 5);

    const from = zonedTimeToUtc(BERLIN, 2026, 1, 1, 0);
    const to = zonedTimeToUtc(BERLIN, 2026, 12, 31, 0);
    const total = async (period: "day" | "month" | "year") =>
      (await periodStats(env.DB, options(from, to, period))).buckets.reduce(
        (sum, b) => sum + (b.energyChargedKwh ?? 0),
        0,
      );

    expect(await total("year")).toBeCloseTo(50, 5);
    expect(await total("month")).toBeCloseTo(50, 5);
    expect(await total("day")).toBeCloseTo(50, 5);

    // Each session lands in its own bucket at its own per-session maximum, and the
    // months that hold nothing report null energy rather than a phantom 0 kWh.
    const months = await periodStats(env.DB, options(from, to, "month"));
    const withEnergy = months.buckets.filter((b) => b.energyChargedKwh != null);
    expect(withEnergy.map((b) => b.energyChargedKwh).sort((a, b) => a! - b!)).toEqual([20, 30]);
    expect(months.buckets.every((b) => b.chargeCount > 0 || b.energyChargedKwh === null)).toBe(true);
  });

  it("counts a session that moved no energy as neither a charge nor kilowatt-hours", async () => {
    // Plugged in, nothing drawn — excluded from the roll-ups everywhere else, so it
    // must not pad the charge count or the energy here either.
    await addCharge(zonedTimeToUtc(BERLIN, 2026, 3, 10, 12), 12, 13);
    await addCharge(zonedTimeToUtc(BERLIN, 2026, 3, 11, 12), 0, 0);

    const result = await periodStats(
      env.DB,
      options(zonedTimeToUtc(BERLIN, 2026, 3, 1, 0), zonedTimeToUtc(BERLIN, 2026, 4, 1, 0), "month"),
    );
    const march = result.buckets.find((b) => (b.energyChargedKwh ?? 0) > 0);
    expect(march?.chargeCount).toBe(1);
    expect(march?.energyChargedKwh).toBeCloseTo(13, 5);
  });

  it("asks nothing at all when the range is inverted", async () => {
    const counted = counting(env.DB);
    const result = await periodStats(
      counted.db,
      options(zonedTimeToUtc(BERLIN, 2026, 7, 10, 0), zonedTimeToUtc(BERLIN, 2026, 7, 1, 0), "month"),
    );
    expect(result.buckets).toEqual([]);
    expect(counted.prepared()).toBe(0);
  });
});
