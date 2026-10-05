#!/usr/bin/env node
/** Stops a stack left running by `E2E_KEEP_RUNNING=1`. */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PID_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../.artifacts/pids.json");

if (!existsSync(PID_FILE)) {
  console.log("Nothing to stop.");
  process.exit(0);
}

for (const { name, pid } of JSON.parse(readFileSync(PID_FILE, "utf8"))) {
  try {
    process.kill(-pid, "SIGTERM");
    console.log(`stopped ${name} (pid ${pid})`);
  } catch {
    console.log(`${name} (pid ${pid}) was already gone`);
  }
}
rmSync(PID_FILE, { force: true });
