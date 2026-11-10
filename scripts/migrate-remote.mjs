#!/usr/bin/env node
// `bun run migrate:remote`: applies pending D1 migrations to the deployed
// database with the Cloudflare CLI. Wrangler took the database by name; cf
// takes its ID, so look the ID up by name first — the config stays free of
// per-account IDs (see cloudflare.config.ts).
//
// Credentials as for any cf command: `cf auth login`, or CLOUDFLARE_API_TOKEN
// (+ CLOUDFLARE_ACCOUNT_ID when the token sees more than one account).
// Wrangler equivalent: bunx wrangler d1 migrations apply evbook --remote
//
// Node and npx, not Bun: a deploy workflow written before the move to Bun runs
// this with plain npm on a runner without Bun (scripts/check-npm-compat.mjs).

import { execFileSync } from "node:child_process";

const DATABASE = "evbook";
const cf = (...args) =>
  execFileSync("npx", ["cf", ...args], {
    encoding: "utf8",
    // EVBOOK_R2: nothing here deploys, so cloudflare.config.ts need not ask
    // the account about R2 when cf evaluates it.
    env: { CF_SEND_TELEMETRY: "false", EVBOOK_R2: "false", ...process.env },
    stdio: ["inherit", "pipe", "inherit"],
  });

const listed = JSON.parse(cf("d1", "list", "--name", DATABASE));
const rows = Array.isArray(listed) ? listed : (listed.result ?? []);
// `--name` is a search, not an exact match: "evbook-staging" would also come back.
const match = rows.filter((d) => d.name === DATABASE);
if (match.length === 0) {
  console.error(`No D1 database named "${DATABASE}" in this account. Deploy first — \`cf deploy\` creates it.`);
  process.exit(1);
}
const id = match[0].uuid ?? match[0].id;

process.stdout.write(cf("d1", "migrations", "apply", id, "--dir", "migrations", ...process.argv.slice(2)));
