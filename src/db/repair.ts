import { estimateDriveOrigin } from "../core/driveOrigin";
import { STALE_MS } from "./queries/dataHealth";
import { Repo } from "./repo";
import type { SqlDatabase } from "../platform/ports";

/**
 * Backfills addresses that reverse geocoding could not resolve when the drive
 * or charge was recorded — the equivalent of TeslaMate's Repair worker. Runs on
 * the cron trigger and is deliberately slow: Nominatim asks for at most one
 * request per second.
 */

const MAX_PER_RUN = 8;
const THROTTLE_MS = 1_200;

async function throttle(): Promise<void> {
  // Not `scheduler.wait`: that global is workerd/Node-22+ only, and this module
  // must run on every provider.
  await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
}

export async function repairMissingAddresses(db: SqlDatabase, geocoderBaseUrl?: string): Promise<{ repaired: number }> {
  let repaired = 0;

  const drives = await db
    .prepare(
      "SELECT d.id, d.car_id, d.start_address_id, d.end_address_id, " +
        "sp.latitude AS s_lat, sp.longitude AS s_lon, ep.latitude AS e_lat, ep.longitude AS e_lon " +
        "FROM drives d " +
        "LEFT JOIN positions sp ON sp.id = d.start_position_id " +
        "LEFT JOIN positions ep ON ep.id = d.end_position_id " +
        "WHERE d.end_date_at IS NOT NULL " +
        // Redundant given the two-sided check below, but stated on its own it
        // matches drives_missing_address (0006) word for word, which is what
        // lets the planner use that index instead of walking every drive.
        "  AND (d.start_address_id IS NULL OR d.end_address_id IS NULL) " +
        "  AND ((d.start_address_id IS NULL AND sp.latitude IS NOT NULL) " +
        "    OR (d.end_address_id IS NULL AND ep.latitude IS NOT NULL)) " +
        "ORDER BY d.start_date_at DESC LIMIT ?",
    )
    .bind(MAX_PER_RUN)
    .all<{
      id: number;
      car_id: number;
      start_address_id: number | null;
      end_address_id: number | null;
      s_lat: number | null;
      s_lon: number | null;
      e_lat: number | null;
      e_lon: number | null;
    }>();

  for (const drive of drives.results) {
    const repo = new Repo(db, drive.car_id, geocoderBaseUrl);
    let startId = drive.start_address_id;
    let endId = drive.end_address_id;

    if (startId == null && drive.s_lat != null) {
      startId = await repo.resolveAddress(drive.s_lat, drive.s_lon);
      await throttle();
    }
    if (endId == null && drive.e_lat != null) {
      endId = await repo.resolveAddress(drive.e_lat, drive.e_lon);
      await throttle();
    }
    if (startId !== drive.start_address_id || endId !== drive.end_address_id) {
      await db
        .prepare("UPDATE drives SET start_address_id = ?, end_address_id = ? WHERE id = ?")
        .bind(startId, endId, drive.id)
        .run();
      repaired++;
    }
  }

  const sessions = await db
    .prepare(
      "SELECT cp.id, cp.car_id, p.latitude, p.longitude FROM charging_processes cp " +
        "LEFT JOIN positions p ON p.id = cp.position_id " +
        "WHERE cp.address_id IS NULL AND p.latitude IS NOT NULL " +
        "ORDER BY cp.start_date_at DESC LIMIT ?",
    )
    .bind(MAX_PER_RUN)
    .all<{ id: number; car_id: number; latitude: number; longitude: number }>();

  for (const session of sessions.results) {
    const addressId = await new Repo(db, session.car_id, geocoderBaseUrl).resolveAddress(
      session.latitude,
      session.longitude,
    );
    await throttle();
    if (addressId != null) {
      await db.prepare("UPDATE charging_processes SET address_id = ? WHERE id = ?").bind(addressId, session.id).run();
      repaired++;
    }
  }

  return { repaired };
}

/**
 * Ask the POI layer about places that were geocoded before it was being asked,
 * and that came back naming nothing finer than their town.
 *
 * These are the rows that read as a bare town — or, before 0011 normalised the
 * empty strings Nominatim sends, as a dash. `resolveAddress` handles new points
 * itself; this is only for the backlog, and once a row is marked it is never
 * asked about again however the question went.
 *
 * Relinking is per endpoint, against that endpoint's *own* coordinates, never the
 * address row's. One nameless road is shared by every stop along it, and the
 * whole point of a radius is that it decides one stop at a time.
 */
export async function repairMissingPois(
  db: SqlDatabase,
  geocoderBaseUrl?: string,
): Promise<{ checked: number; named: number }> {
  const rows = await db
    .prepare(
      "SELECT id FROM addresses " +
        "WHERE poi_checked_at IS NULL AND poi_category IS NULL " +
        // Nothing finer than a town: no street, and no name of its own. A row
        // that already says "Torstraße 1" is not what this is for.
        "  AND NULLIF(TRIM(COALESCE(road, '')), '') IS NULL " +
        "  AND NULLIF(TRIM(COALESCE(name, '')), '') IS NULL " +
        "ORDER BY id LIMIT ?",
    )
    .bind(MAX_PER_RUN)
    .all<{ id: number }>();

  let checked = 0;
  let named = 0;
  for (const row of rows.results) {
    const sites = await endpointsAt(db, row.id);
    let answered = sites.length > 0;

    for (const site of sites) {
      const repo = new Repo(db, site.carId, geocoderBaseUrl);
      const resolved = await repo.resolveAddress(site.latitude, site.longitude);
      await throttle();
      // A point the geocoder would not answer for at all. Leave the row unmarked
      // so a later sweep tries again: a rate-limited minute must not spend the
      // backlog.
      if (resolved == null) {
        answered = false;
        continue;
      }
      if (resolved === row.id) continue;
      await db.prepare(`UPDATE ${site.table} SET ${site.column} = ? WHERE id = ?`).bind(resolved, site.id).run();
      named++;
    }

    // Marked only once every endpoint on it got a real answer. A row nothing
    // points at any more is marked too — there is no coordinate left to ask
    // about, so leaving it would make the sweep loop on it forever.
    if (answered || sites.length === 0) {
      await db.prepare("UPDATE addresses SET poi_checked_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
      checked++;
    }
  }

  return { checked, named };
}

/** At most this many closed per run: each one aggregates, geocodes and re-derives. */
const MAX_SESSIONS_PER_RUN = 4;

interface AbandonedRow {
  tbl: "drives" | "charging_processes" | "updates";
  id: number;
  car_id: number;
  start_at: number;
  version: string | null;
}

/**
 * Give an end to the spans nothing else ever will.
 *
 * A Worker evicted mid-drive, a stopped import or an upgrade landing between two
 * polls all leave a row with a start and no end, and the state machine that would
 * have closed it has moved on. The Diagnostics card has always *reported* these;
 * nothing closed them, so they accumulated, and because the History band draws
 * driving and charging over the sleep states beneath them, one abandoned drive
 * went on painting itself over every day since — hiding real charges behind a
 * months-long drive that lasted seven minutes.
 *
 * The rule for "abandoned" is `queries/dataHealth`'s, because the card and the
 * sweep disagreeing about it would be the worst of both: something newer in the
 * *same* table, or open longer than anything real stays open. A live drive is the
 * newest drive and younger than the cutoff, so it is never touched.
 *
 * Each row is closed the way the state machine would have closed it, from the
 * samples it did record — never at `now`, which would turn a fifteen-minute
 * charge from last summer into an eleven-month one.
 */
export async function closeAbandonedSessions(
  db: SqlDatabase,
  geocoderBaseUrl?: string,
  now = Date.now(),
): Promise<{ closed: number }> {
  /** Open, and either superseded in its own table or older than anything live. */
  const branch = (table: string, alias: string, version: string) =>
    `SELECT '${table}' AS tbl, ${alias}.id AS id, ${alias}.car_id AS car_id,
            ${alias}.start_date_at AS start_at, ${version} AS version
     FROM ${table} ${alias}
     WHERE ${alias}.end_date_at IS NULL
       AND (EXISTS (SELECT 1 FROM ${table} n
                    WHERE n.car_id = ${alias}.car_id AND n.start_date_at > ${alias}.start_date_at)
            OR ${alias}.start_date_at < ?1)`;

  const rows = await db
    .prepare(
      `SELECT * FROM (${[
        branch("drives", "d", "NULL"),
        branch("charging_processes", "cp", "NULL"),
        branch("updates", "up", "up.version"),
      ].join(" UNION ALL ")}) ORDER BY start_at LIMIT ?2`,
    )
    .bind(now - STALE_MS, MAX_SESSIONS_PER_RUN)
    .all<AbandonedRow>();

  let closed = 0;
  for (const row of rows.results) {
    const repo = new Repo(db, row.car_id, geocoderBaseUrl);
    switch (row.tbl) {
      case "drives":
        // Ends at its last position, or is deleted if it never got two of them.
        await repo.closeDrive(row.id);
        break;
      case "charging_processes": {
        const samples = await db
          .prepare("SELECT COUNT(*) AS n FROM charges WHERE charging_process_id = ?")
          .bind(row.id)
          .first<{ n: number }>();
        // With samples this ends at the last one and derives energy and cost as
        // usual. Without any, there is nothing to aggregate and nothing to date
        // it by, so it collapses to the instant it opened: an empty span the band
        // cannot draw, still listed on the timeline as a charge that logged nothing.
        if ((samples?.n ?? 0) > 0) await repo.completeChargingProcess(row.id);
        else await closeAtStart(db, "charging_processes", row.id);
        break;
      }
      case "updates":
        // An install we saw start and never saw finish. Its end is unknowable, so
        // it gets its own start rather than an invented duration.
        await repo.finishUpdate(row.id, row.version, row.start_at);
        break;
    }
    closed++;
  }

  return { closed };
}

/** Drives examined per run — the sweep's read budget. */
const SWEEP_WINDOW = 50;
/** Drives actually re-aggregated per run — each one geocodes, like a close. */
const MAX_ORIGINS_PER_RUN = 4;

interface OriginCandidate {
  id: number;
  car_id: number;
  first_at: number | null;
  first_km: number | null;
  first_speed: number | null;
  parked_at: number | null;
  parked_lat: number | null;
  parked_lon: number | null;
  parked_km: number | null;
  parked_elev: number | null;
}

/**
 * Give old drives the origin the poller missed.
 *
 * Every drive recorded on the slow clock starts at the first sample, not where
 * the car actually pulled away — see core/driveOrigin.ts for the window and the
 * reconstruction. New drives get their origin as they open; this walks the
 * backlog once, newest first, resuming from `settings.drive_origin_swept_before`
 * so a finished sweep costs one row read per run and nothing more.
 *
 * A repaired drive is re-aggregated through `closeDrive`, which recomputes
 * distance, duration and the start address from the position rows — the same
 * code path that would have produced them had the origin been seen live.
 */
export async function repairDriveOrigins(
  db: SqlDatabase,
  geocoderBaseUrl?: string,
): Promise<{ examined: number; repaired: number }> {
  const cursor =
    (
      await db
        .prepare("SELECT drive_origin_swept_before AS wm FROM settings WHERE id = 1")
        .first<{ wm: number | null }>()
    )?.wm ?? null;
  if (cursor !== null && cursor <= 0) return { examined: 0, repaired: 0 };

  // The window is taken by id alone so every drive is examined exactly once,
  // matching or not; the neighbour joins bring what the estimate needs. The
  // previous position by time is where the car sat when the drive began —
  // typically the previous drive's end or the pre-suspend heartbeat.
  const rows = await db
    .prepare(
      `SELECT d.id, d.car_id,
              sp.date_at AS first_at, sp.odometer AS first_km, sp.speed AS first_speed,
              pp.date_at AS parked_at, pp.latitude AS parked_lat, pp.longitude AS parked_lon,
              pp.odometer AS parked_km, pp.elevation AS parked_elev
       FROM (SELECT id, car_id, start_position_id FROM drives
             WHERE (?1 IS NULL OR id < ?1) AND end_date_at IS NOT NULL
             ORDER BY id DESC LIMIT ?2) AS d
       LEFT JOIN positions sp ON sp.id = d.start_position_id
       LEFT JOIN positions pp ON pp.id =
         (SELECT p.id FROM positions p
          WHERE p.car_id = d.car_id AND p.date_at < sp.date_at
          ORDER BY p.date_at DESC LIMIT 1)
       ORDER BY d.id DESC`,
    )
    .bind(cursor, SWEEP_WINDOW)
    .all<OriginCandidate>();

  let examined = 0;
  let repaired = 0;
  let next = cursor;
  for (const row of rows.results) {
    // Budget spent: the unexamined rest of the window waits for the next run.
    if (repaired >= MAX_ORIGINS_PER_RUN) break;
    next = row.id;
    examined++;

    if (row.first_at == null || row.first_km == null || row.parked_km == null) continue;
    // The estimate's own thresholds decide, exactly as they would have live —
    // a 30 s pull-away at city speed is barely 150 m, and that artifact is the
    // whole reason the sweep exists.
    const origin = estimateDriveOrigin(
      {
        date_at: row.parked_at!,
        latitude: row.parked_lat,
        longitude: row.parked_lon,
        odometer: row.parked_km,
        elevation: row.parked_elev,
      },
      { date_at: row.first_at, odometer: row.first_km, speed: row.first_speed },
    );
    if (!origin) continue;

    const repo = new Repo(db, row.car_id, geocoderBaseUrl);
    await repo.insertPositions([{ driveId: row.id, attrs: origin }]);
    await repo.closeDrive(row.id);
    await throttle();
    repaired++;
  }

  // A short window means the batch reached the oldest drive; if the run also
  // processed everything it fetched, the sweep is over.
  const done = rows.results.length < SWEEP_WINDOW && examined === rows.results.length;
  // Advance only from the cursor this run started at. A rewind landing while
  // the run was mid-flight (an import finishing, an operator resetting it)
  // must survive the run's own write, or the rewind silently never happens —
  // the run's repairs keep; a re-pass skips them for the cost of the look.
  await db
    .prepare("UPDATE settings SET drive_origin_swept_before = ? WHERE id = 1 AND drive_origin_swept_before IS ?")
    .bind(done ? 0 : next, cursor)
    .run();
  return { examined, repaired };
}

async function closeAtStart(db: SqlDatabase, table: string, id: number): Promise<void> {
  await db.prepare(`UPDATE ${table} SET end_date_at = start_date_at WHERE id = ?`).bind(id).run();
}

interface Endpoint {
  table: "drives" | "charging_processes";
  column: string;
  id: number;
  carId: number;
  latitude: number;
  longitude: number;
}

/** Every drive end and charging session pinned to one address row, with its own point. */
async function endpointsAt(db: SqlDatabase, addressId: number): Promise<Endpoint[]> {
  const sql = (table: string, column: string, position: string) =>
    `SELECT '${table}' AS tbl, '${column}' AS col, t.id AS id, t.car_id AS car_id, ` +
    `p.latitude AS latitude, p.longitude AS longitude ` +
    `FROM ${table} t JOIN positions p ON p.id = t.${position} ` +
    `WHERE t.${column} = ?1 AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL`;

  const rows = await db
    .prepare(
      [
        sql("drives", "start_address_id", "start_position_id"),
        sql("drives", "end_address_id", "end_position_id"),
        sql("charging_processes", "address_id", "position_id"),
      ].join(" UNION ALL "),
    )
    .bind(addressId)
    .all<{ tbl: string; col: string; id: number; car_id: number; latitude: number; longitude: number }>();

  return rows.results.map((r) => ({
    table: r.tbl as Endpoint["table"],
    column: r.col,
    id: r.id,
    carId: r.car_id,
    latitude: r.latitude,
    longitude: r.longitude,
  }));
}
