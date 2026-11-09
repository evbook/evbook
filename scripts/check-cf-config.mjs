#!/usr/bin/env node
// Fails when cloudflare.config.ts (read by the `cf` CLI) and wrangler.jsonc
// (read by wrangler, the vitest pool, and older forks' deploy workflows) no
// longer describe the same Worker. Run by `npm test`; see docs/cloudflare-cli.md.
//
// Compares what both files can express: identity, compatibility, assets
// routing, the cron, every var and its default, the D1/R2/DO bindings, and
// the Durable Object classes (both `exports` maps). Secrets live in neither file's values, so they are not compared.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
if (parsed.error) throw new Error(`wrangler.jsonc: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
const w = parsed.config;

// UPDATE_REPO is read from the environment at deploy time; compare the default.
delete process.env.UPDATE_REPO;
// The R2 binding depends on the deploying account; wrangler.jsonc has none,
// so compare the config as it is for an account without R2 — and without
// asking any account.
process.env.EVBOOK_R2 = "false";
const mod = await import(resolve(root, "cloudflare.config.ts"));
let cf = mod.default;
if (typeof cf === "function") cf = await cf({ mode: undefined, isPreview: false });
const worker = cf.worker;
const env = worker.env ?? {};
const byType = (type) => Object.entries(env).filter(([, b]) => b.type === type);

/** Live Durable Object classes from wrangler's `exports` map, or by replaying a `migrations` history. */
function liveClasses(exportsMap, migrations = []) {
  if (exportsMap) {
    return Object.fromEntries(
      Object.entries(exportsMap)
        .filter(([, e]) => e.type === "durable-object" && (!e.state || e.state === "created"))
        .map(([k, e]) => [k, e.storage])
        .sort(),
    );
  }
  const live = new Map();
  for (const m of migrations) {
    for (const c of m.new_sqlite_classes ?? []) live.set(c, "sqlite");
    for (const c of m.new_classes ?? []) live.set(c, "legacy-kv");
    for (const { from, to } of m.renamed_classes ?? []) {
      live.set(to, live.get(from));
      live.delete(from);
    }
    for (const c of m.deleted_classes ?? []) live.delete(c);
  }
  return Object.fromEntries([...live].sort());
}

const checks = {
  name: [w.name, worker.name],
  entrypoint: [w.main, worker.entrypoint],
  compatibilityDate: [w.compatibility_date, worker.compatibilityDate],
  compatibilityFlags: [w.compatibility_flags ?? [], worker.compatibilityFlags ?? []],
  observability: [w.observability ?? {}, worker.observability ?? {}],
  notFoundHandling: [w.assets?.not_found_handling, worker.assets?.notFoundHandling],
  runWorkerFirst: [w.assets?.run_worker_first, worker.assets?.runWorkerFirst],
  assetsBinding: [w.assets?.binding, byType("assets").map(([k]) => k)[0]],
  crons: [
    w.triggers?.crons ?? [],
    (worker.triggers ?? []).filter((t) => t.type === "scheduled").map((t) => t.schedule),
  ],
  customDomains: [
    (w.routes ?? []).filter((r) => typeof r === "object" && r.custom_domain).map((r) => r.pattern),
    worker.domains ?? [],
  ],
  vars: [w.vars ?? {}, Object.fromEntries(byType("text").map(([k, b]) => [k, b.value]))],
  d1: [
    (w.d1_databases ?? []).map((d) => [d.binding, d.database_name]),
    byType("d1").map(([k, b]) => [k, b.name]),
  ],
  r2: [(w.r2_buckets ?? []).map((r) => [r.binding, r.bucket_name]), byType("r2").map(([k, b]) => [k, b.name])],
  durableObjectBindings: [
    (w.durable_objects?.bindings ?? []).map((d) => [d.name, d.class_name, d.script_name ?? w.name]),
    byType("durable-object").map(([k, b]) => [k, b.exportName, b.worker]),
  ],
  durableObjectClasses: [
    liveClasses(w.exports, w.migrations),
    Object.fromEntries(
      Object.entries(worker.exports ?? {})
        .filter(([, e]) => e.type === "durable-object" && !e.state)
        .map(([k, e]) => [k, e.storage])
        .sort(),
    ),
  ],
};

const problems = Object.entries(checks)
  .filter(([, [a, b]]) => !isDeepStrictEqual(a, b))
  .map(([k, [a, b]]) => `  ${k}:\n    wrangler.jsonc       ${JSON.stringify(a)}\n    cloudflare.config.ts ${JSON.stringify(b)}`);

if (problems.length) {
  console.error(`cloudflare.config.ts and wrangler.jsonc disagree:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`cloudflare.config.ts matches wrangler.jsonc (${Object.keys(checks).length} checks)`);
