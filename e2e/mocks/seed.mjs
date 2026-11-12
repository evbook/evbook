#!/usr/bin/env bun
/**
 * Seeds a SQLite database with the mock world.
 *
 *   bun e2e/mocks/seed.mjs [--db e2e/.state/app.sqlite] [--fresh] [--sql-only]
 *
 * Runs the real migrations first (wrangler-compatible bookkeeping — see
 * mocks/db.mjs), so the seed is always applied to the same schema production
 * uses. Writes the generated SQL and a manifest to the artifact directory for
 * inspection. `--sql-only` prints the SQL instead, for seeding a D1 by hand.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset } from "./generate.mjs";
import { seedDatabase } from "./db.mjs";
import { toSql } from "./sql.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/**
 * Prices the sessions the generator left stale, with the app's own pricing
 * (scripts/reprice.ts). Bun runs it: this module is also loaded by Playwright
 * under Node, which cannot import the TypeScript.
 *
 * Where there is no Bun — the demo's server reseeds nightly with nothing but
 * Node — the same script as `bun run build:server` bundles it
 * (dist/server/reprice.js) runs under this process's own Node instead. The
 * source is preferred wherever Bun exists, so a checkout never prices with a
 * stale build.
 */
export function repriceSeeded(dbPath) {
  const run = (command, script) => execFileSync(command, [script, dbPath], { cwd: ROOT, stdio: "pipe" });
  try {
    run("bun", resolve(ROOT, "scripts/reprice.ts"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const built = resolve(ROOT, "dist/server/reprice.js");
    if (!existsSync(built)) {
      throw new Error(
        `Pricing the seeded sessions needs Bun, or the bundle at ${built} (bun run build:server) to run under Node.`,
        { cause: error },
      );
    }
    run(process.execPath, built);
  }
}

export function seed({ dbPath, fresh = false, now = Date.now(), artifactDir }) {
  const database = resolve(ROOT, dbPath);
  const outDir = resolve(ROOT, artifactDir ?? join(dirname(database), "..", ".artifacts"));
  if (fresh) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
  mkdirSync(outDir, { recursive: true });

  const dataset = buildDataset({ now });
  const sql = toSql(dataset);
  const sqlPath = join(outDir, "seed.sql");
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(sqlPath, sql);
  writeFileSync(manifestPath, `${JSON.stringify(dataset.manifest, null, 2)}\n`);

  seedDatabase({ dbPath: database, sql, migrationsDir: resolve(ROOT, "migrations") });
  repriceSeeded(database);

  return { manifest: dataset.manifest, sqlPath, manifestPath, dbPath: database };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (has("sql-only")) {
    const dataset = buildDataset({ now: Date.now() });
    process.stdout.write(toSql(dataset));
  } else {
    const { manifest, dbPath } = seed({ dbPath: flag("db", "e2e/.state/app.sqlite"), fresh: has("fresh") });
    const { drives, charges, positions } = manifest.counts;
    console.log(`Seeded ${dbPath}`);
    console.log(`  ${drives} drives, ${charges} charging sessions, ${positions} positions`);
  }
}
