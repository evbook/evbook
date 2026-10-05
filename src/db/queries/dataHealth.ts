import type { DataHealthDto, TruncatedSessionDto } from "@shared/api-types";
import { oneLine } from "./address";
import { END_LABEL as DRIVE_END_LABEL, END_REGION as DRIVE_END_REGION, JOINS as DRIVE_JOINS } from "./drives";
import { JOINS as CHARGE_JOINS, LABEL as CHARGE_LABEL, REGION as CHARGE_REGION } from "./charges";
import type { SqlDatabase } from "../../platform/ports";

/**
 * What the database has to say about itself. Two questions, both asked when
 * something feels wrong rather than as part of using the app: is everything in
 * here that should be, and is anything half-written?
 *
 * TeslaMate answers the first with a PostgreSQL dashboard full of shared buffers
 * and `pg_stat_statements`, none of which exists on D1. The part worth keeping is
 * the row counts, so they are here, beside the sessions that never got an end —
 * which is a fault a stopped import, a mid-import upgrade or an evicted Worker can
 * all leave behind, and which nothing else in the app would tell you about.
 */

/**
 * Tables the export offers, in the order the card lists them.
 *
 * The counts are whole-database and stay that way even when a car is named: the card
 * they feed is about what is stored and what can be exported, and the export is
 * per-table rather than per-car. `lastSampleAt` and `truncated` do honour the car.
 */
export const COUNTED_TABLES = [
  "cars",
  "drives",
  "charging_processes",
  "charges",
  "positions",
  "states",
  "updates",
  "addresses",
  "geofences",
] as const;

/**
 * Longer than this open, and a drive, charge or install is not still happening.
 *
 * Exported because three places have to agree on it: this card, the sweep that
 * closes what it finds (`db/repair`), and the History band, which must not let a
 * row this old go on painting itself over the present (`queries/stats`).
 */
export const STALE_MS = 24 * 3_600_000;

/** At most this many listed; the count says how many there really are. */
const LIST_LIMIT = 20;

interface TruncatedRow {
  kind: TruncatedSessionDto["kind"];
  id: number;
  car_id: number;
  start_at: number;
  label: string | null;
  is_last: number;
}

/**
 * One branch of the union, per table that records spans.
 *
 * The test for "left behind" is that something newer exists in the *same* table,
 * not in any table. Per-table is the exact rule: a second drive starting means the
 * first should have been closed, whereas during a live drive the open `states` row
 * that opened when the car woke is perfectly correct and merely older.
 *
 * `staleAfter` is the second test, for the case where the abandoned row is also the
 * newest one — a Worker that died mid-drive leaves nothing after it. State spans opt
 * out: being asleep for a fortnight is not a fault, and `states_one_open_per_car`
 * means an open state row is by construction the only one, so it is always current.
 * A *closed* state row after an open one is still possible, which is what an import
 * replaying history over a live gap would leave, and that is what the first test
 * catches.
 */
function branch(opts: {
  kind: TruncatedSessionDto["kind"];
  table: string;
  alias: string;
  joins?: string;
  label: string;
  staleAfter: boolean;
}): string {
  const { alias } = opts;
  const newer = `EXISTS (SELECT 1 FROM ${opts.table} n
        WHERE n.car_id = ${alias}.car_id AND n.start_date_at > ${alias}.start_date_at)`;
  const stale = opts.staleAfter ? ` OR ${alias}.start_date_at < ?1` : "";

  return `SELECT '${opts.kind}' AS kind, ${alias}.id AS id, ${alias}.car_id AS car_id,
                 ${alias}.start_date_at AS start_at, ${opts.label} AS label,
                 CASE WHEN ${newer} THEN 0 ELSE 1 END AS is_last
          FROM ${opts.table} ${alias} ${opts.joins ?? ""}
          WHERE ${alias}.end_date_at IS NULL AND (${newer}${stale})`;
}

/** `AND car_id = ?` for each branch, or nothing when every car is wanted. */
function carClause(alias: string, carId: number | undefined): string {
  return carId === undefined ? "" : ` AND ${alias}.car_id = ?2`;
}

export async function dataHealth(db: SqlDatabase, carId?: number, now = Date.now()): Promise<DataHealthDto> {
  /*
    One row of scalar subqueries, not nine statements and not a nine-arm union.
    D1 refuses a compound SELECT of more than five terms — `too many terms in
    compound SELECT` — which is far below SQLite's own default of 500, so the
    obvious `SELECT 'drives', COUNT(*) FROM drives UNION ALL …` is not available
    here. Correlated scalar subqueries have no such limit.
  */
  const counts = db
    .prepare(`SELECT ${COUNTED_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table}) AS "${table}"`).join(", ")}`)
    .first<Record<string, number>>();

  /*
    The newest sample, and how it is found matters. `MAX(date_at)` with no car to
    pin it cannot use `positions_car_id_date_at` — the index is on (car_id, date_at)
    — so it was a second full scan of the biggest table in the database, on top of
    the counts above. Ids are handed out in time order, which `drivesRoute` already
    relies on for its stride sampling, so the last row by id is the newest sample and
    costs one index seek. With a car to pin, `MAX` does use the index and stays.
  */
  const sample =
    carId === undefined
      ? db.prepare("SELECT date_at AS at FROM positions ORDER BY id DESC LIMIT 1").first<{ at: number | null }>()
      : db
          .prepare("SELECT MAX(date_at) AS at FROM positions WHERE car_id = ?")
          .bind(carId)
          .first<{ at: number | null }>();

  // Four arms, and D1 allows five. A fifth table that records spans would need
  // this split into two queries rather than a fifth branch.
  const branches = [
    branch({
      kind: "drive",
      table: "drives",
      alias: "d",
      joins: DRIVE_JOINS,
      // One column here: a diagnostics row has nowhere to weight the town apart.
      label: oneLine(DRIVE_END_LABEL, DRIVE_END_REGION),
      staleAfter: true,
    }) + carClause("d", carId),
    branch({
      kind: "charge",
      table: "charging_processes",
      alias: "cp",
      joins: CHARGE_JOINS,
      label: oneLine(CHARGE_LABEL, CHARGE_REGION),
      staleAfter: true,
    }) + carClause("cp", carId),
    branch({ kind: "state", table: "states", alias: "s", label: "s.state", staleAfter: false }) +
      carClause("s", carId),
    branch({ kind: "update", table: "updates", alias: "up", label: "up.version", staleAfter: true }) +
      carClause("up", carId),
  ];

  // Numbered rather than positional parameters: every branch wants the same two
  // values, and repeating them four times over would be four chances to get the
  // order wrong. ?1 is the staleness cutoff, ?2 the car.
  const truncated = db
    .prepare(`SELECT * FROM (${branches.join(" UNION ALL ")}) ORDER BY start_at DESC`)
    .bind(...(carId === undefined ? [now - STALE_MS] : [now - STALE_MS, carId]))
    .all<TruncatedRow>();

  const [countRow, sampleRow, truncatedRows] = await Promise.all([counts, sample, truncated]);

  return {
    tables: COUNTED_TABLES.map((table) => ({ table, rows: countRow?.[table] ?? 0 })),
    lastSampleAt: sampleRow?.at ?? null,
    truncated: truncatedRows.results.slice(0, LIST_LIMIT).map((row) => ({
      kind: row.kind,
      id: row.id,
      carId: row.car_id,
      startAt: row.start_at,
      label: row.label,
      last: row.is_last === 1,
    })),
    truncatedCount: truncatedRows.results.length,
  };
}
