#!/usr/bin/env node
// Copies package.json's version into shared/version.ts, so that `npm version`
// bumps both. npm runs this from its `version` lifecycle — after the bump and
// before the commit it makes — and the npm script stages the file, so a release
// commit carries the two together.
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
console.log(`sync-version: APP_VERSION is ${version}`);
