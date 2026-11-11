import { teslamateImporter } from "./teslamate";
import type { ImportBundle } from "./types";
import type { SqlDatabase } from "../../platform/ports";

/**
 * The contract for sources whose rows are written directly rather than
 * replayed (`DirectSource`). An importer is three pure-data steps, so the same
 * code runs to completion in the CLI and a slice at a time in the import actor:
 *
 *   prepare  — resolve the cars, open bookkeeping; returns the state
 *   slice    — do some work, stop when told, return the new state
 *   progress — what the state amounts to, for the report and the progress bar
 *
 * The state is plain data the actor keeps in its storage between alarms.
 */

export interface DirectOptions {
  /** The uploaded file's name, recorded with the import. */
  label: string;
  vin?: string;
  carId?: number;
  carName?: string;
  since?: number;
  until?: number;
  warn?(message: string): void;
}

export interface DirectControl {
  /** Asked after every committed batch; true means stop and return. */
  stopAfter(): boolean;
  warn?(message: string): void;
  /** Bytes of the upload read so far in this slice, for the progress bar. */
  position?(): number | null;
  /** Commit after this many rows at most — only the specs want slices this small. */
  batchRows?: number;
}

export interface DirectProgress {
  /** 0..1 through the work. */
  fraction: number;
  /** What it is working on, in words — "positions", "removing the previous import". */
  stage: string | null;
  carIds: number[];
  vins: string[];
  firstAt: number | null;
  lastAt: number | null;
  /** History rows written. */
  rows: number;
  positions: number;
  drives: number;
  chargingProcesses: number;
  charges: number;
  states: number;
  distanceKm: number;
  energyAddedKwh: number;
  replacedRows: number;
  skipped: { overlapping: number; unfinished: number };
  /** Per car: EVBook's first reading, before which history was taken. */
  cutoffs: { carId: number; vin: string; cutoffAt: number | null }[];
}

export interface DirectImporter<S> {
  prepare(db: SqlDatabase, bundle: ImportBundle, options: DirectOptions): Promise<S>;
  slice(db: SqlDatabase, bundle: ImportBundle, state: S, control: DirectControl): Promise<{ state: S; done: boolean }>;
  progress(state: S, position: number | null, size: number | null): DirectProgress;
}

const importers: Record<string, DirectImporter<unknown>> = {
  teslamate: teslamateImporter as DirectImporter<unknown>,
};

export function directImporter(sourceId: string): DirectImporter<unknown> {
  const importer = importers[sourceId];
  if (!importer) throw new Error(`no direct importer for "${sourceId}"`);
  return importer;
}
