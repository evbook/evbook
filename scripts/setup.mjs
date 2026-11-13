#!/usr/bin/env bun
// `bun run setup`: first install (or repair) of a Cloudflare deployment, with
// nothing but the Cloudflare CLI. Builds, then `cf deploy`s with whichever
// secrets the Worker is still missing:
//
//   ENCRYPTION_KEY       generated here, ONLY if the Worker has none. Replacing
//                        it would make the stored Tesla tokens unreadable, so
//                        re-running this script never touches an existing key.
//   APP_PASSWORD         asked for (hidden) if the Worker has none, or always
//                        with --password (to change it).
//   UPDATE_GITHUB_TOKEN  asked for (hidden) only with --github-token, which
//                        sets up the in-app Install button (docs/updating.md).
//                        It also asks which repository deploys this instance —
//                        your fork — and deploys with UPDATE_REPO set to it, so
//                        the app knows whose workflow to start. The answer is
//                        recorded in this checkout's git config, where
//                        cloudflare.config.ts finds it on every later deploy. The token is
//                        tried against that repository before anything is
//                        deployed, so a wrong one is caught here rather than
//                        the first time Install is pressed.
//
// The values never touch the disk or a command line: `cf deploy
// --secrets-file` is given a temporary file holding only the *names*, and
// takes the values from this process's environment ("process environment
// values override file values"). cf keeps every secret it is not given.
//
// Afterwards, plain `bun run deploy` is all an update needs.

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const cfEnv = { ...process.env, CF_SEND_TELEMETRY: process.env.CF_SEND_TELEMETRY ?? "false" };

const config = (await import(resolve(root, "cloudflare.config.ts"))).default;
const worker = (typeof config === "function" ? await config({ mode: undefined, isPreview: false }) : config).worker
  .name;

if (!process.stdin.isTTY) {
  console.error("bun run setup asks for a password, so it needs to run in a terminal.");
  process.exit(1);
}

/** Secret names already set on the Worker; none when the Worker does not exist yet. */
function existingSecrets() {
  const run = spawnSync("bun", ["x", "cf", "workers", "secrets", "list", "--worker", worker], {
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
  console.error(`\nCould not read the secrets of "${worker}". Is \`bunx cf auth login\` done?`);
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

/** Reads a line from the terminal, echoed: for what is not a secret. */
async function ask(prompt) {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await lines.question(prompt)).trim();
  } finally {
    lines.close();
  }
}

/** Where cloudflare.config.ts looks for the deploy repository when UPDATE_REPO is not in the environment. */
const UPDATE_REPO_KEY = "evbook.updateRepo";

/** The deploy repository this checkout was told about before, or null. */
function rememberedRepo() {
  const run = spawnSync("git", ["config", "--local", "--get", UPDATE_REPO_KEY], { cwd: root, encoding: "utf8" });
  return run.status === 0 ? parseRepo(run.stdout) : null;
}

/** Records it for later deploys from this checkout; false when there is no repository to record it in. */
function rememberRepo(repo) {
  return spawnSync("git", ["config", "--local", UPDATE_REPO_KEY, repo], { cwd: root }).status === 0;
}

/** The workflow the Install button starts (src/core/update.ts dispatches it). */
const DEPLOY_WORKFLOW = "deploy.yml";

/** `owner/name`, also out of a pasted GitHub URL; null for anything else. */
function parseRepo(text) {
  const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * GitHub's token form with everything this needs already filled in, bar the one
 * choice it will not take from a link: which repository the token is good for.
 */
function tokenFormUrl(repo) {
  const query = new URLSearchParams({
    name: "EVBook updates",
    description: `Lets an EVBook instance start the deploy workflow in ${repo}`,
    target_name: repo.split("/")[0],
    actions: "write",
  });
  return `https://github.com/settings/personal-access-tokens/new?${query}`;
}

/**
 * Whether the token can see the deploy workflow in `repo` — null if it can,
 * otherwise what is wrong, in words. Reading the workflow needs the same
 * repository access and the same Actions permission that starting it does (bar
 * read-only instead of read and write, which only a real dispatch would show).
 */
async function tokenProblem(repo, token) {
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "EVBook-setup",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return `GitHub could not be reached to try the token (${error instanceof Error ? error.message : error}).`;
  }
  if (response.ok) return null;
  if (response.status === 401) {
    return "GitHub does not accept that token (401). It is shown only once — generate a new one and paste it whole.";
  }
  return (
    `That token cannot see the deploy workflow in ${repo} (GitHub answered ${response.status}). Check that:\n` +
    `  - its repository access is "Only select repositories" with ${repo} selected;\n` +
    `  - it has the repository permission "Actions: Read and write";\n` +
    `  - ${repo} has .github/workflows/${DEPLOY_WORKFLOW} (a fork of the EVBook repository does).`
  );
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

// The repository whose deploy workflow installs updates. cloudflare.config.ts
// reads it from the environment of the deploy below.
let updateRepo = null;
if (args.has("--github-token")) {
  console.log("\nThe Install button: EVBook starts the deploy workflow in the repository you deploy from.");
  updateRepo = process.env.UPDATE_REPO ? parseRepo(process.env.UPDATE_REPO) : null;
  if (updateRepo) console.log(`Deploy repository: ${updateRepo} (from UPDATE_REPO).`);
  const remembered = updateRepo ? null : rememberedRepo();
  while (!updateRepo) {
    const answer = await ask(
      remembered
        ? `Deploy repository, as owner/name [${remembered}]: `
        : "Deploy repository, as owner/name (your fork of EVBook): ",
    );
    updateRepo = answer === "" && remembered ? remembered : parseRepo(answer);
    if (!updateRepo) console.log("  That is not owner/name — for example, your-name/evbook.");
  }
  console.log(
    `\nUPDATE_GITHUB_TOKEN: a fine-grained token for ${updateRepo} only, with "Actions: Read and write".\n` +
      `Create one here — choose "Only select repositories" and pick ${updateRepo}:\n  ${tokenFormUrl(updateRepo)}`,
  );
  const token = (await askHidden("GitHub token: ")).trim();
  const problem = await tokenProblem(updateRepo, token);
  if (problem) {
    console.error(`\n${problem}\nNothing was deployed or changed.`);
    process.exit(1);
  }
  console.log(`The token can see the deploy workflow in ${updateRepo}.`);
  secrets.UPDATE_GITHUB_TOKEN = token;
}

console.log("\nBuilding…");
execFileSync("bun", ["run", "generate:migrations"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
execFileSync("bun", ["run", "build:app"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });

const names = Object.keys(secrets);
const dir = mkdtempSync(join(tmpdir(), "evbook-setup-"));
const deployArgs = ["x", "cf", "deploy"];
try {
  if (names.length > 0) {
    // Names only, no values: cf fills each one in from the environment below.
    const file = join(dir, "secrets.env");
    writeFileSync(file, names.map((n) => `${n}=`).join("\n") + "\n", { mode: 0o600 });
    deployArgs.push("--secrets-file", file);
  }
  const deployEnv = { ...cfEnv, ...secrets, ...(updateRepo ? { UPDATE_REPO: updateRepo } : {}) };
  const run = spawnSync("bun", deployArgs, { cwd: root, stdio: "inherit", env: deployEnv });
  if (run.status !== 0) process.exit(run.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  names.length > 0
    ? `\nDone: ${names.join(", ")} set on "${worker}". Open the URL above and log in.`
    : `\nDone: "${worker}" deployed; its secrets were already set.`,
);
if (updateRepo) {
  console.log(
    `\nUpdate in Settings now starts the deploy workflow in ${updateRepo}. Run that workflow once to check\n` +
      "its Cloudflare secrets (docs/updating.md).",
  );
  console.log(
    rememberRepo(updateRepo)
      ? `This checkout remembers ${updateRepo} (git config ${UPDATE_REPO_KEY}), so a later \`bun run deploy\` from it keeps the setting.`
      : `This folder is not a git checkout, so it cannot remember that: deploy from it as UPDATE_REPO=${updateRepo} bun run deploy`,
  );
}
