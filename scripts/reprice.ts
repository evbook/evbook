#!/usr/bin/env bun
/**
 * Prices every stale charging session in a SQLite file with the real pricing
 * code (src/db/pricing.ts) — what the cron sweep would do over a few runs.
 *
 *   bun scripts/reprice.ts data/demo/evbook.sqlite
 *
 * The demo and e2e seeds call it after writing their world: the generator
 * (plain JS, run by Playwright under Node) leaves fenced sessions unpriced and
 * stale rather than carrying a second copy of the tariff arithmetic.
 */

import { openSqlite } from "../src/platform/node/sqlite";
import { repriceStale } from "../src/db/pricing";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/reprice.ts <database.sqlite>");
  process.exit(2);
}

const { db, close } = openSqlite(path);
try {
  let total = 0;
  for (;;) {
    const { repriced, remaining } = await repriceStale(db, 500);
    total += repriced;
    if (remaining === 0 || repriced === 0) break;
  }
  console.log(`repriced ${total} charging sessions`);
} finally {
  close();
}
