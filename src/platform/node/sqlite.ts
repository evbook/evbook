import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDatabase } from "../ports";

/**
 * A `SqlDatabase` over `node:sqlite` — the Node runtime's database, and the
 * import CLI's way of driving the real `Repo` and the real state machine
 * against a local SQLite file (the very file `wrangler dev` serves as D1, or a
 * throwaway one whose rows are then dumped as SQL for `wrangler d1 import`).
 *
 * Only the surface the worker code actually uses is implemented (`prepare`,
 * `bind`, `first`, `all`, `run`, `raw`, `batch`, `exec`); the rest of the D1
 * interface is not reachable from an import, so the result is cast at the
 * boundary rather than stubbed out.
 */

type Bindable = string | number | bigint | Uint8Array | null;

interface Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  rows_read: number;
  rows_written: number;
}

/** D1 rejects booleans and undefined; be as forgiving as the real thing is not. */
function coerce(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

class SqliteD1 {
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;

  constructor(readonly db: DatabaseSync) {}

  statement(sql: string): StatementSync {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this, sql, []);
  }

  async batch(statements: SqliteD1Statement[]): Promise<unknown[]> {
    // D1 batches are atomic.
    const savepoint = this.transactionDepth > 0;
    this.transactionDepth++;
    this.db.exec(savepoint ? "SAVEPOINT d1_batch" : "BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec(savepoint ? "RELEASE d1_batch" : "COMMIT");
      return results;
    } catch (error) {
      this.db.exec(savepoint ? "ROLLBACK TO d1_batch" : "ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.db.exec(sql);
    return { count: 0, duration: performance.now() - started };
  }
}

class SqliteD1Statement {
  constructor(
    private readonly owner: SqliteD1,
    private readonly sql: string,
    private readonly params: Bindable[],
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.owner, this.sql, values.map(coerce));
  }

  /** Runs the statement synchronously; `batch` needs this inside its transaction. */
  execute(): { success: true; results: Record<string, unknown>[]; meta: Meta } {
    const started = performance.now();
    const statement = this.owner.statement(this.sql);
    const results = statement.all(...(this.params as never[])) as Record<string, unknown>[];
    // Cached like every other statement: an import runs this hundreds of
    // thousands of times, and preparing it each time is pure overhead.
    const changes = this.owner.statement("SELECT changes() AS n, last_insert_rowid() AS id").get() as {
      n: number;
      id: number;
    };
    return {
      success: true,
      results,
      meta: {
        duration: performance.now() - started,
        changes: Number(changes.n),
        last_row_id: Number(changes.id),
        changed_db: Number(changes.n) > 0,
        rows_read: results.length,
        rows_written: Number(changes.n),
      },
    };
  }

  async first(column?: string): Promise<unknown> {
    const row = this.execute().results[0];
    if (row === undefined) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async all(): Promise<unknown> {
    return this.execute();
  }

  async run(): Promise<unknown> {
    const { success, meta } = this.execute();
    return { success, meta, results: [] };
  }

  async raw(options?: { columnNames?: boolean }): Promise<unknown[]> {
    const { results } = this.execute();
    const columns = results[0] ? Object.keys(results[0]) : [];
    const rows = results.map((row) => columns.map((column) => row[column]));
    return options?.columnNames ? [columns, ...rows] : rows;
  }
}

export interface LocalSqlite {
  db: SqlDatabase;
  sqlite: DatabaseSync;
  close(): void;
}

/**
 * Opens a SQLite file as a `SqlDatabase`. `synchronous = NORMAL` under WAL
 * keeps a half-million-row import to minutes instead of hours without risking
 * the file on anything short of a power cut.
 */
export function openSqlite(path: string): LocalSqlite {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA temp_store = MEMORY");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const wrapper = new SqliteD1(sqlite);
  return {
    db: wrapper as unknown as SqlDatabase,
    sqlite,
    close: () => sqlite.close(),
  };
}
