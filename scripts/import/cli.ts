import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { listSources, runImport } from "../../src/core/import/index";
import { detectSources } from "../../src/core/import/registry";
import type { ImportProgress, ImportReport } from "../../src/core/import/types";
import { openSqlite, type LocalSqlite } from "../../src/platform/node/sqlite";
import { dumpSql } from "./dump";
import { openBundle } from "./fs-bundle";

/**
 * `bun run import` — brings another service's history into EVBook's database.
 *
 * The interesting code is in `src/core/import/`; this file is only the shell:
 * find the export, find the database, print what happened.
 */

/** Carriage return plus "erase to end of line", so the progress line rewrites itself. */
const CLEAR_LINE = "\r\u001b[2K";

const USAGE = `
Usage: bun run import --input <export.zip|teslamate.bck[.gz]|directory> [options]

Where the data comes from
  --input <path>        Vendor export: a zip as downloaded, an unpacked folder, or
                        a TeslaMate pg_dump backup (plain or gzipped)
  --source <id>         Import adapter to use (default: auto-detect)
  --list-sources        Show the adapters this build knows about and exit

Where the data goes
  --persist-to <dir>    Wrangler state directory (default: .wrangler/state)
  --db <file>           A specific SQLite file to write instead
  --sql <file>          Import into a throwaway database and write SQL instead,
                        for: bunx wrangler d1 import evbook --remote --file=<file>

Which car
  --vin <vin>           Override the VIN found in the export
  --car-id <id>         Import into an existing car row
  --name <name>         Name for a car this import creates

What to import
  --since <date>        Skip samples before this UTC date/time
  --until <date>        Skip samples after this UTC date/time
  --min-interval <s>    Thin samples to at most one every <s> seconds (default: 0,
                        keep everything). Transitions are never thinned away.
  --sleep-gap <min>     Data gap that counts as the car going to sleep (default: 15)
  --dry-run             Parse and summarise, write nothing

History the car already has for the imported period is replaced; anything outside
it is kept. Re-running the same export is therefore idempotent, not duplicated.

Addresses
  --geocode             Reverse-geocode drive and charge locations while importing
                        (one Nominatim request per new place, ~1/s)
  --geocoder <url>      Point at a different Nominatim, e.g. a local one
  --geocode-radius <m>  Reuse an address already on record within this many metres
                        (default: 25), instead of looking the point up again

  -q, --quiet           No progress line
  -h, --help            This text
`.trim();

export async function main(argv: string[], repositoryRoot: string): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string" },
      source: { type: "string" },
      "list-sources": { type: "boolean", default: false },
      "persist-to": { type: "string", default: ".wrangler/state" },
      db: { type: "string" },
      sql: { type: "string" },
      vin: { type: "string" },
      "car-id": { type: "string" },
      name: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      "min-interval": { type: "string" },
      "sleep-gap": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      geocode: { type: "boolean", default: false },
      geocoder: { type: "string" },
      "geocode-radius": { type: "string" },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (values["list-sources"]) {
    for (const source of listSources()) {
      console.log(`${source.id.padEnd(10)} ${source.describe}`);
      if (source.howToExport) console.log(`${" ".repeat(11)}${source.howToExport}`);
    }
    return 0;
  }

  if (!values.input) {
    console.error(USAGE);
    return 2;
  }

  const since = parseDate(values.since, "--since");
  const until = parseDate(values.until, "--until");
  const dryRun = values["dry-run"];

  const opened = await openBundle(resolve(values.input));
  let target: Target | null = null;

  try {
    const detected = await detectSources(opened.bundle);
    const best = detected[0];
    console.log(`Export:  ${opened.bundle.label}`);
    if (best) {
      const { source, detection } = best;
      console.log(
        `Source:  ${source.label} (${source.id}), confidence ${Math.round(detection.confidence * 100)}%` +
          `${detection.vin ? `, VIN ${detection.vin}` : ""}`,
      );
      if (detection.recognised.length > 0) console.log(`Files:   ${detection.recognised.join(", ")}`);
      for (const note of detection.notes) console.log(`Note:    ${note}`);
    }

    target = dryRun
      ? null
      : openTarget({ sql: values.sql, db: values.db, persistTo: values["persist-to"] }, repositoryRoot);
    if (target) console.log(`Target:  ${target.label}`);
    console.log("");

    const report = await runImport({
      db: target?.local.db,
      bundle: opened.bundle,
      sourceId: values.source,
      vin: values.vin,
      carId: values["car-id"] === undefined ? undefined : Number(values["car-id"]),
      carName: values.name,
      since,
      until,
      minIntervalS: numberOption(values["min-interval"], "--min-interval"),
      sleepGapMin: numberOption(values["sleep-gap"], "--sleep-gap"),
      dryRun,
      geocode: {
        enabled: values.geocode,
        baseUrl: values.geocoder,
        radiusMeters: numberOption(values["geocode-radius"], "--geocode-radius"),
      },
      onProgress: values.quiet ? undefined : progressPrinter(),
    });

    if (!values.quiet) process.stderr.write(CLEAR_LINE);
    printReport(report);

    if (target?.dump) {
      const dumped = await dumpSql(target.local.sqlite, report.carId, target.dump);
      console.log("");
      console.log(`SQL:     ${dumped.path} — ${formatCount(dumped.rows)} rows, ${formatBytes(dumped.bytes)}`);
      console.log(`         bunx wrangler d1 import evbook --remote --file=${dumped.path}`);
    }

    return 0;
  } finally {
    await opened.close();
    target?.local.close();
    target?.discard?.();
  }
}

interface Target {
  label: string;
  local: LocalSqlite;
  /** Set when the import went into a throwaway database to be dumped. */
  dump: string | null;
  /** Removes the throwaway database, once it has been dumped. */
  discard?: () => void;
}

function openTarget(values: { sql?: string; db?: string; persistTo?: string }, repositoryRoot: string): Target {
  const dump = values.sql;

  if (dump) {
    const directory = mkdtempSync(join(tmpdir(), "evbook-import-"));
    const path = join(directory, "import.sqlite");
    const local = openSqlite(path);
    applyMigrations(local.sqlite, repositoryRoot);
    return {
      label: `${path} (throwaway, dumped to ${resolve(dump)})`,
      local,
      dump: resolve(dump),
      discard: () => rmSync(directory, { recursive: true, force: true }),
    };
  }

  const path = values.db ? resolve(values.db) : findWranglerD1(resolve(values.persistTo ?? ".wrangler/state"));
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist — create it with: bunx wrangler d1 migrations apply evbook --local`);
  }
  const local = openSqlite(path);
  const hasSchema = local.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'positions'")
    .get();
  if (!hasSchema) {
    local.close();
    throw new Error(`${path} has no EVBook schema — run: bunx wrangler d1 migrations apply evbook --local`);
  }
  return { label: path, local, dump: null };
}

/** Miniflare keeps each D1 database as one SQLite file under the state directory. */
function findWranglerD1(stateDirectory: string): string {
  const directory = join(stateDirectory, "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(directory)) {
    throw new Error(
      `no local D1 database under ${stateDirectory} — run: bunx wrangler d1 migrations apply evbook --local`,
    );
  }
  // Each database is one hash-named file; `metadata.sqlite` is Miniflare's own.
  const candidates = readdirSync(directory).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (candidates.length === 0) throw new Error(`no .sqlite file in ${directory}`);
  if (candidates.length > 1) {
    throw new Error(`${directory} holds several databases (${candidates.join(", ")}) — pick one with --db`);
  }
  return join(directory, candidates[0]!);
}

function applyMigrations(sqlite: DatabaseSync, repositoryRoot: string): void {
  const directory = join(repositoryRoot, "migrations");
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(join(directory, name), "utf8"));
  }
}

function progressPrinter(): (progress: ImportProgress) => void {
  const startedAt = Date.now();
  return (progress) => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = Math.round(progress.snapshots / Math.max(elapsed, 0.001));
    process.stderr.write(
      `${CLEAR_LINE}${new Date(progress.at).toISOString().slice(0, 16).replace("T", " ")}  ` +
        `${formatCount(progress.snapshots)} samples  ${formatCount(progress.positions)} positions  ` +
        `${formatCount(progress.drives)} drives  ${formatCount(progress.chargingProcesses)} charges  ` +
        `${formatCount(rate)}/s`,
    );
  };
}

function printReport(report: ImportReport): void {
  const span =
    report.firstAt && report.lastAt
      ? `${new Date(report.firstAt).toISOString().slice(0, 10)} .. ${new Date(report.lastAt).toISOString().slice(0, 10)}`
      : "no samples";

  console.log(report.dryRun ? "Dry run — nothing was written." : `Imported into car ${report.carId}.`);
  console.log(`Period:  ${span}`);
  console.log(`Samples: ${formatCount(report.snapshots)} in ${(report.durationMs / 1000).toFixed(1)}s`);
  if (report.dryRun) {
    console.log(
      `Would find ${formatCount(report.drives)} drives and ${formatCount(report.chargingProcesses)} charging sessions`,
    );
    console.log(`Odometer covers ${report.distanceKm.toFixed(0)} km`);
  } else {
    console.log(
      `Drives:  ${formatCount(report.drives)} (${report.distanceKm.toFixed(0)} km)` +
        (report.drivesDiscarded > 0 ? `, ${report.drivesDiscarded} discarded as too short` : ""),
    );
    console.log(
      `Charges: ${formatCount(report.chargingProcesses)} sessions, ${formatCount(report.charges)} samples, ` +
        `${report.energyAddedKwh.toFixed(1)} kWh added`,
    );
    console.log(`Rows:    ${formatCount(report.positions)} positions, ${formatCount(report.states)} state changes`);
    if (report.skipped) {
      console.log(
        `Skipped: ${formatCount(report.skipped.overlapping)} overlapping what EVBook already logged, ` +
          `${formatCount(report.skipped.unfinished)} never finished`,
      );
    }
    if (report.replacedRows > 0) {
      console.log(`Merged:  replaced ${formatCount(report.replacedRows)} row(s) the car already had for this period`);
    }
    if (report.addressesLookedUp + report.addressesReused > 0) {
      console.log(
        `Places:  ${formatCount(report.addressesLookedUp)} looked up (${report.addressesResolved} resolved), ` +
          `${formatCount(report.addressesReused)} answered from cache`,
      );
    }
  }

  if (report.warnings.length > 0) {
    console.log("");
    console.log("Best-effort notes:");
    for (const warning of report.warnings) console.log(`  - ${warning}`);
  }
}

function parseDate(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag}: cannot read "${value}" as a date`);
  return parsed;
}

function numberOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag}: expected a number, got "${value}"`);
  return parsed;
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
