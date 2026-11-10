/**
 * Opens a plain SQLite file, brings it to the current schema, and executes a
 * seed — what `wrangler d1 migrations apply` + `wrangler d1 execute` used to
 * do for the harness and the demo, without wrangler.
 *
 * The migration bookkeeping duplicates src/platform/node/migrate.ts (a plain
 * .mjs cannot import the TS module): same `d1_migrations` table, wrangler's
 * own shape, so any of these databases can be exported to D1 — or opened by
 * the Node server, which runs the same runner at boot — without anything
 * being applied twice. Keep the two in sync; migrate.test.ts pins the shape.
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Migrates `dbPath` and executes `sql` against it. */
export function seedDatabase({ dbPath, sql, migrationsDir = "migrations" }) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA foreign_keys = ON");

    sqlite.exec(BOOKKEEPING);
    const applied = new Set(
      sqlite
        .prepare("SELECT name FROM d1_migrations")
        .all()
        .map((row) => row.name),
    );
    for (const name of readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (applied.has(name)) continue;
      sqlite.exec("BEGIN");
      try {
        sqlite.exec(readFileSync(join(migrationsDir, name), "utf8"));
        sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw new Error(`migration ${name} failed: ${error.message}`, { cause: error });
      }
    }

    sqlite.exec(sql);
  } finally {
    sqlite.close();
  }
}
