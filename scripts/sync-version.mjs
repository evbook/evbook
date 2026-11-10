#!/usr/bin/env bun
// Copies package.json's version into shared/version.ts and package-lock.json,
// so that `bun pm version` bumps all three. It runs from the `version` lifecycle
// script — after the bump and before the commit `bun pm version` makes — and
// that script stages both files, so a release commit carries all three together.
//
// The literal in shared/version.ts is what the running build reports; it is a
// literal rather than a build-time define because five build and test configs
// would otherwise each need one. `shared/version.test.ts` fails if this script
// was never run.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = join(root, "shared/version.ts");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const source = readFileSync(target, "utf8");
const pattern = /^export const APP_VERSION = ".*";$/m;
if (!pattern.test(source)) {
  console.error(`sync-version: no APP_VERSION declaration found in ${target}`);
  process.exit(1);
}

const updated = source.replace(pattern, `export const APP_VERSION = "${version}";`);
if (updated !== source) writeFileSync(target, updated);

// package-lock.json too: `npm version` used to bump it, `bun pm version` does not,
// and it ships for the deploy workflows that still install with npm.
const lockPath = join(root, "package-lock.json");
const lockText = readFileSync(lockPath, "utf8");
const lock = JSON.parse(lockText);
lock.version = version;
lock.packages[""].version = version;
const lockUpdated = `${JSON.stringify(lock, null, 2)}\n`;
if (lockUpdated !== lockText) writeFileSync(lockPath, lockUpdated);

console.log(`sync-version: APP_VERSION is ${version}`);
