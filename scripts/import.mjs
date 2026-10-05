#!/usr/bin/env node
// Entry point for `npm run import`.
//
// The importer is TypeScript that shares modules with the Worker (`src/core/import`,
// `src/db/repo.ts`, `src/core/fsm.ts`), and those modules use extensionless
// imports that Node's own type stripping cannot resolve. So bundle first — with
// the esbuild that ships with vite — then run the bundle. No build artefact is
// kept and nothing is added to the repository's dependency graph.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const workDirectory = await mkdtemp(join(tmpdir(), "evbook-importer-"));

try {
  const bundled = await build({
    entryPoints: [join(root, "scripts/import/cli.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // Dependencies are bundled in: the output runs from a temp directory, where
    // node_modules is not resolvable. Node's own built-ins stay external.
    write: false,
    sourcemap: "inline",
    logLevel: "warning",
  });

  const modulePath = join(workDirectory, "import.mjs");
  await writeFile(modulePath, bundled.outputFiles[0].text);
  const { main } = await import(modulePath);
  process.exitCode = await main(process.argv.slice(2), root);
} catch (error) {
  console.error(`\nimport failed: ${error instanceof Error ? error.message : error}`);
  if (process.env.DEBUG) console.error(error);
  process.exitCode = 1;
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
