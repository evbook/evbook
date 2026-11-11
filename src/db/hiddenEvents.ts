import { findHiddenEvents, MAX_HIDDEN_SPAN_MS, type HiddenEvent, type Reading } from "../core/gaps";
import { repriceCharge } from "./pricing";
import { Repo } from "./repo";
import type { SqlDatabase } from "../platform/ports";

/**
 * Records the drives and charges nobody saw — see core/gaps.ts for the rule.
 *
 * Walks history oldest first in windows, resuming from
 * `settings.gaps_swept_until`, and only once the drive-origin sweep is done: a
 * gap before a drive's first sample is that sweep's to explain first, and
 * finding it here before the sweep extends the drive over it would count the
 * same stretch twice. The newest couple of hours wait as well, so a drive the
 * poller is still closing is not mistaken for a gap.
 *
 * Reconstructed rows are themselves events to the next pass, so a rewound sweep
 * (an import landing, say) finds their gaps spanned and adds nothing twice.
 * They are written without addresses; the address repair resolves those from
 * the readings' positions like any other row's.
 */

/** History examined per run. */
const WINDOW_MS = 14 * 24 * 3_600_000;
/** How recent a gap has to be left alone, so the live logger can finish with it. */
const SETTLE_MS = 2 * 3_600_000;
/** Events written per run. */
const MAX_PER_RUN = 20;

export async function reconstructHiddenEvents(db: SqlDatabase, now = Date.now()): Promise<{ recorded: number }> {
  const settings = await db
    .prepare("SELECT drive_origin_swept_before AS origins, gaps_swept_until AS cursor FROM settings WHERE id = 1")
    .first<{ origins: number | null; cursor: number | null }>();
  if (settings == null || settings.origins !== 0) return { recorded: 0 };

  const from = settings.cursor ?? (await earliestReading(db));
  if (from == null) return { recorded: 0 };
  const to = Math.min(from + WINDOW_MS, now - SETTLE_MS);
  if (to <= from) return { recorded: 0 };

  const cars = await db.prepare("SELECT id FROM cars ORDER BY id").all<{ id: number }>();
  let recorded = 0;
  let reached = to;
  for (const car of cars.results) {
    const readings = await readingsFor(db, car.id, from - MAX_HIDDEN_SPAN_MS, to);
    const hidden = findHiddenEvents(readings).filter((e) => e.to.at > from && e.to.at <= to);
    for (const event of hidden) {
      if (recorded >= MAX_PER_RUN) {
        // Budget spent: the rest of this window waits for the next run.
        reached = Math.min(reached, event.to.at - 1);
        break;
      }
      await record(db, car.id, event);
      recorded++;
    }
  }

  // Advance only from where this run started, so a rewind landing meanwhile wins.
  await db
    .prepare("UPDATE settings SET gaps_swept_until = ? WHERE id = 1 AND gaps_swept_until IS ?")
    .bind(reached, settings.cursor)
    .run();
  return { recorded };
}

async function earliestReading(db: SqlDatabase): Promise<number | null> {
  // Per car, so each MIN is one step down the (car_id, date_at) index.
  const row = await db
    .prepare("SELECT MIN((SELECT MIN(p.date_at) FROM positions p WHERE p.car_id = c.id)) AS at FROM cars c")
    .first<{ at: number | null }>();
  return row?.at ?? null;
}

/**
 * Every reading of one car in a window, in time order: both ends of each drive
 * and charge, and the parked positions between them. A parked row inside an
 * event's span is the event's own (the wake row a drive opens on, a session's
 * position) and would only pair with it falsely.
 */
async function readingsFor(db: SqlDatabase, carId: number, from: number, to: number): Promise<Reading[]> {
  const drives = await db
    .prepare(
      `SELECT d.id, d.start_date_at, d.end_date_at, d.start_km, d.end_km, d.reconstructed,
              d.start_position_id, d.end_position_id,
              COALESCE(
                (SELECT p.battery_level FROM positions p
                 WHERE p.drive_id = d.id AND p.battery_level IS NOT NULL ORDER BY p.date_at LIMIT 1),
                sp.battery_level) AS start_soc,
              ep.battery_level AS end_soc
       FROM drives d
       LEFT JOIN positions sp ON sp.id = d.start_position_id
       LEFT JOIN positions ep ON ep.id = d.end_position_id
       WHERE d.car_id = ?1 AND d.end_date_at IS NOT NULL AND d.end_date_at >= ?2 AND d.start_date_at <= ?3`,
    )
    .bind(carId, from, to)
    .all<{
      id: number;
      start_date_at: number;
      end_date_at: number;
      start_km: number | null;
      end_km: number | null;
      reconstructed: number;
      start_position_id: number | null;
      end_position_id: number | null;
      start_soc: number | null;
      end_soc: number | null;
    }>();

  const charges = await db
    .prepare(
      `SELECT cp.id, cp.start_date_at, cp.end_date_at, cp.start_battery_level, cp.end_battery_level,
              cp.position_id, p.odometer
       FROM charging_processes cp LEFT JOIN positions p ON p.id = cp.position_id
       WHERE cp.car_id = ?1 AND cp.end_date_at IS NOT NULL AND cp.end_date_at >= ?2 AND cp.start_date_at <= ?3`,
    )
    .bind(carId, from, to)
    .all<{
      id: number;
      start_date_at: number;
      end_date_at: number;
      start_battery_level: number | null;
      end_battery_level: number | null;
      position_id: number | null;
      odometer: number | null;
    }>();

  const parked = await db
    .prepare(
      `SELECT id, date_at, odometer, battery_level FROM positions
       WHERE car_id = ?1 AND drive_id IS NULL AND date_at >= ?2 AND date_at <= ?3
       ORDER BY date_at`,
    )
    .bind(carId, from, to)
    .all<{ id: number; date_at: number; odometer: number | null; battery_level: number | null }>();

  const readings: Reading[] = [];
  const spans: [number, number][] = [];
  for (const d of drives.results) {
    spans.push([d.start_date_at, d.end_date_at]);
    // A reconstructed drive already spans its gap; its ends need no figures.
    const known = d.reconstructed === 0;
    readings.push(
      {
        at: d.start_date_at,
        km: known ? d.start_km : null,
        soc: known ? d.start_soc : null,
        positionId: d.start_position_id,
        event: { kind: "drive", id: d.id, end: "start" },
      },
      {
        at: d.end_date_at,
        km: known ? d.end_km : null,
        soc: known ? d.end_soc : null,
        positionId: d.end_position_id,
        event: { kind: "drive", id: d.id, end: "end" },
      },
    );
  }
  for (const c of charges.results) {
    spans.push([c.start_date_at, c.end_date_at]);
    readings.push(
      {
        at: c.start_date_at,
        km: c.odometer,
        soc: c.start_battery_level,
        positionId: c.position_id,
        event: { kind: "charge", id: c.id, end: "start" },
      },
      {
        at: c.end_date_at,
        km: c.odometer,
        soc: c.end_battery_level,
        positionId: c.position_id,
        event: { kind: "charge", id: c.id, end: "end" },
      },
    );
  }
  for (const p of parked.results) {
    if (spans.some(([start, end]) => p.date_at >= start && p.date_at <= end)) continue;
    readings.push({ at: p.date_at, km: p.odometer, soc: p.battery_level, positionId: p.id });
  }

  // Starts before ends at the same instant, so a zero-length gap between two
  // events never reads as one of them having closed early.
  const rank = (r: Reading) => (r.event?.end === "end" ? 0 : r.event ? 2 : 1);
  return readings.sort((a, b) => a.at - b.at || rank(a) - rank(b));
}

async function record(db: SqlDatabase, carId: number, event: HiddenEvent): Promise<void> {
  const repo = new Repo(db, carId);
  const after = event.from.at;
  const before = event.to.at;

  if (event.kind === "drive") {
    const [startGeofence, endGeofence] = await Promise.all([
      repo.geofenceForPosition(event.from.positionId),
      repo.geofenceForPosition(event.to.positionId),
    ]);
    await db
      .prepare(
        `INSERT INTO drives (car_id, start_date_at, end_date_at, start_after_at, start_before_at,
                             end_after_at, end_before_at, distance, start_km, end_km,
                             start_position_id, end_position_id, start_geofence_id, end_geofence_id, reconstructed)
         VALUES (?1, ?2, ?3, ?2, ?3, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)`,
      )
      .bind(
        carId,
        after,
        before,
        event.km,
        event.from.km,
        event.to.km,
        event.from.positionId,
        event.to.positionId,
        startGeofence,
        endGeofence,
      )
      .run();
    return;
  }

  // Where it charged is known only if the car did not also move in the gap.
  const stayed =
    event.from.km != null && event.to.km != null && Math.abs(event.to.km - event.from.km) < 0.5 ? event.from : null;
  const positionId = stayed?.positionId ?? null;
  const geofenceId = await repo.geofenceForPosition(positionId);
  const inserted = await db
    .prepare(
      `INSERT INTO charging_processes (car_id, start_date_at, end_date_at, start_after_at, start_before_at,
                                       end_after_at, end_before_at, start_battery_level, end_battery_level,
                                       position_id, geofence_id, reconstructed)
       VALUES (?1, ?2, ?3, ?2, ?3, ?2, ?3, ?4, ?5, ?6, ?7, 1) RETURNING id`,
    )
    .bind(carId, after, before, event.socFrom, event.socTo, positionId, geofenceId)
    .first<{ id: number }>();
  // What the place's tariff makes of the rise (db/pricing.ts).
  if (inserted) await repriceCharge(db, inserted.id);
}
