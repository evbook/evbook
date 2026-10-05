import { decodeVin } from "../../../shared/vin";
import { detectSources, getSource, listSources } from "./sources";
import { ImportRepo, type GeocodeOptions } from "./repo";
import { replay } from "./replay";
import type { ImportBundle, ImportProgress, ImportReport, ImportSourceAdapter } from "./types";
import type { SqlDatabase } from "../../platform/ports";

/**
 * Public entry point for importing another service's history.
 *
 * `runImport` is transport-agnostic on purpose: it takes a `SqlDatabase` and an
 * `ImportBundle`, so the same code path serves the CLI (`npm run import`) and
 * could serve an upload handler later without changes.
 */

export { listSources } from "./sources";
export * from "./types";

export interface RunImportOptions {
  /** Required unless `dryRun` is set — a dry run never touches a database. */
  db?: SqlDatabase;
  bundle: ImportBundle;
  /** Adapter id; auto-detected when omitted. */
  sourceId?: string;
  /** Overrides the VIN the adapter found in the bundle. */
  vin?: string;
  /** Import into this car instead of resolving one by VIN. */
  carId?: number;
  /** Name for a car this import creates. */
  carName?: string;
  since?: number;
  until?: number;
  minIntervalS?: number;
  geocode?: GeocodeOptions;
  /** Parse and summarise without writing anything. */
  dryRun?: boolean;
  sleepGapMin?: number;
  onProgress?: (progress: ImportProgress) => void;
  signal?: AbortSignal;
}

export async function runImport(options: RunImportOptions): Promise<ImportReport> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (message: string) => {
    // Adapters warn per file, so the same note can arrive many times.
    if (seen.has(message)) return;
    seen.add(message);
    warnings.push(message);
  };

  const { source, vin } = await pickSource(options);
  const snapshotOptions = {
    since: options.since,
    until: options.until,
    minIntervalS: options.minIntervalS,
    carName: options.carName,
    warn,
  };

  if (options.dryRun) {
    const preview = await previewSnapshots(source, options.bundle, snapshotOptions, options.signal, options.onProgress);
    return {
      source: source.id,
      carId: options.carId ?? 0,
      vin,
      dryRun: true,
      snapshots: preview.snapshots,
      firstAt: preview.firstAt,
      lastAt: preview.lastAt,
      positions: 0,
      drives: preview.driveStarts,
      drivesDiscarded: 0,
      chargingProcesses: preview.chargeStarts,
      charges: 0,
      states: 0,
      distanceKm: preview.distanceKm,
      energyAddedKwh: 0,
      addressesLookedUp: 0,
      addressesReused: 0,
      addressesResolved: 0,
      replacedRows: 0,
      warnings,
      durationMs: Date.now() - startedAt,
    };
  }

  const db = options.db;
  if (!db) throw new Error("runImport needs a database unless dryRun is set");

  const car = await resolveCar(db, { carId: options.carId, vin, name: options.carName });
  const carId = car.carId;
  if (car.how === "only-car") warn(`the export carries no VIN — importing into the only car on record (${carId})`);
  const baseline = await captureBaseline(db);

  const repo = new ImportRepo(db, carId, options.geocode ?? { enabled: false });
  const settings = await repo.getCarSettings();

  const { state } = await replay(source.snapshots(options.bundle, snapshotOptions), repo, {
    settings,
    sleepGapMin: options.sleepGapMin,
    onProgress: options.onProgress,
    signal: options.signal,
  });
  const counters = state.counters;

  // Anything the car already had inside the period just imported is superseded.
  // The window reaches a second past the last sample because that is where the
  // import's own closing "asleep" row sits — otherwise a re-import leaves the
  // previous run's behind.
  const replaced =
    counters.firstAt === null
      ? 0
      : await clearOverlap(db, carId, counters.firstAt, (counters.lastAt ?? counters.firstAt) + 1_000, baseline);
  if (replaced > 0) warn(`replaced ${replaced} row(s) that already covered part of this period`);

  return {
    replacedRows: replaced,
    source: source.id,
    carId,
    vin,
    dryRun: false,
    snapshots: counters.snapshots,
    firstAt: counters.firstAt,
    lastAt: counters.lastAt,
    positions: counters.positions,
    drives: counters.drives,
    drivesDiscarded: counters.drivesDiscarded,
    chargingProcesses: counters.chargingProcesses,
    charges: counters.charges,
    states: counters.states,
    distanceKm: counters.distanceKm,
    energyAddedKwh: counters.energyAddedKwh,
    addressesLookedUp: repo.requests,
    addressesReused: repo.cached + repo.reused,
    addressesResolved: repo.resolved,
    warnings,
    durationMs: Date.now() - startedAt,
  };
}

async function pickSource(
  options: RunImportOptions,
): Promise<{ source: ImportSourceAdapter; vin: string | null }> {
  if (options.sourceId) {
    const source = getSource(options.sourceId);
    if (!source) {
      throw new Error(
        `unknown import source "${options.sourceId}" — known sources: ${listSources().map((s) => s.id).join(", ")}`,
      );
    }
    const detection = await source.detect(options.bundle);
    return { source, vin: options.vin ?? detection.vin };
  }

  const detected = await detectSources(options.bundle);
  const best = detected[0];
  if (!best || best.detection.confidence < 0.5) {
    throw new Error(
      "could not tell which service this export came from — pass --source explicitly " +
        `(known sources: ${listSources().map((s) => s.id).join(", ")})`,
    );
  }
  return { source: best.source, vin: options.vin ?? best.detection.vin };
}

export interface ResolvedCar {
  carId: number;
  /** How the car was chosen, so the caller can say so in the report. */
  how: "id" | "vin" | "created" | "only-car";
}

/**
 * Finds the car this history belongs to.
 *
 * A VIN is the reliable answer, and vendor exports usually carry one in the file
 * name. When they do not — the user renamed the download, say — a database with
 * exactly one car has only one sensible answer, so use it and let the caller
 * report that it did. With several cars and no VIN there is nothing to guess
 * from, so ask.
 */
export async function resolveCar(
  db: SqlDatabase,
  target: { carId?: number; vin: string | null; name?: string },
): Promise<ResolvedCar> {
  if (target.carId !== undefined) {
    const row = await db.prepare("SELECT id FROM cars WHERE id = ?").bind(target.carId).first<{ id: number }>();
    if (!row) throw new Error(`car ${target.carId} does not exist`);
    return { carId: row.id, how: "id" };
  }

  if (!target.vin) {
    const cars = await db.prepare("SELECT id, vin FROM cars ORDER BY id").all<{ id: number; vin: string }>();
    if (cars.results.length === 1) return { carId: cars.results[0]!.id, how: "only-car" };
    if (cars.results.length === 0) {
      throw new Error(
        "the export carries no VIN, and there is no car to import into — say which car this history belongs to",
      );
    }
    throw new Error(
      `the export carries no VIN — say which car this history belongs to (${cars.results
        .map((car) => car.vin)
        .join(", ")})`,
    );
  }

  const existing = await db.prepare("SELECT id FROM cars WHERE vin = ?").bind(target.vin).first<{ id: number }>();
  if (existing) return { carId: existing.id, how: "vin" };

  const info = decodeVin(target.vin);
  const now = Date.now();
  const inserted = await db
    .prepare(
      "INSERT INTO cars (vin, name, model, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(target.vin, target.name ?? target.vin, info.model, now, now)
    .first<{ id: number }>();
  if (!inserted) throw new Error("failed to create the car row");

  // An imported car has no Tesla id, so leave polling off: the watchdog would
  // otherwise wake a Durable Object every ten minutes for a car it cannot fetch.
  // The pack chemistry comes from the VIN, so nobody has to be asked for it.
  await db
    .prepare("INSERT OR IGNORE INTO car_settings (car_id, enabled, lfp_battery) VALUES (?, 0, ?)")
    .bind(inserted.id, info.batteryChemistry === "lfp" ? 1 : 0)
    .run();
  return { carId: inserted.id, how: "created" };
}

/**
 * The highest row id in each logged table, taken before an import starts.
 *
 * This is how the import tells its own rows apart from what was already there,
 * without a flag on every table: SQLite hands out ids above the current maximum,
 * so anything above the baseline was written by this import. Rows the live
 * logger writes while an import runs also land above it, which errs on the safe
 * side — they are kept rather than treated as stale.
 */
export interface ImportBaseline {
  drives: number;
  positions: number;
  chargingProcesses: number;
  charges: number;
  states: number;
  updates: number;
}

export async function captureBaseline(db: SqlDatabase): Promise<ImportBaseline> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(MAX(id), 0) FROM drives) AS drives,
         (SELECT COALESCE(MAX(id), 0) FROM positions) AS positions,
         (SELECT COALESCE(MAX(id), 0) FROM charging_processes) AS charging_processes,
         (SELECT COALESCE(MAX(id), 0) FROM charges) AS charges,
         (SELECT COALESCE(MAX(id), 0) FROM states) AS states,
         (SELECT COALESCE(MAX(id), 0) FROM updates) AS updates`,
    )
    .first<{
      drives: number;
      positions: number;
      charging_processes: number;
      charges: number;
      states: number;
      updates: number;
    }>();
  return {
    drives: row?.drives ?? 0,
    positions: row?.positions ?? 0,
    chargingProcesses: row?.charging_processes ?? 0,
    charges: row?.charges ?? 0,
    states: row?.states ?? 0,
    updates: row?.updates ?? 0,
  };
}

/**
 * Resolves a collision between an import and history the car already had:
 * whatever the car already held inside `[from, to]` is dropped, and everything
 * outside it is left alone. So importing a period the car has never seen merges,
 * importing one it has seen replaces, and re-running the same export twice is
 * idempotent rather than duplicating.
 *
 * Only rows at or below the baseline are touched, so the rows this import just
 * wrote survive — which is why this can safely run after the writes rather than
 * needing to know the period up front. Children go first; `positions.drive_id`
 * and the address and geofence references are all `ON DELETE SET NULL`.
 */
export async function clearOverlap(
  db: SqlDatabase,
  carId: number,
  from: number,
  to: number,
  baseline: ImportBaseline,
): Promise<number> {
  const statements = [
    db
      .prepare(
        "DELETE FROM charges WHERE id <= ? AND charging_process_id IN " +
          "(SELECT id FROM charging_processes WHERE car_id = ? AND start_date_at BETWEEN ? AND ?)",
      )
      .bind(baseline.charges, carId, from, to),
    db
      .prepare("DELETE FROM charging_processes WHERE id <= ? AND car_id = ? AND start_date_at BETWEEN ? AND ?")
      .bind(baseline.chargingProcesses, carId, from, to),
    db
      .prepare("DELETE FROM drives WHERE id <= ? AND car_id = ? AND start_date_at BETWEEN ? AND ?")
      .bind(baseline.drives, carId, from, to),
    db
      .prepare("DELETE FROM positions WHERE id <= ? AND car_id = ? AND date_at BETWEEN ? AND ?")
      .bind(baseline.positions, carId, from, to),
    db
      .prepare("DELETE FROM states WHERE id <= ? AND car_id = ? AND start_date_at BETWEEN ? AND ?")
      .bind(baseline.states, carId, from, to),
    db
      .prepare("DELETE FROM updates WHERE id <= ? AND car_id = ? AND start_date_at BETWEEN ? AND ?")
      .bind(baseline.updates, carId, from, to),
  ];
  const results = await db.batch(statements);
  return results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
}

interface Preview {
  snapshots: number;
  firstAt: number | null;
  lastAt: number | null;
  driveStarts: number;
  chargeStarts: number;
  distanceKm: number;
}

/** Walks the export without writing, to show what an import would find. */
async function previewSnapshots(
  source: ImportSourceAdapter,
  bundle: ImportBundle,
  options: Parameters<ImportSourceAdapter["snapshots"]>[1],
  signal: AbortSignal | undefined,
  onProgress: ((progress: ImportProgress) => void) | undefined,
): Promise<Preview> {
  const preview: Preview = {
    snapshots: 0,
    firstAt: null,
    lastAt: null,
    driveStarts: 0,
    chargeStarts: 0,
    distanceKm: 0,
  };
  const DRIVING = new Set(["D", "N", "R"]);
  let driving = false;
  let charging = false;
  let firstOdometer: number | null = null;
  let lastOdometer: number | null = null;

  for await (const snapshot of source.snapshots(bundle, options)) {
    signal?.throwIfAborted();
    const shift = snapshot.data.drive_state?.shift_state ?? null;
    const nowDriving = shift !== null && DRIVING.has(shift);
    if (nowDriving && !driving) preview.driveStarts++;
    driving = nowDriving;

    const state = snapshot.data.charge_state?.charging_state ?? null;
    const nowCharging = state === "Charging" || state === "Starting";
    if (nowCharging && !charging) preview.chargeStarts++;
    charging = nowCharging;

    const odometer = snapshot.data.vehicle_state?.odometer ?? null;
    if (odometer != null) {
      firstOdometer ??= odometer;
      lastOdometer = odometer;
    }

    preview.snapshots++;
    preview.firstAt ??= snapshot.at;
    preview.lastAt = snapshot.at;
    if (onProgress && preview.snapshots % 5_000 === 0) {
      onProgress({
        snapshots: preview.snapshots,
        positions: 0,
        drives: preview.driveStarts,
        chargingProcesses: preview.chargeStarts,
        charges: 0,
        at: snapshot.at,
      });
    }
  }

  if (firstOdometer !== null && lastOdometer !== null) {
    preview.distanceKm = Math.round(((lastOdometer - firstOdometer) / 0.62137119223733) * 100) / 100;
  }
  return preview;
}
