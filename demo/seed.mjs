#!/usr/bin/env node
/**
 * Seeds a SQLite database with the demo world — two cars, three years of
 * history — for `npm run demo`.
 *
 *   node demo/seed.mjs [--state-dir data/demo] [--fresh] [--sql-only]
 *
 * Runs the real migrations first (wrangler-compatible bookkeeping — see
 * e2e/mocks/db.mjs), so the seed is always applied to the same schema
 * production uses. Skips the work when the directory already holds a seeded
 * database (pass --fresh to rebuild it). Writes the generated SQL and a
 * manifest next to the database for inspection.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset } from "../e2e/mocks/generate.mjs";
import { seedDatabase } from "../e2e/mocks/db.mjs";
import { toSql } from "../e2e/mocks/sql.mjs";
import { WORLD } from "./world.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

export function seedDemo({ stateDir, fresh = false, now = Date.now() }) {
  const directory = resolve(ROOT, stateDir);
  const dbPath = join(directory, "evbook.sqlite");
  const outDir = join(directory, ".artifacts");
  const donePath = join(outDir, "seeded.json");

  if (fresh) rmSync(directory, { recursive: true, force: true });
  if (existsSync(donePath)) return { dbPath, skipped: true };
  mkdirSync(outDir, { recursive: true });

  const dataset = buildDataset({ now, world: WORLD });
  const sql = toSql(dataset);
  writeFileSync(join(outDir, "seed.sql"), sql);
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(dataset.manifest, null, 2)}\n`);

  seedDatabase({ dbPath, sql, migrationsDir: resolve(ROOT, "migrations") });
  writeFileSync(donePath, `${JSON.stringify({ seededAt: now, counts: dataset.manifest.counts }, null, 2)}\n`);

  return { manifest: dataset.manifest, dbPath, skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stateDir = flag("state-dir", "data/demo");
  if (has("sql-only")) {
    process.stdout.write(toSql(buildDataset({ now: Date.now(), world: WORLD })));
  } else {
    const { manifest, dbPath, skipped } = seedDemo({ stateDir, fresh: has("fresh") });
    if (skipped) {
      console.log(`Demo database already seeded at ${dbPath} — pass --fresh to rebuild.`);
    } else {
      const { drives, charges, positions, chargeSamples } = manifest.counts;
      console.log(`Seeded ${dbPath}`);
      console.log(`  ${drives} drives, ${charges} charging sessions, ${positions} positions, ${chargeSamples} charge samples`);
    }
  }
}
