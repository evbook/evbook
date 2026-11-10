import type { SqlDatabase } from "../platform/ports";
import { assertNotMidMerge, MERGED_SCHEMA_MARKER_TABLE, mayBeMidMerge } from "./mergedMigrations";
import { MIGRATIONS, type BundledMigration } from "./migrations.generated";

/**
 * Applies pending migrations from the bundled list (migrations.generated.ts)
 * with the same `d1_migrations` bookkeeping — same table, same shape — that
 * `wrangler d1 migrations apply` and the Node runtime's boot migrator keep.
 * All three ways a database gets migrated are therefore interchangeable, and
 * nothing is ever applied twice.
 *
 * This is what lets a Cloudflare deployment update itself: the new worker
 * version applies whatever its bundle carries on its first request, so
 * "deploy" is the whole of an update, with no `migrations apply --remote`
 * step to remember.
 */

// Verbatim wrangler DDL (see src/platform/node/migrate.ts, same constant).
const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Applies pending migrations in order; returns the names it applied. */
export async function applyPending(
  db: SqlDatabase,
  migrations: readonly BundledMigration[] = MIGRATIONS,
): Promise<string[]> {
  await db.prepare(BOOKKEEPING).run();
  const rows = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set(rows.results.map((row) => row.name));
  if (mayBeMidMerge(applied)) {
    const marker = await db
      .prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(MERGED_SCHEMA_MARKER_TABLE)
      .first();
    assertNotMidMerge(applied, marker !== null);
  }

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    try {
      // One batch per migration: the statements and their bookkeeping row land
      // atomically (D1 batches are transactions; the Node adapter wraps in
      // BEGIN…COMMIT), so a failure part-way leaves nothing recorded.
      await db.batch([
        ...migration.statements.map((statement) => db.prepare(statement)),
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name),
      ]);
    } catch (error) {
      // Two isolates can race the same pending migration; the loser's batch
      // fails against what the winner already created. Losing that race is
      // fine — being unmigrated afterwards is not, so look again.
      const winner = await db.prepare("SELECT 1 AS one FROM d1_migrations WHERE name = ?").bind(migration.name).first();
      if (winner) continue;
      throw new Error(`migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    ran.push(migration.name);
  }
  return ran;
}
