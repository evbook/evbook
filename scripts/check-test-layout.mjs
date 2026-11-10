#!/usr/bin/env bun
// Enforces the layout rule from docs/testing.md: every unit/integration spec sits in
// the same directory as the module it covers, named after it, and its name says
// which runner owns it. Run by `bun run test`.
//
//   src/api/drives.ts        -> src/api/drives.test.ts
//   src/core/derive/cost.ts  -> src/core/derive/cost.test.ts
//
// Shared support (fixtures, helpers, setup) lives in `test/` and contains no
// specs; browser stories live in `e2e/` and are Playwright's `*.spec.ts`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SOURCE_ROOTS = ["src", "shared", "app"];
const SKIP = new Set(["node_modules", "dist", ".wrangler", ".git", "e2e"]);

/** Every file under `dir`, as paths relative to the repository root. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    if (SKIP.has(entry)) continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const problems = [];
const specs = [];

for (const dir of SOURCE_ROOTS) {
  for (const file of walk(dir)) {
    if (file.endsWith(".spec.ts") || file.endsWith(".spec.tsx")) {
      problems.push(`${file}: name unit specs \`*.test.ts\` — \`*.spec.ts\` is reserved for the e2e stories`);
      continue;
    }
    if (!/\.test\.tsx?$/.test(file)) continue;
    specs.push(file);

    // `drives.test.ts` and `drives.filters.test.ts` both belong to `drives.ts`.
    const dirName = file.slice(0, file.lastIndexOf("/"));
    const base = file.slice(dirName.length + 1).split(".")[0];
    const siblings = readdirSync(join(root, dirName));
    const covers = [".ts", ".tsx"].map((ext) => base + ext).filter((name) => siblings.includes(name));
    if (covers.length === 0) {
      problems.push(`${file}: no \`${base}.ts\` beside it — put the spec next to the module it covers`);
    }

    // Two runners split the specs by name: `*.workerd.test.ts` runs in the vitest
    // workers pool, every other `*.test.ts` under `bun test`. A spec whose imports
    // disagree with its name would be collected by the wrong one and fail there.
    const source = readFileSync(join(root, file), "utf8");
    const usesWorkerd = /from "(vitest|cloudflare:test)"/.test(source);
    const usesBun = /from "bun:test"/.test(source);
    if (file.includes(".workerd.test.")) {
      if (usesBun)
        problems.push(`${file}: a workerd spec imports bun:test — use vitest, or drop \`.workerd\` from the name`);
    } else if (usesWorkerd) {
      problems.push(
        `${file}: imports vitest or cloudflare:test — rename it \`*.workerd.test.ts\` so the workers pool runs it`,
      );
    } else if (!usesBun) {
      problems.push(`${file}: import test helpers from "bun:test"`);
    }
  }
}

// The support directory must stay spec-free, or specs drift back out of `src/`.
for (const file of walk("test")) {
  if (/\.(test|spec)\.tsx?$/.test(file)) {
    problems.push(`${file}: move this spec next to the module it covers; \`test/\` is shared support only`);
  }
}

if (problems.length > 0) {
  console.error("Test layout (see docs/testing.md):");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

console.log(`Test layout OK — ${specs.length} colocated specs.`);
