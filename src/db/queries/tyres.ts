import type { TyrePressureDto, TyrePressurePointDto, TyreRange } from "@shared/api-types";
import { tyreStates, tyresNeedAttention, type TyreReadingLike } from "@shared/tyres";
import type { SqlDatabase } from "../../platform/ports";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The window and bucket width of each range. Buckets are wide enough that a car
 * driven most days fills nearly all of them, and narrow enough that a slow leak
 * reads as a slope rather than a step: a night parked asleep leaves a 6-hour
 * bucket empty on the week view (the line breaks — nothing was read then), and
 * a week away leaves a weekly bucket empty on the year view.
 */
export const TYRE_RANGES: Record<TyreRange, { spanMs: number; bucketMs: number }> = {
  "7d": { spanMs: 7 * DAY, bucketMs: 6 * HOUR },
  "30d": { spanMs: 30 * DAY, bucketMs: DAY },
  "12m": { spanMs: 365 * DAY, bucketMs: 7 * DAY },
};

interface TyreRow {
  date_at: number;
  pressure_fl: number | null;
  pressure_fr: number | null;
  pressure_rl: number | null;
  pressure_rr: number | null;
  recommended_front: number | null;
  recommended_rear: number | null;
  soft_warning_fl: number | null;
  soft_warning_fr: number | null;
  soft_warning_rl: number | null;
  soft_warning_rr: number | null;
  hard_warning_fl: number | null;
  hard_warning_fr: number | null;
  hard_warning_rl: number | null;
  hard_warning_rr: number | null;
}

const flag = (n: number | null): boolean | null => (n == null ? null : n !== 0);

function readingOf(row: TyreRow): TyreReadingLike {
  return {
    fl: row.pressure_fl,
    fr: row.pressure_fr,
    rl: row.pressure_rl,
    rr: row.pressure_rr,
    rcpFront: row.recommended_front,
    rcpRear: row.recommended_rear,
    softFl: flag(row.soft_warning_fl),
    softFr: flag(row.soft_warning_fr),
    softRl: flag(row.soft_warning_rl),
    softRr: flag(row.soft_warning_rr),
    hardFl: flag(row.hard_warning_fl),
    hardFr: flag(row.hard_warning_fr),
    hardRl: flag(row.hard_warning_rl),
    hardRr: flag(row.hard_warning_rr),
  };
}

/** The newest tyre reading of a car, or null if none was ever recorded. */
export async function latestTyreReading(
  db: SqlDatabase,
  carId: number,
): Promise<{ at: number; reading: TyreReadingLike } | null> {
  const row = await db
    .prepare("SELECT * FROM tyre_readings WHERE car_id = ? ORDER BY date_at DESC LIMIT 1")
    .bind(carId)
    .first<TyreRow>();
  return row ? { at: row.date_at, reading: readingOf(row) } : null;
}

/**
 * The cars whose newest tyre reading asks for attention. One query for the
 * whole car list — the primary key makes each car's newest row a single seek.
 */
export async function carsNeedingTyreAttention(db: SqlDatabase): Promise<Set<number>> {
  const rows = await db
    .prepare(
      `SELECT t.* FROM cars c
       JOIN tyre_readings t ON t.car_id = c.id
        AND t.date_at = (SELECT MAX(t2.date_at) FROM tyre_readings t2 WHERE t2.car_id = c.id)`,
    )
    .all<TyreRow & { car_id: number }>();
  return new Set(rows.results.filter((row) => tyresNeedAttention(readingOf(row))).map((row) => row.car_id));
}

const round = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000);

/**
 * A car's pressures over a range, as evenly spaced buckets ending now. Every
 * bucket is returned; one with no reading carries nulls, so a chart drawn from
 * it breaks its line where nothing was read instead of joining across the gap.
 */
export async function tyrePressureSeries(
  db: SqlDatabase,
  opts: { carId: number; range: TyreRange; now: number },
): Promise<TyrePressureDto> {
  const { spanMs, bucketMs } = TYRE_RANGES[opts.range];
  // Buckets aligned to the epoch, not to `now`, so a chart refetched a minute
  // later averages the same readings into the same buckets.
  const to = Math.ceil(opts.now / bucketMs) * bucketMs;
  const from = to - spanMs;

  const rows = await db
    .prepare(
      // CAST, as in odometerSeries: a bound divisor arrives as REAL.
      `SELECT CAST(date_at / ?4 AS INTEGER) AS bucket,
              AVG(pressure_fl) AS fl, AVG(pressure_fr) AS fr,
              AVG(pressure_rl) AS rl, AVG(pressure_rr) AS rr,
              AVG(recommended_front) AS recommended_front, AVG(recommended_rear) AS recommended_rear
       FROM tyre_readings
       WHERE car_id = ?1 AND date_at >= ?2 AND date_at < ?3
       GROUP BY bucket ORDER BY bucket`,
    )
    .bind(opts.carId, from, to, bucketMs)
    .all<{
      bucket: number;
      fl: number | null;
      fr: number | null;
      rl: number | null;
      rr: number | null;
      recommended_front: number | null;
      recommended_rear: number | null;
    }>();

  const byBucket = new Map(rows.results.map((row) => [row.bucket, row]));
  const points: TyrePressurePointDto[] = [];
  for (let at = from; at < to; at += bucketMs) {
    const row = byBucket.get(Math.floor(at / bucketMs));
    points.push({
      at,
      fl: round(row?.fl ?? null),
      fr: round(row?.fr ?? null),
      rl: round(row?.rl ?? null),
      rr: round(row?.rr ?? null),
      recommendedFront: round(row?.recommended_front ?? null),
      recommendedRear: round(row?.recommended_rear ?? null),
    });
  }

  const latest = await latestTyreReading(db, opts.carId);
  return {
    carId: opts.carId,
    range: opts.range,
    from,
    to,
    bucketMs,
    current: { at: latest?.at ?? null, tyres: tyreStates(latest?.reading ?? null) },
    points,
  };
}
