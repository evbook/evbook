#!/usr/bin/env node
// `npm run setup`: first install (or repair) of a Cloudflare deployment, with
// nothing but the Cloudflare CLI. Builds, then `cf deploy`s with whichever
// secrets the Worker is still missing:
//
//   ENCRYPTION_KEY       generated here, ONLY if the Worker has none. Replacing
//                        it would make the stored Tesla tokens unreadable, so
//                        re-running this script never touches an existing key.
//   APP_PASSWORD         asked for (hidden) if the Worker has none, or always
//                        with --password (to change it).
//   UPDATE_GITHUB_TOKEN  asked for (hidden) only with --github-token
//                        (docs/updating.md).
//
// The values never touch the disk or a command line: `cf deploy
// --secrets-file` is given a temporary file holding only the *names*, and
// takes the values from this process's environment ("process environment
// values override file values"). cf keeps every secret it is not given.
//
// Afterwards, plain `npm run deploy` is all an update needs.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const cfEnv = { ...process.env, CF_SEND_TELEMETRY: process.env.CF_SEND_TELEMETRY ?? "false" };

const config = (await import(resolve(root, "cloudflare.config.ts"))).default;
const worker = (typeof config === "function" ? await config({ mode: undefined, isPreview: false }) : config).worker
  .name;

if (!process.stdin.isTTY) {
  console.error("npm run setup asks for a password, so it needs to run in a terminal.");
  process.exit(1);
}

/** Secret names already set on the Worker; none when the Worker does not exist yet. */
function existingSecrets() {
  const run = spawnSync("npx", ["cf", "workers", "secrets", "list", "--worker", worker], {
    cwd: root,
    encoding: "utf8",
    env: cfEnv,
  });
  if (run.status === 0) {
    const json = run.stdout.slice(run.stdout.indexOf("["));
    return new Set(JSON.parse(json).map((s) => s.name));
  }
  if (/does not exist/i.test(run.stdout + run.stderr)) return new Set();
  process.stderr.write(run.stdout + run.stderr);
  console.error(`\nCould not read the secrets of "${worker}". Is \`npx cf auth login\` done?`);
  process.exit(1);
}

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((done, fail) => {
    const input = process.stdin;
    let value = "";
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          return done(value);
        }
        if (ch === "\u0003") {
          input.setRawMode(false);
          process.stdout.write("\n");
          return fail(new Error("cancelled"));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

async function askNew(label, minLength) {
  for (;;) {
    const first = await askHidden(`${label}: `);
    if (first.length < minLength) {
      console.log(`  At least ${minLength} characters, please.`);
      continue;
    }
    if ((await askHidden(`${label} again: `)) === first) return first;
    console.log("  Those did not match — once more.");
  }
}

const have = existingSecrets();
const secrets = {};

if (!have.has("ENCRYPTION_KEY")) {
  secrets.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  console.log("ENCRYPTION_KEY: generated. It encrypts your Tesla tokens; it stays on the Worker and is never shown.");
} else {
  console.log("ENCRYPTION_KEY: already set — kept.");
}

if (!have.has("APP_PASSWORD") || args.has("--password")) {
  console.log("APP_PASSWORD is what you will log in to EVBook with.");
  secrets.APP_PASSWORD = await askNew("App password", 8);
} else {
  console.log("APP_PASSWORD: already set — kept (--password changes it).");
}

if (args.has("--github-token")) {
  console.log("UPDATE_GITHUB_TOKEN: a fine-grained token with Actions read/write on your deploy repository.");
  secrets.UPDATE_GITHUB_TOKEN = await askHidden("GitHub token: ");
}

console.log("\nBuilding…");
execFileSync("npm", ["run", "generate:migrations"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
execFileSync("npm", ["run", "build:app"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });

const names = Object.keys(secrets);
const dir = mkdtempSync(join(tmpdir(), "evbook-setup-"));
const deployArgs = ["cf", "deploy"];
try {
  if (names.length > 0) {
    // Names only, no values: cf fills each one in from the environment below.
    const file = join(dir, "secrets.env");
    writeFileSync(file, names.map((n) => `${n}=`).join("\n") + "\n", { mode: 0o600 });
    deployArgs.push("--secrets-file", file);
  }
  const run = spawnSync("npx", deployArgs, { cwd: root, stdio: "inherit", env: { ...cfEnv, ...secrets } });
  if (run.status !== 0) process.exit(run.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  names.length > 0
    ? `\nDone: ${names.join(", ")} set on "${worker}". Open the URL above and log in.`
    : `\nDone: "${worker}" deployed; its secrets were already set.`,
);
