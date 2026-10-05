/**
 * Counts D1 round trips, so an import running inside a Worker can stop before
 * it runs out of invocation budget.
 *
 * Every D1 call a Worker makes is a subrequest, and there is a hard cap per
 * invocation. A two-year import is tens of thousands of calls, so it has to be
 * spread over many alarms — and to know when to yield, the replay needs to see
 * how many calls it has spent. `batch()` counts as one, which is exactly why the
 * write layer batches.
 */

import type { SqlDatabase, SqlStatement } from "../../platform/ports";

const INNER = Symbol("inner-statement");

export interface CountingDatabase {
  /** Pass this to `Repo` in place of the real binding. */
  db: SqlDatabase;
  /** Round trips made so far. */
  calls(): number;
}

export function countingDatabase(database: SqlDatabase): CountingDatabase {
  let calls = 0;
  const bump = () => {
    calls++;
  };

  const wrapStatement = (statement: SqlStatement): SqlStatement =>
    ({
      [INNER]: statement,
      bind: (...values: unknown[]) => wrapStatement(statement.bind(...values)),
      first: (column?: string) => {
        bump();
        return column === undefined ? statement.first() : statement.first(column);
      },
      run: () => {
        bump();
        return statement.run();
      },
      all: () => {
        bump();
        return statement.all();
      },
      raw: (options?: { columnNames?: boolean }) => {
        bump();
        return statement.raw(options as never);
      },
    }) as unknown as SqlStatement;

  /** Unwrap before handing statements back to the real binding. */
  const unwrap = (statement: SqlStatement): SqlStatement =>
    (statement as unknown as Record<symbol, SqlStatement>)[INNER] ?? statement;

  const db = {
    prepare: (sql: string) => wrapStatement(database.prepare(sql)),
    batch: (statements: SqlStatement[]) => {
      bump(); // one round trip, however many statements it carries
      return database.batch(statements.map(unwrap));
    },
    exec: (sql: string) => {
      bump();
      return database.exec(sql);
    },
  } as unknown as SqlDatabase;

  return { db, calls: () => calls };
}
