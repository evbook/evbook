#!/usr/bin/env bun
// Entry point for `bun run import`.
//
// The importer is TypeScript that shares modules with the Worker (`src/core/import`,
// `src/db/repo.ts`, `src/core/fsm.ts`), extensionless imports and all. Bun runs it
// as it is — no bundle step, no build artefact.

import { resolve } from "node:path";
import { main } from "./import/cli.ts";

const root = resolve(import.meta.dirname, "..");

try {
  process.exitCode = await main(process.argv.slice(2), root);
} catch (error) {
  console.error(`\nimport failed: ${error instanceof Error ? error.message : error}`);
  if (process.env.DEBUG) console.error(error);
  process.exitCode = 1;
}
