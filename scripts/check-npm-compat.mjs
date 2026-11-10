#!/usr/bin/env bun
// Keeps installations with an older deploy workflow able to update.
//
// Every installation's fork carries its own copy of .github/workflows/deploy.yml,
// and the copies made before the move to Bun do, on a runner without Bun:
//
//   npm ci && npm run build:app && npx cf deploy && npm run migrate:remote
//
// (the oldest ones `npx wrangler …` instead of the last two). So the repository
// ships package-lock.json beside bun.lock, and this fails when
//
//   - package-lock.json's root dependencies or version differ from package.json,
//   - a package bun.lock resolves is missing from package-lock.json, or there at
//     another version (npm may list extra *optional* packages — platform
//     fallbacks Bun leaves out — but nothing else), or
//   - a script on that path invokes Bun.
//
// Fix lockfile drift with `bun run lock:npm`. Run by `bun run test`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");

const pkg = JSON.parse(read("package.json"));
const npmLock = JSON.parse(read("package-lock.json"));
// bun.lock is JSON with trailing commas.
const bunLock = JSON.parse(read("bun.lock").replace(/,(\s*[}\]])/g, "$1"));

const problems = [];

const npmRoot = npmLock.packages[""];
if (npmLock.version !== pkg.version || npmRoot.version !== pkg.version) {
  problems.push(`package-lock.json is at ${npmRoot.version}, package.json at ${pkg.version}`);
}
for (const field of ["dependencies", "devDependencies"]) {
  const want = JSON.stringify(pkg[field] ?? {});
  const have = JSON.stringify(npmRoot[field] ?? {});
  if (want !== have) problems.push(`package-lock.json's ${field} differ from package.json's`);
}

/** Every `name@version` in npm's tree, and whether each one is optional there. */
const npmPackages = new Map();
for (const [path, entry] of Object.entries(npmLock.packages)) {
  if (path === "") continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const key = `${name}@${entry.version}`;
  npmPackages.set(key, (npmPackages.get(key) ?? true) && entry.optional === true);
}
const bunPackages = new Set(Object.values(bunLock.packages).map(([spec]) => spec));

const missing = [...bunPackages].filter((spec) => !npmPackages.has(spec));
const extra = [...npmPackages].filter(([spec, optional]) => !optional && !bunPackages.has(spec)).map(([spec]) => spec);
if (missing.length)
  problems.push(
    `in bun.lock but not package-lock.json: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}`,
  );
if (extra.length)
  problems.push(
    `in package-lock.json but not bun.lock: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ", …" : ""}`,
  );

for (const script of ["build:app", "migrate:remote"]) {
  if (/\bbunx?\b/.test(pkg.scripts[script] ?? "")) {
    problems.push(`the "${script}" script invokes Bun; older deploy workflows run it with plain npm`);
  }
}

if (problems.length > 0) {
  console.error("npm compatibility (see scripts/check-npm-compat.mjs):");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  if (missing.length || extra.length || problems.some((p) => p.includes("differ"))) {
    console.error("  Run `bun run lock:npm` to bring package-lock.json in step.");
  }
  process.exit(1);
}

console.log(`npm compatibility OK — package-lock.json agrees with bun.lock (${bunPackages.size} packages).`);
