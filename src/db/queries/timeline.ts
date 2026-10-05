import type { PreferredRange, TimelineDto, TimelineEventDto, TimelineEventKind } from "@shared/api-types";
import {
  END_LABEL as DRIVE_END_LABEL,
  END_REGION as DRIVE_END_REGION,
  JOINS as DRIVE_JOINS,
  SEARCH_END as DRIVE_SEARCH_END,
  SEARCH_START as DRIVE_SEARCH_START,
  START_LABEL as DRIVE_START_LABEL,
  START_REGION as DRIVE_START_REGION,
  energyExpr,
} from "./drives";
import {
  JOINS as CHARGE_JOINS,
  LABEL as CHARGE_LABEL,
  REGION as CHARGE_REGION,
  SEARCH_LABEL as CHARGE_SEARCH_LABEL,
} from "./charges";
import type { SqlDatabase } from "../../platform/ports";

/**
 * The unified event log behind the History page's timeline: everything four tables
 * recorded, in one chronological list, newest first.
 *
 * Paging is keyset rather than by offset. `OFFSET n` over a union has to build and
 * throw away the first n rows of every branch on every page, so the tenth page
 * costs ten times the first; a cursor turns each page into an indexed range scan
 * that reads only what it returns.
 *
 * Events still in progress are included, with a null end. The list pages exclude
 * those — an open row has no distance or cost to sort by — but a log is read for
 * what is happening now, and an open sleep span is the answer to "is it asleep?".
 *
 * There are five kinds but only ever four branches, because sleep and offline are
 * two states out of one table. That is not a coincidence to rely on lightly: D1
 * refuses a compound SELECT of more than five terms, so a fifth branch would be the
 * last one that fits and a sixth would fail at run time rather than at build.
 */

export const TIMELINE_KINDS: readonly TimelineEventKind[] = ["drive", "charge", "sleep", "offline", "update"];

/**
 * Tiebreak rank for events starting in the same millisecond. The values are
 * arbitrary; that they are fixed is not. A keyset cursor can only resume exactly
 * where it stopped if the sort is total, and `startAt` alone is not.
 */
const RANK: Record<TimelineEventKind, number> = { drive: 1, charge: 2, sleep: 3, offline: 4, update: 5 };

const KIND_BY_RANK = new Map<number, TimelineEventKind>(
  Object.entries(RANK).map(([kind, rank]) => [rank, kind as TimelineEventKind]),
);

export interface TimelineCursor {
  at: number;
  rank: number;
  id: number;
}

export interface TimelineFilters {
  carId: number;
  from: number;
  to: number;
  /** Which kinds to include. Callers pass them all rather than none. */
  kinds: TimelineEventKind[];
  search?: string;
  limit: number;
  cursor?: TimelineCursor;
  preferredRange: PreferredRange;
}

/** `at.rank.id` — opaque to the client, ordered exactly like the query's sort. */
function formatCursor(cursor: TimelineCursor): string {
  return `${cursor.at}.${cursor.rank}.${cursor.id}`;
}

export function parseCursor(raw: string): TimelineCursor | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!match) return null;
  return { at: Number(match[1]), rank: Number(match[2]), id: Number(match[3]) };
}

interface EventRow {
  kind_rank: number;
  id: number;
  car_id: number;
  start_at: number;
  end_at: number | null;
  duration_min: number | null;
  label: string | null;
  end_label: string | null;
  region: string | null;
  end_region: string | null;
  distance_km: number | null;
  energy_kwh: number | null;
  cost_cents: number | null;
  start_battery_level: number | null;
  end_battery_level: number | null;
}

interface Branch {
  sql: string;
  params: (string | number)[];
}

/**
 * How many rows to take from each branch. One more than the page, so the outer
 * query can tell whether a further page exists, and one more again to cover the
 * row a cursor discards when it lands mid-tie within a branch.
 *
 * Undershooting would not lose an event — a short page still yields a cursor the
 * next request resumes from — but it would end the log early, because "fewer rows
 * than asked for" is what says the window is exhausted.
 */
function branchLimit(limit: number): number {
  return limit + 2;
}

/** The window clause every branch shares, plus the cursor's upper bound on it. */
function windowClause(column: string, filters: TimelineFilters, params: (string | number)[]): string {
  params.push(filters.carId, filters.from, filters.to);
  let sql = ` AND ${column} >= ? AND ${column} < ?`;
  if (filters.cursor) {
    // A safe superset of the keyset predicate the outer query applies exactly:
    // enough to keep the scan bounded, loose enough to need no rank comparison.
    sql += ` AND ${column} <= ?`;
    params.push(filters.cursor.at);
  }
  return sql;
}

function like(search: string): string {
  return `%${search}%`;
}

function driveBranch(filters: TimelineFilters): Branch {
  const params: (string | number)[] = [];
  let where = `d.car_id = ?${windowClause("d.start_date_at", filters, params)}`;
  if (filters.search) {
    where += ` AND (${DRIVE_SEARCH_START} LIKE ? OR ${DRIVE_SEARCH_END} LIKE ?)`;
    params.push(like(filters.search), like(filters.search));
  }
  params.push(branchLimit(filters.limit));

  return {
    sql: `SELECT * FROM (
      SELECT ${RANK.drive} AS kind_rank, d.id AS id, d.car_id AS car_id,
             d.start_date_at AS start_at, d.end_date_at AS end_at, d.duration_min AS duration_min,
             ${DRIVE_START_LABEL} AS label, ${DRIVE_END_LABEL} AS end_label,
             ${DRIVE_START_REGION} AS region, ${DRIVE_END_REGION} AS end_region,
             d.distance AS distance_km, ${energyExpr(filters.preferredRange)} AS energy_kwh,
             NULL AS cost_cents,
             sp.battery_level AS start_battery_level, ep.battery_level AS end_battery_level
      FROM drives d ${DRIVE_JOINS}
      LEFT JOIN positions sp ON sp.id = d.start_position_id
      LEFT JOIN positions ep ON ep.id = d.end_position_id
      WHERE ${where}
      ORDER BY d.start_date_at DESC LIMIT ?
    )`,
    params,
  };
}

function chargeBranch(filters: TimelineFilters): Branch {
  const params: (string | number)[] = [];
  let where = `cp.car_id = ?${windowClause("cp.start_date_at", filters, params)}`;
  if (filters.search) {
    where += ` AND ${CHARGE_SEARCH_LABEL} LIKE ?`;
    params.push(like(filters.search));
  }
  params.push(branchLimit(filters.limit));

  return {
    sql: `SELECT * FROM (
      SELECT ${RANK.charge} AS kind_rank, cp.id AS id, cp.car_id AS car_id,
             cp.start_date_at AS start_at, cp.end_date_at AS end_at, cp.duration_min AS duration_min,
             ${CHARGE_LABEL} AS label, NULL AS end_label,
             ${CHARGE_REGION} AS region, NULL AS end_region,
             NULL AS distance_km, cp.charge_energy_added AS energy_kwh, cp.cost_cents AS cost_cents,
             cp.start_battery_level AS start_battery_level, cp.end_battery_level AS end_battery_level
      FROM charging_processes cp ${CHARGE_JOINS}
      WHERE ${where}
      ORDER BY cp.start_date_at DESC LIMIT ?
    )`,
    params,
  };
}

/**
 * Sleep and offline spans, which are two kinds out of one table. The rank is a
 * CASE rather than a constant, and both are interpolated because they are this
 * module's own numbers — the state names in the WHERE are still bound.
 */
function stateBranch(filters: TimelineFilters, states: string[]): Branch {
  const params: (string | number)[] = [];
  const where = `s.car_id = ?${windowClause("s.start_date_at", filters, params)}`;
  const placeholders = states.map(() => "?").join(", ");
  params.push(...states, branchLimit(filters.limit));

  return {
    sql: `SELECT * FROM (
      SELECT CASE s.state WHEN 'asleep' THEN ${RANK.sleep} ELSE ${RANK.offline} END AS kind_rank,
             s.id AS id, s.car_id AS car_id,
             s.start_date_at AS start_at, s.end_date_at AS end_at,
             CASE WHEN s.end_date_at IS NOT NULL
                  THEN (s.end_date_at - s.start_date_at) / 60000.0 END AS duration_min,
             NULL AS label, NULL AS end_label, NULL AS region, NULL AS end_region,
             NULL AS distance_km, NULL AS energy_kwh, NULL AS cost_cents,
             NULL AS start_battery_level, NULL AS end_battery_level
      FROM states s
      WHERE ${where} AND s.state IN (${placeholders})
      ORDER BY s.start_date_at DESC LIMIT ?
    )`,
    params,
  };
}

function updateBranch(filters: TimelineFilters): Branch {
  const params: (string | number)[] = [];
  let where = `up.car_id = ?${windowClause("up.start_date_at", filters, params)}`;
  if (filters.search) {
    where += " AND COALESCE(up.version, '') LIKE ?";
    params.push(like(filters.search));
  }
  params.push(branchLimit(filters.limit));

  return {
    sql: `SELECT * FROM (
      SELECT ${RANK.update} AS kind_rank, up.id AS id, up.car_id AS car_id,
             up.start_date_at AS start_at, up.end_date_at AS end_at,
             CASE WHEN up.end_date_at IS NOT NULL
                  THEN (up.end_date_at - up.start_date_at) / 60000.0 END AS duration_min,
             up.version AS label, NULL AS end_label, NULL AS region, NULL AS end_region,
             NULL AS distance_km, NULL AS energy_kwh, NULL AS cost_cents,
             NULL AS start_battery_level, NULL AS end_battery_level
      FROM updates up
      WHERE ${where}
      ORDER BY up.start_date_at DESC LIMIT ?
    )`,
    params,
  };
}

function toDto(row: EventRow): TimelineEventDto {
  const kind = KIND_BY_RANK.get(row.kind_rank);
  if (!kind) throw new Error(`timeline: unknown kind rank ${row.kind_rank}`);
  return {
    kind,
    id: row.id,
    carId: row.car_id,
    startAt: row.start_at,
    endAt: row.end_at,
    durationMin: row.duration_min,
    label: row.label,
    endLabel: row.end_label,
    region: row.region,
    endRegion: row.end_region,
    distanceKm: row.distance_km,
    energyKwh: row.energy_kwh,
    costCents: row.cost_cents,
    startBatteryLevel: row.start_battery_level,
    endBatteryLevel: row.end_battery_level,
  };
}

export async function eventLog(db: SqlDatabase, filters: TimelineFilters): Promise<TimelineDto> {
  const kinds = new Set(filters.kinds);
  const branches: Branch[] = [];

  if (kinds.has("drive")) branches.push(driveBranch(filters));
  if (kinds.has("charge")) branches.push(chargeBranch(filters));

  // A sleep or offline span carries no text, so a search drops these branches
  // instead of returning spans that have nothing to do with the term.
  const states = [...(kinds.has("sleep") ? ["asleep"] : []), ...(kinds.has("offline") ? ["offline"] : [])];
  if (states.length > 0 && !filters.search) branches.push(stateBranch(filters, states));

  if (kinds.has("update")) branches.push(updateBranch(filters));

  if (branches.length === 0) return { events: [], nextCursor: null };

  const params = branches.flatMap((branch) => branch.params);

  let keyset = "";
  if (filters.cursor) {
    // Strictly after the cursor in the sort below: an older instant, or the same
    // instant and a lower-priority kind, or the same kind and a lower id.
    keyset = " WHERE (start_at < ? OR (start_at = ? AND (kind_rank > ? OR (kind_rank = ? AND id < ?))))";
    params.push(filters.cursor.at, filters.cursor.at, filters.cursor.rank, filters.cursor.rank, filters.cursor.id);
  }
  params.push(filters.limit + 1);

  const rows = await db
    .prepare(
      `SELECT * FROM (${branches.map((branch) => branch.sql).join(" UNION ALL ")})${keyset}
       ORDER BY start_at DESC, kind_rank ASC, id DESC
       LIMIT ?`,
    )
    .bind(...params)
    .all<EventRow>();

  const page = rows.results.slice(0, filters.limit);
  const last = page.at(-1);
  const more = rows.results.length > filters.limit;

  return {
    events: page.map(toDto),
    nextCursor:
      more && last ? formatCursor({ at: last.start_at, rank: last.kind_rank, id: last.id }) : null,
  };
}
