import type { VehicleData } from "../tesla/payload";

/**
 * Contracts for importing history from another logging service.
 *
 * The pipeline has three replaceable pieces:
 *
 *   bundle (zip / directory / R2 object)
 *     -> adapter: vendor rows  -> `VehicleData` snapshots
 *       -> replay: snapshots   -> the same effects the live logger writes
 *
 * Only the adapter knows the vendor. Everything downstream sees Tesla's own
 * payload shape, so an imported history goes through exactly the drive/charge
 * detection and the derivations that `VehicleDO` uses live.
 */

/** One file inside an export bundle. */
export interface BundleEntry {
  /** Path as stored in the bundle, directories included. */
  path: string;
  /** Lower-cased file name without directories — what adapters match on. */
  name: string;
  /** Uncompressed size in bytes, when the bundle knows it. */
  size: number | null;
}

/**
 * A vendor export, whatever it is packed in. The CLI reads a directory or a zip
 * from disk; a Worker could read the same zip out of R2 — adapters never know.
 */
export interface ImportBundle {
  /** Zip file name or directory name. Adapters mine it for a VIN. */
  label: string;
  entries(): Promise<BundleEntry[]>;
  /**
   * Text lines of one entry, without line terminators. Every call starts a
   * fresh reader, and abandoning the iterator releases it.
   */
  lines(path: string): AsyncIterable<string>;
}

/** What an adapter can tell about a bundle before importing anything. */
export interface SourceDetection {
  /** 0 = not this vendor, 1 = certain. */
  confidence: number;
  /** VIN read out of the bundle, when it carries one. */
  vin: string | null;
  /** Entries the adapter will read. */
  recognised: string[];
  /** Entries the adapter knows about but did not find. */
  missing: string[];
  /** Anything the operator should know — unmapped columns, empty files. */
  notes: string[];
}

export interface SnapshotOptions {
  /** Inclusive lower bound on sample time, epoch ms. */
  since?: number;
  /** Inclusive upper bound on sample time, epoch ms. */
  until?: number;
  /**
   * Minimum spacing between emitted snapshots in seconds; 0 keeps every sample.
   * Samples that change a state-machine-relevant field (shift, charging state)
   * are always emitted, so thinning cannot hide a transition.
   */
  minIntervalS?: number;
  /** Display name to put on the car, when the export does not carry one. */
  carName?: string;
  /** Collects notes about the data — surfaced in the import report. */
  warn?(message: string): void;
}

/** One reconstructed `vehicle_data` payload. `at` is `snapshotDate(data)`. */
export interface ImportSnapshot {
  at: number;
  data: VehicleData;
}

interface SourceBase {
  /** Stable id used by `--source`. */
  id: string;
  label: string;
  /** One line for `--list-sources`. */
  describe: string;
  /** How to produce the export, for the CLI's help text. */
  howToExport?: string;
  /** File-picker hint for the import page, e.g. `.zip`. */
  accept?: string;
  detect(bundle: ImportBundle): Promise<SourceDetection>;
}

/**
 * A vendor whose export is raw samples: the adapter rebuilds Tesla's payloads
 * and they are replayed through the live state machine (`replay.ts`).
 */
export interface ReplaySource extends SourceBase {
  mode?: "replay";
  /** Snapshots in ascending `at` order, with no two sharing a timestamp. */
  snapshots(bundle: ImportBundle, options: SnapshotOptions): AsyncIterable<ImportSnapshot>;
  /**
   * First and last sample time, read as cheaply as the format allows — the
   * progress bar needs to know how far there is to go. Optional: without it an
   * import still runs, it just cannot report a percentage.
   */
  span?(bundle: ImportBundle): Promise<{ firstAt: number; lastAt: number } | null>;
}

/**
 * A vendor whose export already holds finished drives and charging sessions in
 * EVBook's own shape (TeslaMate): its rows are written directly, by an importer
 * in `direct.ts`, rather than re-derived from samples.
 */
export interface DirectSource extends SourceBase {
  mode: "direct";
}

export type ImportSourceAdapter = ReplaySource | DirectSource;

/** Running totals, reported while the import walks the export. */
export interface ImportProgress {
  snapshots: number;
  positions: number;
  drives: number;
  chargingProcesses: number;
  charges: number;
  /** Timestamp of the snapshot last handled — drives the ETA. */
  at: number;
}

export interface ImportReport {
  source: string;
  carId: number;
  vin: string | null;
  dryRun: boolean;
  snapshots: number;
  /** Time span actually covered by the imported samples. */
  firstAt: number | null;
  lastAt: number | null;
  positions: number;
  drives: number;
  /** Drives the close rule threw away (under two positions or under 10 m). */
  drivesDiscarded: number;
  chargingProcesses: number;
  charges: number;
  states: number;
  distanceKm: number;
  energyAddedKwh: number;
  /** Lookups that went out to the geocoder. */
  addressesLookedUp: number;
  /** Lookups a cache answered, saving a request. */
  addressesReused: number;
  addressesResolved: number;
  /** Pre-existing rows dropped because the import covered the same period. */
  replacedRows: number;
  /**
   * Events a direct import left out: those overlapping what EVBook had already
   * logged for the car, and those the source never finished.
   */
  skipped?: { overlapping: number; unfinished: number };
  warnings: string[];
  durationMs: number;
}
