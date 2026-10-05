import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertNotMidMerge, MERGED_SCHEMA_MARKER_TABLE, mayBeMidMerge } from "../../db/mergedMigrations";

/**
 * Applies the SQL files in migrations/ to a local SQLite database, tracking
 * them in the same `d1_migrations` table — same name, same shape — that
 * `wrangler d1 migrations apply` maintains. That is deliberate: a database
 * exported from D1 and restored on a VPS (or the reverse) already carries its
 * bookkeeping, so nothing is ever applied twice.
 */

// Verbatim wrangler DDL, copied from a wrangler-created database file.
const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Applies pending migrations in filename order; returns the ones it applied. */
export function runMigrations(sqlite: DatabaseSync, migrationsDir: string): string[] {
  sqlite.exec(BOOKKEEPING);
  const applied = new Set(
    (sqlite.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((row) => row.name),
  );
  if (mayBeMidMerge(applied)) {
    const marker = sqlite
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MERGED_SCHEMA_MARKER_TABLE);
    assertNotMidMerge(applied, marker !== undefined);
  }
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const ran: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(sql);
      sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    ran.push(name);
  }
  return ran;
}
