import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config";
import { runMigrations } from "./migrate";
import { openSqlite } from "./sqlite";
import { startServer } from "./server";

/**
 * The VPS entrypoint (`bun run dev:node`, the Docker CMD). `--migrate-only`
 * applies pending migrations and exits — for a deploy step that wants the
 * schema settled before the old process is swapped out.
 */

if (process.argv.includes("--migrate-only")) {
  const config = loadConfig();
  mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  const database = openSqlite(config.DATABASE_PATH);
  const applied = runMigrations(database.sqlite, config.MIGRATIONS_DIR);
  database.close();
  console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "nothing to apply");
} else {
  // DISABLE_CRON is for harnesses that need the minute clock quiet (the e2e
  // suite freezes seeded worlds with it); a real deployment never sets it.
  const server = await startServer({ cron: process.env.DISABLE_CRON !== "true" });
  console.log(`evbook listening on :${server.port}`);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} — shutting down`);
    server
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
