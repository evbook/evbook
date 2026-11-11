import { fileBundle } from "../core/import/bundle";
import { directImporter, type DirectProgress } from "../core/import/direct";
import { countingDatabase } from "../core/import/budget";
import { captureBaseline, clearOverlap, resolveCar, type ImportBaseline } from "../core/import/index";
import { detectSources, getSource } from "../core/import/sources";
import { ImportRepo, type KnownPoint } from "../core/import/repo";
import { replay, type ReplayCounters, type ReplayState } from "../core/import/replay";
import type { ByteReader } from "../core/import/zip";
import type { ImportJobDto } from "@shared/api-types";
import type { AppEnv } from "../platform/env";
import type { ActorStorage, StartImportOptions } from "../platform/ports";
import type { ImportBundle } from "../core/import/types";

/**
 * Runs one history import to completion, a slice at a time.
 *
 * A two-year export is tens of thousands of D1 calls and far more work than one
 * request may do, so the upload is parked in this object's storage and the
 * replay advances on alarms: each tick reads a slice, writes it, remembers where
 * it got to, and re-arms. The replay's own state is plain data (the same
 * `FsmData` the live logger persists between polls), which is what makes
 * stopping and resuming safe.
 *
 * The browser only uploads and polls; closing the tab does not stop the import.
 */

/**
 * D1 round trips per tick. Every call is a subrequest and an invocation has a
 * hard cap, so this leaves room for the few dozen a single snapshot can trigger
 * when it closes a drive or completes a charging session.
 */
const CALL_BUDGET = 700;

/** Also yield on elapsed time, so a slow database cannot stall one tick forever. */
const TICK_MS = 20_000;

/** Uploads are stored in pieces this size, safely under the per-value limit. */
const CHUNK_BYTES = 128 * 1024;

const MAX_ATTEMPTS = 3;

/**
 * How long a stopped import's upload is kept so it can be resumed. Long enough to
 * come back after a day or two of not thinking about it; short enough that an
 * abandoned import does not sit on tens of megabytes forever.
 */
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface JobRecord {
  id: string;
  label: string;
  source: string;
  vin: string | null;
  carId: number | null;
  phase: ImportJobDto["phase"];
  startedAt: number;
  finishedAt: number | null;
  since: number | null;
  until: number | null;
  geocode: boolean;
  geocodeRadiusMeters: number | null;
  /** The export's own period, for the progress bar. */
  firstAt: number | null;
  lastAt: number | null;
  /** Sample time reached so far. */
  at: number | null;
  counters: ReplayCounters | null;
  replacedRows: number;
  error: string | null;
  attempts: number;
  /** When the kept upload will be discarded, for a stopped import. */
  uploadExpiresAt: number | null;
  /**
   * A direct import's own measure of how far it is, and what it left out. Absent
   * on jobs stored before direct imports existed, hence optional.
   */
  fraction?: number | null;
  stage?: string | null;
  skipped?: { overlapping: number; unfinished: number } | null;
}

export class ImportActor {
  constructor(
    protected readonly storage: ActorStorage,
    protected readonly env: AppEnv,
  ) {}

  // ---- upload ----

  /** Clears any previous import and starts collecting bytes. */
  async begin(label: string): Promise<void> {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    const job: JobRecord = {
      id: crypto.randomUUID(),
      label,
      source: "",
      vin: null,
      carId: null,
      phase: "uploading",
      startedAt: Date.now(),
      finishedAt: null,
      since: null,
      until: null,
      geocode: false,
      geocodeRadiusMeters: null,
      firstAt: null,
      lastAt: null,
      at: null,
      counters: null,
      replacedRows: 0,
      error: null,
      attempts: 0,
      uploadExpiresAt: null,
    };
    await this.storage.put("job", job);
    await this.storage.put("size", 0);
  }

  /** Appends part of the upload. Called repeatedly as the body streams in. */
  async append(bytes: Uint8Array): Promise<void> {
    let size = (await this.storage.get<number>("size")) ?? 0;
    const writes: Record<string, Uint8Array> = {};

    let offset = 0;
    while (offset < bytes.length) {
      const index = Math.floor(size / CHUNK_BYTES);
      const room = CHUNK_BYTES - (size % CHUNK_BYTES);
      const piece = bytes.subarray(offset, offset + room);
      const key = `bytes:${index}`;
      const existing = writes[key] ?? (await this.storage.get<Uint8Array>(key));
      if (existing) {
        const merged = new Uint8Array(existing.length + piece.length);
        merged.set(existing, 0);
        merged.set(piece, existing.length);
        writes[key] = merged;
      } else {
        // Copy: the slice would otherwise keep the whole incoming buffer alive.
        writes[key] = new Uint8Array(piece);
      }
      offset += piece.length;
      size += piece.length;
    }

    await this.storage.put(writes);
    await this.storage.put("size", size);
  }

  /** Bytes received so far — where the next part of a multi-part upload must start. */
  async uploadedBytes(): Promise<number> {
    return (await this.storage.get<number>("size")) ?? 0;
  }

  /** Identifies the export, resolves the car, and schedules the first slice. */
  async start(options: StartImportOptions): Promise<ImportJobDto> {
    const job = await this.job();
    if (!job) throw new Error("no upload to import");

    try {
      const size = (await this.storage.get<number>("size")) ?? 0;
      if (size === 0) throw new Error("the upload is empty");
      const bundle = await fileBundle(job.label, this.byteReader(size));
      // Reading the directory first means "this is not a zip" is reported as
      // such, rather than as no adapter recognising the export.
      await bundle.entries();

      let source = options.sourceId ? getSource(options.sourceId) : null;
      if (options.sourceId && !source) throw new Error(`unknown import source "${options.sourceId}"`);
      if (!source) {
        const best = (await detectSources(bundle))[0];
        if (!best || best.detection.confidence < 0.5) {
          throw new Error("could not tell which service this export came from");
        }
        source = best.source;
      }
      const detection = await source.detect(bundle);
      if (source.mode === "direct") return await this.startDirect(job, source.id, bundle, options, detection.notes);
      const vin = options.vin ?? detection.vin;

      const car = await resolveCar(this.env.DB, { carId: options.carId, vin, name: options.carName });
      const carId = car.carId;
      const notes = [...detection.notes];
      if (car.how === "only-car") {
        notes.push(`the export carries no VIN — importing into the only car on record (${carId})`);
      }
      await this.storage.put("baseline", await captureBaseline(this.env.DB));

      // Knowing the period up front is what lets the UI show a percentage.
      const span = source.span ? await source.span(bundle) : null;

      const started: JobRecord = {
        ...job,
        source: source.id,
        vin,
        carId,
        phase: "importing",
        since: options.since ?? null,
        until: options.until ?? null,
        geocode: options.geocode ?? false,
        geocodeRadiusMeters: options.geocodeRadiusMeters ?? null,
        firstAt: clamp(span?.firstAt ?? null, options.since, options.until),
        lastAt: clamp(span?.lastAt ?? null, options.since, options.until),
      };
      await this.storage.put("job", started);
      await this.storage.put("warnings", notes);
      await this.storage.setAlarm(Date.now() + this.tickDelayMs());
      return this.toDto(started, notes, false);
    } catch (error) {
      // Nothing about this upload can be salvaged — a file that is not an export,
      // or no way to tell which car it belongs to.
      return this.fail(job, error, { keepUpload: false });
    }
  }

  /**
   * A source written directly (TeslaMate): the importer matches the cars and
   * opens its bookkeeping now, so a backup with no usable car fails here rather
   * than on the first alarm.
   */
  private async startDirect(
    job: JobRecord,
    sourceId: string,
    bundle: ImportBundle,
    options: StartImportOptions,
    detectionNotes: string[],
  ): Promise<ImportJobDto> {
    const notes = [...detectionNotes];
    const importer = directImporter(sourceId);
    const state = await importer.prepare(this.env.DB, bundle, {
      label: job.label,
      vin: options.vin,
      carId: options.carId,
      carName: options.carName,
      since: options.since,
      until: options.until,
      warn: (message) => notes.push(message),
    });
    const progress = importer.progress(state, null, null);
    await this.storage.put("direct", state);
    const started: JobRecord = {
      ...job,
      source: sourceId,
      vin: progress.vins.length === 1 ? progress.vins[0]! : null,
      carId: progress.carIds[0] ?? null,
      phase: "importing",
      since: options.since ?? null,
      until: options.until ?? null,
      fraction: 0,
      stage: null,
      skipped: progress.skipped,
    };
    await this.storage.put("job", started);
    await this.storage.put("warnings", notes);
    await this.storage.setAlarm(Date.now() + this.tickDelayMs());
    return this.toDto(started, notes, false);
  }

  async status(): Promise<ImportJobDto | null> {
    const job = await this.job();
    if (!job) return null;
    const stopped = job.phase === "cancelled" || job.phase === "failed";
    const held = (await this.storage.get<number>("size")) ?? 0;
    return this.toDto(
      job,
      (await this.storage.get<string[]>("warnings")) ?? [],
      stopped && held > 0 && job.carId !== null,
    );
  }

  /**
   * Stops the import but keeps the upload and the cursor, so it can be resumed
   * rather than started over. Whatever it had already written stays in the
   * database — that is the point of resuming.
   */
  async cancel(): Promise<void> {
    const job = await this.job();
    await this.storage.deleteAlarm();
    if (!job) return;
    if (job.phase === "done") return;
    const expiresAt = Date.now() + UPLOAD_TTL_MS;
    await this.storage.put("job", {
      ...job,
      phase: "cancelled",
      finishedAt: Date.now(),
      uploadExpiresAt: expiresAt,
    } satisfies JobRecord);
    // The only alarm this object has left: come back and throw the upload away if
    // nobody resumes. Resuming overwrites it with the next slice.
    await this.storage.setAlarm(expiresAt);
  }

  /** Carries on from where a cancelled or failed import stopped. */
  async resume(): Promise<ImportJobDto> {
    const job = await this.job();
    if (!job) throw new Error("there is no import to resume");
    if (job.phase === "importing") return (await this.status())!;
    if (job.phase !== "cancelled" && job.phase !== "failed") {
      throw new Error(`a ${job.phase} import cannot be resumed`);
    }
    if (job.carId === null) throw new Error("this import never got as far as choosing a car");
    if (((await this.storage.get<number>("size")) ?? 0) === 0) {
      throw new Error("the uploaded export is no longer here — upload it again");
    }

    const resumed: JobRecord = {
      ...job,
      phase: "importing",
      finishedAt: null,
      error: null,
      attempts: 0,
      uploadExpiresAt: null,
    };
    await this.storage.put("job", resumed);
    await this.storage.setAlarm(Date.now() + this.tickDelayMs());
    return this.toDto(resumed, (await this.storage.get<string[]>("warnings")) ?? [], false);
  }

  /** Throws the whole job away, upload included. */
  async discard(): Promise<void> {
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
  }

  // ---- the work ----

  async alarm(): Promise<void> {
    const job = await this.job();
    if (!job) return;
    // An object has one alarm. While the import runs it is the next slice; once it
    // has stopped, the only thing left to wake up for is dropping the upload.
    if (job.phase !== "importing") {
      await this.expireUpload(job);
      return;
    }
    if (job.carId === null) return;

    try {
      await this.tick(job);
    } catch (error) {
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        // Keep the upload: whatever went wrong may be transient, and resuming
        // costs nothing compared with uploading and replaying it all again.
        await this.fail(job, error, { keepUpload: true });
        return;
      }
      await this.storage.put("job", { ...job, attempts } satisfies JobRecord);
      await this.storage.setAlarm(Date.now() + Math.max(1_000, this.tickDelayMs()));
    }
  }

  private async tick(job: JobRecord): Promise<void> {
    const size = (await this.storage.get<number>("size")) ?? 0;
    const source = getSource(job.source);
    if (!source) throw new Error(`import source "${job.source}" is not available`);
    if (source.mode === "direct") return this.directTick(job, size);

    const state = (await this.storage.get<ReplayState>("state")) ?? undefined;
    const baseline = (await this.storage.get<ImportBaseline>("baseline")) ?? EMPTY_BASELINE;
    const warnings = new Set((await this.storage.get<string[]>("warnings")) ?? []);

    const counting = countingDatabase(this.env.DB);
    // Places asked about in earlier slices, so the same home address is not
    // looked up once per slice.
    const known = job.geocode ? ((await this.storage.get<KnownPoint[]>("geocache")) ?? []) : [];
    const repo = new ImportRepo(counting.db, job.carId!, {
      enabled: job.geocode,
      baseUrl: this.env.NOMINATIM_HOST,
      radiusMeters: job.geocodeRadiusMeters ?? undefined,
      known,
      lastLookupAt: job.geocode ? ((await this.storage.get<number>("geoclock")) ?? 0) : 0,
    });
    const settings = await repo.getCarSettings();

    // Resume where the last slice stopped. The adapter still reads the export
    // from the beginning — carry-forward between its files depends on that — but
    // only emits samples after this point.
    const resumeFrom = state?.counters.lastAt;
    const since = resumeFrom != null ? resumeFrom + 1 : (job.since ?? undefined);

    const startedAt = Date.now();
    const result = await replay(
      source.snapshots(await fileBundle(job.label, this.byteReader(size)), {
        since,
        until: job.until ?? undefined,
        warn: (message) => warnings.add(message),
      }),
      repo,
      {
        settings,
        resume: state,
        stopAfter: () => counting.calls() >= CALL_BUDGET || Date.now() - startedAt >= TICK_MS,
      },
    );

    const counters = result.state.counters;
    // Whatever the car already had for the period this slice covered is stale
    // now. Only rows from before the import are touched, so this is safe to do
    // after the writes rather than needing the period up front.
    const from = resumeFrom ?? counters.firstAt;
    const replaced =
      from != null && counters.lastAt != null
        ? // A second past the last sample: that is where the closing "asleep"
          // row sits, and a re-import has to supersede the previous run's.
          await clearOverlap(this.env.DB, job.carId!, from, counters.lastAt + 1_000, baseline)
        : 0;

    await this.storage.put("state", result.state);
    await this.storage.put("warnings", [...warnings]);
    if (job.geocode) {
      await this.storage.put("geocache", [...repo.knownPoints()]);
      await this.storage.put("geoclock", repo.lastRequestAt());
    }

    // A cancel can land while a slice is running, so take the job as it is now
    // rather than as it was when the slice started.
    const current = (await this.job()) ?? job;
    const wanted = current.phase === "importing";
    const next: JobRecord = {
      ...current,
      attempts: 0,
      at: counters.lastAt,
      counters,
      replacedRows: current.replacedRows + replaced,
      phase: wanted ? (result.done ? "done" : "importing") : current.phase,
      finishedAt: wanted ? (result.done ? Date.now() : null) : current.finishedAt,
    };

    if (!wanted) {
      // Cancelled while this slice was running. Its writes stay — they are in the
      // database and the cursor above matches them — but the job must not be
      // resurrected or re-armed.
      await this.storage.put("job", next);
      return;
    }

    if (result.done) {
      // The upload and the replay state have done their job; the report stays.
      await this.discardUpload();
      await this.storage.put("job", next);
      // The imported drives carry the source's own missed starts, and their ids
      // sit above wherever the origin sweep has reached. Send it back to the
      // top; drives it already repaired no longer match and cost nothing.
      await this.env.DB.prepare("UPDATE settings SET drive_origin_swept_before = NULL WHERE id = 1").run();
    } else {
      await this.storage.put("job", next);
      await this.storage.setAlarm(Date.now() + this.tickDelayMs());
    }
  }

  /**
   * One slice of a direct import. The importer reads the upload from the start
   * every slice and skips what is done; its state is written back whatever
   * happens, because it only ever records what has been committed.
   */
  private async directTick(job: JobRecord, size: number): Promise<void> {
    const importer = directImporter(job.source);
    const state = await this.storage.get<unknown>("direct");
    if (state === undefined) throw new Error("the import's progress was lost — upload the backup again");
    const warnings = new Set((await this.storage.get<string[]>("warnings")) ?? []);

    // How far into the upload this slice has read, for the progress bar.
    let reached = 0;
    const reader = this.byteReader(size);
    const tracked: ByteReader = {
      size,
      read: (offset, length) => {
        reached = Math.max(reached, offset + length);
        return reader.read(offset, length);
      },
    };

    const counting = countingDatabase(this.env.DB);
    const startedAt = Date.now();
    let result: { done: boolean };
    try {
      result = await importer.slice(counting.db, await fileBundle(job.label, tracked), state, {
        stopAfter: () => counting.calls() >= CALL_BUDGET || Date.now() - startedAt >= TICK_MS,
        warn: (message) => warnings.add(message),
        position: () => Math.min(reached, size),
      });
    } finally {
      await this.storage.put("direct", state);
      await this.storage.put("warnings", [...warnings]);
    }

    const progress = importer.progress(state, Math.min(reached, size), size);
    const current = (await this.job()) ?? job;
    const wanted = current.phase === "importing";
    const next: JobRecord = {
      ...current,
      ...directFields(progress),
      attempts: 0,
      phase: wanted ? (result.done ? "done" : "importing") : current.phase,
      finishedAt: wanted ? (result.done ? Date.now() : null) : current.finishedAt,
    };
    await this.storage.put("job", next);
    if (!wanted) return;
    if (result.done) await this.discardUpload();
    else await this.storage.setAlarm(Date.now() + this.tickDelayMs());
  }

  /**
   * Pause before the next slice. Env-tunable for one consumer: the test suite
   * pushes it out to an hour, so an import only advances when a spec fires the
   * alarm itself (`runDurableObjectAlarm`) — otherwise "cancel a running import"
   * is a race against the fixture finishing. Unset in production.
   */
  private tickDelayMs(): number {
    const configured = Number(this.env.IMPORT_TICK_DELAY_MS || NaN);
    return Number.isFinite(configured) && configured > 0 ? configured : 50;
  }

  // ---- storage helpers ----

  private async job(): Promise<JobRecord | null> {
    return (await this.storage.get<JobRecord>("job")) ?? null;
  }

  /** Random access over the chunked upload, for the zip reader. */
  byteReader(size: number): ByteReader {
    return {
      size,
      read: async (offset: number, length: number): Promise<Uint8Array> => {
        const wanted = Math.max(0, Math.min(length, size - offset));
        const out = new Uint8Array(wanted);
        let written = 0;
        while (written < wanted) {
          const position = offset + written;
          const index = Math.floor(position / CHUNK_BYTES);
          const chunk = await this.storage.get<Uint8Array>(`bytes:${index}`);
          if (!chunk) break;
          const start = position - index * CHUNK_BYTES;
          const piece = chunk.subarray(start, Math.min(chunk.length, start + (wanted - written)));
          if (piece.length === 0) break;
          out.set(piece, written);
          written += piece.length;
        }
        return written === wanted ? out : out.subarray(0, written);
      },
    };
  }

  /** The upload is only needed while the import runs. */
  private async discardUpload(): Promise<void> {
    const keys = [...(await this.storage.list<Uint8Array>({ prefix: "bytes:" })).keys()];
    for (let i = 0; i < keys.length; i += 100) await this.storage.delete(keys.slice(i, i + 100));
    // The size has to go with the bytes: it is what says an upload is still here,
    // so leaving it behind would advertise a resumable import with nothing to read.
    await this.storage.put("size", 0);
    await this.storage.delete("state");
    await this.storage.delete("geocache");
    await this.storage.delete("geoclock");
    await this.storage.delete("direct");
  }

  /** Drops the upload a stopped import was holding in case it was resumed. */
  private async expireUpload(job: JobRecord): Promise<void> {
    if (((await this.storage.get<number>("size")) ?? 0) === 0) return;
    await this.discardUpload();
    // The report stays; only the megabytes go.
    await this.storage.put("job", { ...job, uploadExpiresAt: null } satisfies JobRecord);
  }

  private async fail(job: JobRecord, error: unknown, options: { keepUpload: boolean }): Promise<ImportJobDto> {
    const message = error instanceof Error ? error.message : String(error);
    await this.storage.deleteAlarm();
    if (!options.keepUpload) await this.discardUpload();
    const expiresAt = options.keepUpload ? Date.now() + UPLOAD_TTL_MS : null;
    const failed: JobRecord = {
      ...job,
      phase: "failed",
      error: message,
      finishedAt: Date.now(),
      uploadExpiresAt: expiresAt,
    };
    await this.storage.put("job", failed);
    if (expiresAt !== null) await this.storage.setAlarm(expiresAt);
    return this.toDto(failed, (await this.storage.get<string[]>("warnings")) ?? [], options.keepUpload);
  }

  private toDto(job: JobRecord, warnings: string[], resumable: boolean): ImportJobDto {
    const counters = job.counters;
    return {
      id: job.id,
      label: job.label,
      source: job.source,
      vin: job.vin,
      carId: job.carId,
      phase: job.phase,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: job.phase === "done" ? 1 : (job.fraction ?? progressOf(job)),
      at: job.at,
      firstAt: job.firstAt,
      lastAt: job.lastAt,
      counts: {
        samples: counters?.snapshots ?? 0,
        positions: counters?.positions ?? 0,
        drives: counters?.drives ?? 0,
        drivesDiscarded: counters?.drivesDiscarded ?? 0,
        chargingProcesses: counters?.chargingProcesses ?? 0,
        charges: counters?.charges ?? 0,
        states: counters?.states ?? 0,
      },
      distanceKm: round(counters?.distanceKm ?? 0),
      energyAddedKwh: round(counters?.energyAddedKwh ?? 0),
      replacedRows: job.replacedRows,
      skipped: job.skipped ?? null,
      stage: job.stage ?? null,
      resumable,
      uploadExpiresAt: resumable ? job.uploadExpiresAt : null,
      warnings,
      error: job.error,
    };
  }
}

const EMPTY_BASELINE: ImportBaseline = {
  drives: 0,
  positions: 0,
  chargingProcesses: 0,
  charges: 0,
  states: 0,
  updates: 0,
};

/** What a direct import's progress means for the job record. */
function directFields(progress: DirectProgress): Partial<JobRecord> {
  return {
    at: progress.lastAt,
    firstAt: progress.firstAt,
    lastAt: progress.lastAt,
    fraction: progress.fraction,
    stage: progress.stage,
    skipped: progress.skipped,
    replacedRows: progress.replacedRows,
    counters: {
      snapshots: progress.rows,
      positions: progress.positions,
      drives: progress.drives,
      drivesDiscarded: 0,
      chargingProcesses: progress.chargingProcesses,
      charges: progress.charges,
      states: progress.states,
      distanceKm: progress.distanceKm,
      energyAddedKwh: progress.energyAddedKwh,
      firstAt: progress.firstAt,
      lastAt: progress.lastAt,
    },
  };
}

function progressOf(job: JobRecord): number | null {
  if (job.phase === "done") return 1;
  if (job.firstAt === null || job.lastAt === null || job.at === null) return null;
  const span = job.lastAt - job.firstAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (job.at - job.firstAt) / span));
}

/** A requested window narrows the period the progress bar measures against. */
function clamp(value: number | null, since?: number, until?: number): number | null {
  if (value === null) return null;
  if (since !== undefined && value < since) return since;
  if (until !== undefined && value > until) return until;
  return value;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
