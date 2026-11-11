import { Repo } from "../../db/repo";
import { haversineMeters } from "../geo/geofence";
import { readTeslaMateCars, TESLAMATE_TABLES, type TeslaMateCar } from "./adapters/teslamate";
import { resolveCar } from "./car";
import { CopyColumns, copyEvents } from "./pgdump";
import type { DirectControl, DirectImporter, DirectOptions, DirectProgress } from "./direct";
import type { ImportBundle } from "./types";
import type { SqlDatabase, SqlStatement } from "../../platform/ports";

/**
 * Writes a TeslaMate backup straight into EVBook's tables.
 *
 * Why not replay it like Tessie? A Tessie export is raw samples, so the live
 * state machine has to find the drives and charges in it. A TeslaMate backup
 * already holds them — finished, with TeslaMate's own boundaries, totals,
 * geofences and, above all, the costs the owner typed in — in tables EVBook's
 * schema was modelled on. Re-deriving them from positions would throw that away
 * and still not land on the same drives. So rows are mapped column by column.
 *
 * What makes it work inside a Worker, against a backup that can be a gigabyte
 * of SQL:
 *
 * - **Streaming, several passes.** The dump is never held in memory. Rows refer
 *   to other tables (a position to its drive, a charge to its session), and
 *   pg_dump writes tables in name order — `charges` before
 *   `charging_processes` — so a table is only written once the tables it refers
 *   to are done, and the file is read again for what had to wait. A standard
 *   backup takes three passes; the order is never assumed.
 * - **A cursor of plain data.** The state is which tables are done, which one
 *   is under way and how many of its rows are written, plus the id maps for
 *   drives and charging sessions (thousands, not millions). Each slice streams
 *   from the start, skips what is done without parsing it, and stops after any
 *   committed batch — so stopping and resuming is always safe.
 * - **Few round trips.** Positions and charges go in as multi-row INSERTs with
 *   literal values (D1 allows 100 bound parameters, a third of a position
 *   row), several statements per batch.
 *
 * Semantics, per car:
 *
 * - Only history from **before EVBook's first reading** of the car is taken:
 *   an event that started at or after it, or ran past it, is skipped as
 *   overlapping; an event TeslaMate never finished (no end date) is skipped as
 *   unfinished. Both are counted.
 * - Every row carries the `imports` row it came from, so **re-importing
 *   replaces** the previous TeslaMate import of that car (it is purged first),
 *   and **deleting an import** removes exactly what it brought.
 * - Addresses and geofences are shared reference data, not history: addresses
 *   are deduplicated on their OSM id, geofences matched by name and place, and
 *   neither is removed with an import.
 */

type Table = (typeof TESLAMATE_TABLES)[number];

/** What has to be written before a table can be — its references. */
const DEPENDS: Record<Table, Table[]> = {
  addresses: [],
  geofences: [],
  drives: ["addresses", "geofences"],
  charging_processes: ["addresses", "geofences"],
  states: [],
  updates: [],
  positions: ["drives"],
  charges: ["charging_processes"],
};

/** Rough share of the work each table is, for the progress bar. */
const WEIGHT: Record<Table, number> = {
  addresses: 0.02,
  geofences: 0.01,
  drives: 0.04,
  charging_processes: 0.03,
  states: 0.03,
  updates: 0.01,
  positions: 0.66,
  charges: 0.2,
};

/** D1 refuses statements over 100 kB. */
const MAX_STATEMENT_CHARS = 90_000;
const MAX_ROWS_PER_STATEMENT = 400;
/** Multi-row statements per batch (one round trip). */
const STATEMENTS_PER_BATCH = 8;
/** Single-row statements per batch, for the tables whose new ids are needed. */
const RETURNING_PER_BATCH = 200;
/** Rows one purge statement deletes. */
const PURGE_CHUNK = 20_000;

export interface CarPlan {
  /** TeslaMate's car id. */
  tmId: number;
  carId: number;
  vin: string;
  /** This import's bookkeeping row for the car. */
  importId: number;
  /** EVBook's first reading of the car; null when it had none. */
  cutoffAt: number | null;
  created: boolean;
}

export interface TeslaMateCounts {
  drives: number;
  chargingProcesses: number;
  charges: number;
  positions: number;
  states: number;
  updates: number;
  addresses: number;
  geofences: number;
  skippedOverlapping: number;
  skippedUnfinished: number;
  distanceKm: number;
  energyAddedKwh: number;
  firstAt: number | null;
  lastAt: number | null;
  /** Rows of earlier TeslaMate imports this one superseded. */
  replacedRows: number;
}

type CountKey = Exclude<keyof TeslaMateCounts, "firstAt" | "lastAt">;

export interface TeslaMateState {
  phase: "purge" | "tables" | "finish" | "done";
  label: string;
  since: number | null;
  until: number | null;
  cars: CarPlan[];
  /** Earlier imports of these cars still to be removed. */
  purge: number[];
  done: Table[];
  /** The table under way and how many of its rows are committed. */
  current: { table: Table; rows: number } | null;
  /** Streams read so far — a sanity limit, and what the progress bar leans on. */
  passes: number;
  /** TeslaMate id -> EVBook id, as strings for structured clone friendliness. */
  addresses: Record<string, number>;
  geofences: Record<string, number>;
  drives: Record<string, number>;
  processes: Record<string, number>;
  /** TeslaMate charging session id -> TeslaMate car id, for the charges. */
  processCars: Record<string, number>;
  /** Byte offsets of the blocks, once seen — the progress bar's yardstick. */
  blocks: Partial<Record<Table, { start: number; end: number | null }>>;
  counts: TeslaMateCounts;
  /** The same counts per car, keyed by the car's import id. */
  carCounts: Record<string, TeslaMateCounts>;
}

function emptyCounts(): TeslaMateCounts {
  return {
    drives: 0,
    chargingProcesses: 0,
    charges: 0,
    positions: 0,
    states: 0,
    updates: 0,
    addresses: 0,
    geofences: 0,
    skippedOverlapping: 0,
    skippedUnfinished: 0,
    distanceKm: 0,
    energyAddedKwh: 0,
    firstAt: null,
    lastAt: null,
    replacedRows: 0,
  };
}

// ---- preparing ----

/**
 * Reads the cars, matches each to an EVBook car by VIN (creating it when there
 * is none), and opens a bookkeeping row per car. Cheap: the cars sit near the
 * top of the backup.
 */
async function prepare(db: SqlDatabase, bundle: ImportBundle, options: DirectOptions): Promise<TeslaMateState> {
  const all = await readTeslaMateCars(bundle);
  if (all.length === 0) throw new Error("the backup holds no cars — is this a TeslaMate database dump?");

  let chosen: TeslaMateCar[] = all.filter((car) => car.vin);
  for (const car of all) {
    if (!car.vin) options.warn?.(`TeslaMate car ${car.id} (${car.name ?? "unnamed"}) has no VIN and was left out`);
  }
  if (options.vin) {
    const vin = options.vin.toUpperCase();
    chosen = chosen.filter((car) => car.vin === vin);
    if (chosen.length === 0) throw new Error(`the backup holds no car with VIN ${options.vin}`);
  }
  if (options.carId !== undefined && chosen.length !== 1) {
    throw new Error(
      `the backup holds ${chosen.length} cars (${chosen.map((car) => car.vin).join(", ")}) — ` +
        "say which one by VIN rather than by car",
    );
  }
  if (chosen.length === 0) throw new Error("no car in the backup has a VIN to match");

  const now = Date.now();
  const cars: CarPlan[] = [];
  const purge: number[] = [];
  for (const car of chosen) {
    const resolved = await resolveCar(db, {
      carId: options.carId,
      vin: car.vin,
      name: car.name ?? options.carName ?? undefined,
    });
    const created = resolved.how === "created";
    if (created) {
      // Fill in what TeslaMate knew about the car; the VIN decode left the rest.
      await db
        .prepare(
          "UPDATE cars SET model = COALESCE(?, model), trim_badging = ?, marketing_name = ?, exterior_color = ?, " +
            "wheel_type = ?, spoiler_type = ? WHERE id = ?",
        )
        .bind(
          car.model,
          car.trimBadging,
          car.marketingName,
          car.exteriorColor,
          car.wheelType,
          car.spoilerType,
          resolved.carId,
        )
        .run();
    }
    const prior = await db
      .prepare("SELECT id FROM imports WHERE car_id = ? AND source = 'teslamate' ORDER BY id")
      .bind(resolved.carId)
      .all<{ id: number }>();
    purge.push(...prior.results.map((row) => row.id));

    const row = await db
      .prepare(
        "INSERT INTO imports (car_id, source, label, status, created_at) VALUES (?, 'teslamate', ?, 'importing', ?) RETURNING id",
      )
      .bind(resolved.carId, options.label, now)
      .first<{ id: number }>();
    cars.push({ tmId: car.id, carId: resolved.carId, vin: car.vin!, importId: row!.id, cutoffAt: null, created });
  }

  if (purge.length > 0) {
    options.warn?.("an earlier TeslaMate import of the same car is replaced by this one");
    await db
      .prepare(`UPDATE imports SET status = 'deleting' WHERE id IN (${purge.map(() => "?").join(", ")})`)
      .bind(...purge)
      .run();
  }

  return {
    phase: "purge",
    label: options.label,
    since: options.since ?? null,
    until: options.until ?? null,
    cars,
    purge,
    done: [],
    current: null,
    passes: 0,
    addresses: {},
    geofences: {},
    drives: {},
    processes: {},
    processCars: {},
    blocks: {},
    counts: emptyCounts(),
    carCounts: {},
  };
}

/**
 * EVBook's first reading of the car: the earliest thing it holds for it, from
 * the live logger or an earlier import of another kind. Earlier TeslaMate
 * imports of the car have been purged by the time this runs.
 */
async function firstReading(db: SqlDatabase, carId: number): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MIN(t) AS first FROM (
         SELECT MIN(date_at) AS t FROM positions WHERE car_id = ?1
         UNION ALL SELECT MIN(start_date_at) FROM drives WHERE car_id = ?1
         UNION ALL SELECT MIN(start_date_at) FROM charging_processes WHERE car_id = ?1
         UNION ALL SELECT MIN(start_date_at) FROM states WHERE car_id = ?1
       )`,
    )
    .bind(carId)
    .first<{ first: number | null }>();
  return row?.first ?? null;
}

// ---- purging ----

/** Children before parents, and positions after the sessions that point at them. */
const PURGE_ORDER = ["charges", "charging_processes", "positions", "drives", "states", "updates"] as const;

/**
 * Removes everything one import brought, a chunk at a time, and then its
 * bookkeeping row. Returns whether it finished; call again until it does.
 */
export async function purgeImport(
  db: SqlDatabase,
  importId: number,
  stopAfter: () => boolean = () => false,
): Promise<{ done: boolean; deleted: number }> {
  let deleted = 0;
  for (const table of PURGE_ORDER) {
    for (;;) {
      const result = await db
        .prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE import_id = ? LIMIT ${PURGE_CHUNK})`)
        .bind(importId)
        .run();
      const changes = result.meta?.changes ?? 0;
      deleted += changes;
      if (changes < PURGE_CHUNK) break;
      if (stopAfter()) return { done: false, deleted };
    }
  }
  await db.prepare("DELETE FROM imports WHERE id = ?").bind(importId).run();
  return { done: true, deleted };
}

// ---- the slices ----

async function slice(
  db: SqlDatabase,
  bundle: ImportBundle,
  state: TeslaMateState,
  control: DirectControl,
): Promise<{ state: TeslaMateState; done: boolean }> {
  // Mutated in place, and only ever to what is committed: the cursor, the id
  // maps and the counts all move when a batch lands. So if a slice throws, the
  // state as it stands is still the truth to resume from.

  while (state.phase === "purge") {
    const next = state.purge[0];
    if (next === undefined) {
      for (const car of state.cars) {
        car.cutoffAt = await firstReading(db, car.carId);
        await db.prepare("UPDATE imports SET cutoff_at = ? WHERE id = ?").bind(car.cutoffAt, car.importId).run();
      }
      state.phase = "tables";
      break;
    }
    const result = await purgeImport(db, next, control.stopAfter);
    state.counts.replacedRows += result.deleted;
    if (!result.done) return { state, done: false };
    state.purge.shift();
    if (control.stopAfter()) return { state, done: false };
  }

  while (state.phase === "tables") {
    const finished = await pass(db, bundle, state, control);
    if (!finished) return { state, done: false };
    if (state.done.length === TESLAMATE_TABLES.length) state.phase = "finish";
    if (control.stopAfter()) return { state, done: false };
  }

  if (state.phase === "finish") {
    await finish(db, state);
    state.phase = "done";
  }
  return { state, done: true };
}

/**
 * One stream through the backup, writing every table whose references are
 * already in place. Returns true when the pass is over, false when it stopped
 * for the budget.
 */
async function pass(
  db: SqlDatabase,
  bundle: ImportBundle,
  state: TeslaMateState,
  control: DirectControl,
): Promise<boolean> {
  const path = (await bundle.entries())[0]?.path;
  if (!path) throw new Error("the backup is empty");

  const isDone = (table: Table) => state.done.includes(table);
  const ready = (table: Table) => !isDone(table) && DEPENDS[table].every(isDone);
  /** Blocks this stream has gone past without finishing. */
  const passed = new Set<Table>();
  const seen = new Set<Table>();
  const doneAtStart = state.done.length;
  const rowsAtStart = state.current?.rows ?? 0;

  /** Cannot be finished in this stream: its block has gone by, or a reference cannot be. */
  const blocked = (table: Table): boolean =>
    passed.has(table) || DEPENDS[table].some((dep) => !isDone(dep) && blocked(dep));
  /**
   * Nothing left that has to happen in this stream: everything remaining is
   * blocked, or is a leaf — needs nothing, and nothing waits on it — that can
   * as well be written by the stream that has to run anyway for a blocked one.
   */
  const passCanEnd = () => {
    const remaining = TESLAMATE_TABLES.filter((table) => !isDone(table));
    if (remaining.length === 0) return true;
    const anotherPass = remaining.some(blocked);
    const leaf = (table: Table) =>
      DEPENDS[table].length === 0 && !remaining.some((other) => DEPENDS[other].includes(table));
    return remaining.every((table) => blocked(table) || (anotherPass && leaf(table)));
  };

  let writer: TableWriter | null = null;
  let stopped = false;
  let endedEarly = false;
  state.passes++;

  const events = copyEvents(bundle.lines(path), {
    tables: new Set<string>(TESLAMATE_TABLES.filter((table) => !isDone(table))),
    skip: state.current ? { table: state.current.table, rows: state.current.rows } : undefined,
  });

  for await (const event of events) {
    const table = event.header.table as Table;
    if (!TESLAMATE_TABLES.includes(table)) continue;

    if (event.kind === "start") {
      seen.add(table);
      const at = control.position?.() ?? null;
      if (at !== null && !state.blocks[table]) state.blocks[table] = { start: at, end: null };
      if (ready(table)) {
        if (state.current?.table !== table) state.current = { table, rows: 0 };
        writer = new TableWriter(db, state, table, new CopyColumns(event.header), control.batchRows);
      }
      continue;
    }

    if (event.kind === "row") {
      if (!writer) continue;
      await writer.add(event.fields);
      if (writer.committed && control.stopAfter()) {
        stopped = true;
        break;
      }
      continue;
    }

    // The end of a block.
    const at = control.position?.() ?? null;
    const block = state.blocks[table];
    if (block && at !== null) block.end ??= at;
    if (writer) {
      await writer.flush();
      state.done.push(table);
      state.current = null;
      writer = null;
      if (control.stopAfter()) {
        stopped = true;
        break;
      }
    } else if (!isDone(table)) {
      passed.add(table);
    }
    if (passCanEnd()) {
      endedEarly = true;
      break;
    }
  }

  // The cursor already sits after the last committed batch.
  if (stopped) return false;

  // A table a whole stream never met is not in the backup (an old schema, say):
  // there is nothing to write for it. Only a stream that reached the end knows.
  if (!endedEarly) {
    for (const table of TESLAMATE_TABLES) {
      if (isDone(table) || seen.has(table)) continue;
      state.done.push(table);
      control.warn?.(`the backup has no ${table} table`);
    }
  }

  const remaining = TESLAMATE_TABLES.length - state.done.length;
  if (remaining > 0 && state.done.length === doneAtStart && (state.current?.rows ?? 0) === rowsAtStart) {
    throw new Error(
      `the backup could not be read in full — ${TESLAMATE_TABLES.filter((table) => !isDone(table)).join(", ")} ` +
        "never became importable",
    );
  }
  return true;
}

// ---- writing ----

type Fields = (string | null)[];

/** One SQL literal. Values are typed by the mapping, never spliced from text unescaped. */
function lit(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replaceAll("\0", "").replaceAll("'", "''")}'`;
}

/** Writes one table's rows, batching, and advances the cursor on every commit. */
class TableWriter {
  /** Rows of the block handled so far, written or skipped. */
  private handled: number;
  private multi: string[] = [];
  private multiChars = 0;
  private multiRows = 0;
  private statements: SqlStatement[] = [];
  /** For RETURNING inserts: what each statement's id maps from. */
  private returning: { map: Record<string, number>; key: string }[] = [];
  /** Count updates waiting for their batch to commit. */
  private pending: (() => void)[] = [];
  /** Set after a batch commits, so the caller knows it may stop. */
  committed = false;
  private readonly cars: Map<number, CarPlan>;

  constructor(
    private readonly db: SqlDatabase,
    private readonly state: TeslaMateState,
    readonly table: Table,
    private readonly columns: CopyColumns,
    /** Commit after this many rows regardless — small slices for the specs. */
    private readonly batchRows?: number,
  ) {
    this.handled = state.current?.rows ?? 0;
    this.cars = new Map(state.cars.map((car) => [car.tmId, car]));
  }

  private sinceFlush = 0;

  async add(fields: Fields): Promise<void> {
    this.committed = false;
    this.handled++;
    this.sinceFlush++;
    switch (this.table) {
      case "addresses":
        this.address(fields);
        break;
      case "geofences":
        await this.geofence(fields);
        break;
      case "drives":
        this.drive(fields);
        break;
      case "charging_processes":
        this.process(fields);
        break;
      case "states":
        this.stateRow(fields);
        break;
      case "updates":
        this.update(fields);
        break;
      case "positions":
        this.position(fields);
        break;
      case "charges":
        this.charge(fields);
        break;
    }
    if (
      this.statements.length >= (this.returning.length > 0 ? RETURNING_PER_BATCH : STATEMENTS_PER_BATCH) ||
      (this.batchRows !== undefined && this.sinceFlush >= this.batchRows)
    ) {
      await this.flush();
    }
  }

  /** Commits whatever is pending and moves the cursor past it. */
  async flush(): Promise<void> {
    this.closeMulti();
    if (this.statements.length > 0) {
      const results = await this.db.batch(this.statements);
      this.returning.forEach((target, i) => {
        const id = (results[i]?.results?.[0] as { id?: number } | undefined)?.id;
        if (typeof id === "number") target.map[target.key] = id;
      });
      this.statements = [];
      this.returning = [];
    }
    for (const apply of this.pending) apply();
    this.pending = [];
    this.sinceFlush = 0;
    this.state.current = { table: this.table, rows: this.handled };
    this.committed = true;
  }

  // -- helpers --

  private car(fields: Fields): CarPlan | null {
    const tmCar = this.columns.int(fields, "car_id");
    return tmCar === null ? null : (this.cars.get(tmCar) ?? null);
  }

  /** Inside the requested window, by the event's start. */
  private inWindow(at: number): boolean {
    return (
      (this.state.since === null || at >= this.state.since) && (this.state.until === null || at <= this.state.until)
    );
  }

  /**
   * Whether an event belongs in the import: finished, inside the window, and
   * entirely before EVBook's own history of the car began.
   */
  private admit(car: CarPlan, start: number | null, end: number | null, counted: boolean): boolean {
    if (start === null || !this.inWindow(start)) return false;
    if (car.cutoffAt !== null && (start >= car.cutoffAt || (end !== null && end > car.cutoffAt))) {
      if (counted) this.bump(car, "skippedOverlapping", 1);
      return false;
    }
    if (end === null) {
      if (counted) this.bump(car, "skippedUnfinished", 1);
      return false;
    }
    return true;
  }

  /**
   * Counts go both to the whole job and to the car's own import row — once the
   * batch carrying the row has committed, so they never run ahead of the data.
   */
  private bump(car: CarPlan | null, key: CountKey, by: number): void {
    this.pending.push(() => {
      this.state.counts[key] += by;
      if (car) (this.state.carCounts[String(car.importId)] ??= emptyCounts())[key] += by;
    });
  }

  private span(car: CarPlan, start: number, end: number | null): void {
    this.pending.push(() => {
      for (const counts of [this.state.counts, (this.state.carCounts[String(car.importId)] ??= emptyCounts())]) {
        counts.firstAt = counts.firstAt === null ? start : Math.min(counts.firstAt, start);
        const last = end ?? start;
        counts.lastAt = counts.lastAt === null ? last : Math.max(counts.lastAt, last);
      }
    });
  }

  private mapped(map: Record<string, number>, fields: Fields, column: string): number | null {
    const id = this.columns.int(fields, column);
    return id === null ? null : (map[String(id)] ?? null);
  }

  private returningInsert(sql: string, values: unknown[], map: Record<string, number>, key: number): void {
    this.closeMulti();
    this.statements.push(this.db.prepare(`${sql} RETURNING id`).bind(...values));
    this.returning.push({ map, key: String(key) });
  }

  private multiInsert(prefix: string, tuple: string): void {
    if (
      this.multi.length > 0 &&
      (this.multiChars + tuple.length > MAX_STATEMENT_CHARS || this.multiRows >= MAX_ROWS_PER_STATEMENT)
    ) {
      this.closeMulti();
    }
    if (this.multi.length === 0) {
      this.multi.push(prefix);
      this.multiChars = prefix.length;
    } else {
      this.multi.push(",");
    }
    this.multi.push(tuple);
    this.multiChars += tuple.length + 1;
    this.multiRows++;
  }

  private closeMulti(): void {
    if (this.multi.length === 0) return;
    this.statements.push(this.db.prepare(this.multi.join("")));
    this.multi = [];
    this.multiChars = 0;
    this.multiRows = 0;
  }

  // -- tables --

  private address(f: Fields): void {
    const c = this.columns;
    const id = c.int(f, "id");
    if (id === null) return;
    const now = Date.now();
    this.bump(null, "addresses", 1);
    this.returningInsert(
      "INSERT INTO addresses (osm_id, osm_type, display_name, name, house_number, road, neighbourhood, city, county, " +
        "postcode, state, state_district, country, latitude, longitude, raw, inserted_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (osm_id, osm_type) DO UPDATE SET updated_at = addresses.updated_at",
      [
        c.int(f, "osm_id"),
        c.text(f, "osm_type"),
        c.text(f, "display_name"),
        c.text(f, "name"),
        c.text(f, "house_number"),
        c.text(f, "road"),
        c.text(f, "neighbourhood"),
        c.text(f, "city"),
        c.text(f, "county"),
        c.text(f, "postcode"),
        c.text(f, "state"),
        c.text(f, "state_district"),
        c.text(f, "country"),
        c.num(f, "latitude"),
        c.num(f, "longitude"),
        c.text(f, "raw"),
        c.date(f, "inserted_at") ?? now,
        c.date(f, "updated_at") ?? now,
      ],
      this.state.addresses,
      id,
    );
  }

  private existingGeofences: { id: number; name: string; latitude: number; longitude: number }[] | null = null;

  private async geofence(f: Fields): Promise<void> {
    const c = this.columns;
    const id = c.int(f, "id");
    const name = c.text(f, "name");
    const latitude = c.num(f, "latitude");
    const longitude = c.num(f, "longitude");
    if (id === null || !name || latitude === null || longitude === null) return;

    // A geofence is settings, not history: reuse one EVBook already has for the
    // same place rather than doubling it on every import.
    this.existingGeofences ??= (
      await this.db.prepare("SELECT id, name, latitude, longitude FROM geofences").all<{
        id: number;
        name: string;
        latitude: number;
        longitude: number;
      }>()
    ).results;
    const same = this.existingGeofences.find(
      (g) =>
        g.name.toLowerCase() === name.toLowerCase() &&
        haversineMeters(g.latitude, g.longitude, latitude, longitude) < 100,
    );
    if (same) {
      this.state.geofences[String(id)] = same.id;
      return;
    }

    const billing = c.text(f, "billing_type") === "per_minute" ? "per_minute" : "per_kwh";
    const fee = c.num(f, "session_fee");
    const now = Date.now();
    this.bump(null, "geofences", 1);
    this.returningInsert(
      "INSERT INTO geofences (name, latitude, longitude, radius, billing_type, cost_per_unit, session_fee_cents, " +
        "inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        name,
        latitude,
        longitude,
        Math.min(4999, Math.max(1, c.int(f, "radius") ?? 50)),
        billing,
        c.num(f, "cost_per_unit"),
        fee === null ? null : Math.round(fee * 100),
        c.date(f, "inserted_at") ?? now,
        c.date(f, "updated_at") ?? now,
      ],
      this.state.geofences,
      id,
    );
  }

  private drive(f: Fields): void {
    const c = this.columns;
    const id = c.int(f, "id");
    const car = this.car(f);
    if (id === null || !car) return;
    const start = c.date(f, "start_date");
    const end = c.date(f, "end_date");
    if (!this.admit(car, start, end, true)) return;
    this.span(car, start!, end);
    this.bump(car, "drives", 1);
    this.bump(car, "distanceKm", c.num(f, "distance") ?? 0);
    this.returningInsert(
      "INSERT INTO drives (car_id, start_date_at, end_date_at, distance, duration_min, speed_max, power_max, power_min, " +
        "start_km, end_km, outside_temp_avg, inside_temp_avg, start_ideal_range_km, end_ideal_range_km, " +
        "start_rated_range_km, end_rated_range_km, start_address_id, end_address_id, start_geofence_id, " +
        "end_geofence_id, import_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        car.carId,
        start,
        end,
        c.num(f, "distance"),
        c.int(f, "duration_min"),
        c.int(f, "speed_max"),
        c.int(f, "power_max"),
        c.int(f, "power_min"),
        c.num(f, "start_km"),
        c.num(f, "end_km"),
        c.num(f, "outside_temp_avg"),
        c.num(f, "inside_temp_avg"),
        c.num(f, "start_ideal_range_km"),
        c.num(f, "end_ideal_range_km"),
        c.num(f, "start_rated_range_km"),
        c.num(f, "end_rated_range_km"),
        this.mapped(this.state.addresses, f, "start_address_id"),
        this.mapped(this.state.addresses, f, "end_address_id"),
        this.mapped(this.state.geofences, f, "start_geofence_id"),
        this.mapped(this.state.geofences, f, "end_geofence_id"),
        car.importId,
      ],
      this.state.drives,
      id,
    );
  }

  private process(f: Fields): void {
    const c = this.columns;
    const id = c.int(f, "id");
    const car = this.car(f);
    if (id === null || !car) return;
    const start = c.date(f, "start_date");
    const end = c.date(f, "end_date");
    if (!this.admit(car, start, end, true)) return;
    this.span(car, start!, end);
    this.state.processCars[String(id)] = car.tmId;
    this.bump(car, "chargingProcesses", 1);
    this.bump(car, "energyAddedKwh", c.num(f, "charge_energy_added") ?? 0);
    const cost = c.num(f, "cost");
    this.returningInsert(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, charge_energy_used, " +
        "duration_min, start_battery_level, end_battery_level, start_ideal_range_km, end_ideal_range_km, " +
        "start_rated_range_km, end_rated_range_km, outside_temp_avg, cost_cents, address_id, geofence_id, import_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        car.carId,
        start,
        end,
        c.num(f, "charge_energy_added"),
        c.num(f, "charge_energy_used"),
        c.int(f, "duration_min"),
        c.int(f, "start_battery_level"),
        c.int(f, "end_battery_level"),
        c.num(f, "start_ideal_range_km"),
        c.num(f, "end_ideal_range_km"),
        c.num(f, "start_rated_range_km"),
        c.num(f, "end_rated_range_km"),
        c.num(f, "outside_temp_avg"),
        cost === null ? null : Math.round(cost * 100),
        this.mapped(this.state.addresses, f, "address_id"),
        this.mapped(this.state.geofences, f, "geofence_id"),
        car.importId,
      ],
      this.state.processes,
      id,
    );
  }

  /** States and updates: a period, clipped to EVBook's first reading. */
  private period(f: Fields): { car: CarPlan; start: number; end: number } | null {
    const car = this.car(f);
    if (!car) return null;
    const start = this.columns.date(f, "start_date");
    let end = this.columns.date(f, "end_date");
    if (start === null || !this.inWindow(start)) return null;
    if (car.cutoffAt !== null) {
      if (start >= car.cutoffAt) return null;
      // TeslaMate's last state is still open when the backup is taken.
      end = end === null ? car.cutoffAt : Math.min(end, car.cutoffAt);
    }
    if (end === null || end < start) return null;
    return { car, start, end };
  }

  private stateRow(f: Fields): void {
    const value = this.columns.text(f, "state");
    if (value !== "online" && value !== "asleep" && value !== "offline") return;
    const period = this.period(f);
    if (!period) return;
    this.span(period.car, period.start, period.end);
    this.bump(period.car, "states", 1);
    this.multiInsert(
      "INSERT INTO states (car_id, state, start_date_at, end_date_at, import_id) VALUES ",
      `(${[period.car.carId, value, period.start, period.end, period.car.importId].map(lit).join(",")})`,
    );
  }

  private update(f: Fields): void {
    const period = this.period(f);
    if (!period) return;
    this.bump(period.car, "updates", 1);
    this.multiInsert(
      "INSERT INTO updates (car_id, start_date_at, end_date_at, version, import_id) VALUES ",
      `(${[period.car.carId, period.start, period.end, this.columns.text(f, "version"), period.car.importId]
        .map(lit)
        .join(",")})`,
    );
  }

  private position(f: Fields): void {
    const c = this.columns;
    const car = this.car(f);
    if (!car) return;
    const at = c.date(f, "date");
    if (at === null) return;
    const tmDrive = c.int(f, "drive_id");
    let driveId: number | null = null;
    if (tmDrive !== null) {
      // A position of a drive that was left out goes with it.
      driveId = this.state.drives[String(tmDrive)] ?? null;
      if (driveId === null) return;
    } else if (!this.inWindow(at) || (car.cutoffAt !== null && at >= car.cutoffAt)) {
      return;
    }
    this.bump(car, "positions", 1);
    const values = [
      car.carId,
      driveId,
      at,
      c.num(f, "latitude"),
      c.num(f, "longitude"),
      c.int(f, "speed"),
      c.int(f, "power"),
      c.num(f, "odometer"),
      c.int(f, "elevation"),
      c.num(f, "ideal_battery_range_km"),
      c.num(f, "rated_battery_range_km"),
      c.num(f, "est_battery_range_km"),
      c.int(f, "battery_level"),
      c.int(f, "usable_battery_level"),
      c.num(f, "outside_temp"),
      c.num(f, "inside_temp"),
      c.int(f, "fan_status"),
      c.num(f, "driver_temp_setting"),
      c.num(f, "passenger_temp_setting"),
      c.bool(f, "is_climate_on"),
      c.bool(f, "is_rear_defroster_on"),
      c.bool(f, "is_front_defroster_on"),
      c.bool(f, "battery_heater"),
      c.bool(f, "battery_heater_on"),
      c.bool(f, "battery_heater_no_power"),
      c.num(f, "tpms_pressure_fl"),
      c.num(f, "tpms_pressure_fr"),
      c.num(f, "tpms_pressure_rl"),
      c.num(f, "tpms_pressure_rr"),
      car.importId,
    ];
    this.multiInsert(
      "INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude, speed, power, odometer, elevation, " +
        "ideal_battery_range_km, rated_battery_range_km, est_battery_range_km, battery_level, usable_battery_level, " +
        "outside_temp, inside_temp, fan_status, driver_temp_setting, passenger_temp_setting, is_climate_on, " +
        "is_rear_defroster_on, is_front_defroster_on, battery_heater, battery_heater_on, battery_heater_no_power, " +
        "tpms_pressure_fl, tpms_pressure_fr, tpms_pressure_rl, tpms_pressure_rr, import_id) VALUES ",
      `(${values.map(lit).join(",")})`,
    );
  }

  private charge(f: Fields): void {
    const c = this.columns;
    const tmProcess = c.int(f, "charging_process_id");
    const process = tmProcess === null ? null : (this.state.processes[String(tmProcess)] ?? null);
    const at = c.date(f, "date");
    if (process === null || at === null) return;
    // Charges carry no car; the session they belong to says whose they are.
    const car = this.state.cars.find((plan) => plan.tmId === this.state.processCars[String(tmProcess)]);
    const importId = car?.importId ?? null;
    if (car) this.bump(car, "charges", 1);
    const values = [
      process,
      at,
      c.int(f, "battery_level"),
      c.int(f, "usable_battery_level"),
      c.num(f, "charge_energy_added") ?? 0,
      c.int(f, "charger_power") ?? 0,
      c.int(f, "charger_voltage"),
      c.int(f, "charger_actual_current"),
      c.int(f, "charger_phases"),
      c.int(f, "charger_pilot_current"),
      c.text(f, "conn_charge_cable"),
      c.bool(f, "fast_charger_present"),
      c.text(f, "fast_charger_brand"),
      c.text(f, "fast_charger_type"),
      c.num(f, "ideal_battery_range_km") ?? c.num(f, "rated_battery_range_km") ?? 0,
      c.num(f, "rated_battery_range_km"),
      c.bool(f, "not_enough_power_to_heat"),
      c.bool(f, "battery_heater"),
      c.bool(f, "battery_heater_on"),
      c.bool(f, "battery_heater_no_power"),
      c.num(f, "outside_temp"),
      importId,
    ];
    this.multiInsert(
      "INSERT INTO charges (charging_process_id, date_at, battery_level, usable_battery_level, charge_energy_added, " +
        "charger_power, charger_voltage, charger_actual_current, charger_phases, charger_pilot_current, " +
        "conn_charge_cable, fast_charger_present, fast_charger_brand, fast_charger_type, ideal_battery_range_km, " +
        "rated_battery_range_km, not_enough_power_to_heat, battery_heater, battery_heater_on, " +
        "battery_heater_no_power, outside_temp, import_id) VALUES ",
      `(${values.map(lit).join(",")})`,
    );
  }
}

// ---- finishing ----

/**
 * What only makes sense once everything is in: drive endpoints and charge
 * locations as EVBook position ids, the car's efficiency from the imported
 * sessions, and the bookkeeping rows.
 */
async function finish(db: SqlDatabase, state: TeslaMateState): Promise<void> {
  for (const car of state.cars) {
    const counts = state.carCounts[String(car.importId)] ?? emptyCounts();
    await db.batch([
      // A drive's ends are its first and last positions, as TeslaMate has them.
      db
        .prepare(
          "UPDATE drives SET " +
            "start_position_id = (SELECT id FROM positions p WHERE p.drive_id = drives.id ORDER BY date_at ASC LIMIT 1), " +
            "end_position_id = (SELECT id FROM positions p WHERE p.drive_id = drives.id ORDER BY date_at DESC LIMIT 1) " +
            "WHERE import_id = ?",
        )
        .bind(car.importId),
      // TeslaMate records a position as a session starts; take the last one at
      // or before the start.
      db
        .prepare(
          "UPDATE charging_processes SET position_id = (SELECT id FROM positions p WHERE p.car_id = ? " +
            "AND p.date_at <= charging_processes.start_date_at ORDER BY p.date_at DESC LIMIT 1) WHERE import_id = ?",
        )
        .bind(car.carId, car.importId),
      db
        .prepare(
          "UPDATE imports SET status = 'done', counts = ?, first_at = ?, last_at = ?, finished_at = ? WHERE id = ?",
        )
        .bind(JSON.stringify(counts), counts.firstAt, counts.lastAt, Date.now(), car.importId),
    ]);
    await new Repo(db, car.carId).recalculateEfficiency();
  }
  // Imported drives arrive with fresh ids above wherever the origin sweep has
  // reached; send it back to the top, as a Tessie import does.
  await db.prepare("UPDATE settings SET drive_origin_swept_before = NULL WHERE id = 1").run();
}

// ---- reporting ----

function progress(state: TeslaMateState, position: number | null, size: number | null): DirectProgress {
  const counts = state.counts;
  let fraction = 0;
  for (const table of state.done) fraction += WEIGHT[table];
  const current = state.current?.table;
  if (current && !state.done.includes(current) && position !== null && size) {
    const block = state.blocks[current];
    if (block) {
      const end = block.end ?? size;
      const share = end > block.start ? Math.min(1, Math.max(0, (position - block.start) / (end - block.start))) : 0;
      fraction += WEIGHT[current] * share;
    }
  }
  if (state.phase === "purge") fraction = 0;
  return {
    fraction: state.phase === "done" ? 1 : Math.min(0.99, fraction),
    stage:
      state.phase === "purge"
        ? "removing the previous import"
        : state.phase === "tables"
          ? (state.current?.table.replace("_", " ") ?? "reading the backup")
          : null,
    carIds: state.cars.map((car) => car.carId),
    vins: state.cars.map((car) => car.vin),
    firstAt: counts.firstAt,
    lastAt: counts.lastAt,
    rows:
      counts.drives +
      counts.chargingProcesses +
      counts.charges +
      counts.positions +
      counts.states +
      counts.updates +
      counts.addresses,
    positions: counts.positions,
    drives: counts.drives,
    chargingProcesses: counts.chargingProcesses,
    charges: counts.charges,
    states: counts.states,
    distanceKm: Math.round(counts.distanceKm * 100) / 100,
    energyAddedKwh: Math.round(counts.energyAddedKwh * 100) / 100,
    replacedRows: counts.replacedRows,
    skipped: { overlapping: counts.skippedOverlapping, unfinished: counts.skippedUnfinished },
    cutoffs: state.cars.map((car) => ({ carId: car.carId, vin: car.vin, cutoffAt: car.cutoffAt })),
  };
}

export const teslamateImporter: DirectImporter<TeslaMateState> = {
  prepare,
  slice,
  progress,
};
