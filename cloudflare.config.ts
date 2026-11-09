// The Worker's configuration for the Cloudflare CLI (`cf dev`, `cf build`,
// `cf deploy`). It mirrors wrangler.jsonc, which stays for what cf cannot do
// yet (the vitest pool, `wrangler tail`, `wrangler secret put`) and for
// deploying release tags cut before this file existed. The two must agree:
// `npm run test:cf-config` (part of `npm test`) fails when they drift.
// docs/cloudflare-cli.md explains the split.
//
// Like wrangler.jsonc, this file carries no per-account state: no accountId
// and no resource IDs. `cf deploy` resolves the database and the bucket by
// name in whatever account is deploying, and creates them on a first deploy.
import { bindings, defineConfig, exports, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "evbook",
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    observability: { enabled: true },
    assets: {
      notFoundHandling: "single-page-application",
      // Worker-owned paths outside the SPA — wrangler.jsonc `run_worker_first`
      // says why each one is here.
      runWorkerFirst: ["/api/*", "/health_check"],
    },
    // Every minute: the polling clock for parked or sleeping cars
    // (src/index.ts `scheduled`).
    triggers: [triggers.scheduled({ schedule: "* * * * *" })],
    // Replaces wrangler.jsonc's `migrations` history: every class live today,
    // with the storage it was created with. Renames and deletions need a
    // tombstone here — see docs/cloudflare-cli.md before touching this.
    exports: {
      AuthDO: exports.durableObject({ storage: "sqlite" }),
      VehicleDO: exports.durableObject({ storage: "sqlite" }),
      ImportDO: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      // What each of these does is documented in wrangler.jsonc `vars`.
      TESLA_API_HOST: bindings.text(""),
      TESLA_AUTH_ISSUER: bindings.text(""),
      DEV_AUTOLOGIN: bindings.text(""),
      NOMINATIM_HOST: bindings.text(""),
      ELEVATION_HOST: bindings.text(""),
      IMPORT_TICK_DELAY_MS: bindings.text(""),
      GITHUB_API_HOST: bindings.text(""),
      UPDATE_CHANNEL: bindings.text(""),
      DISABLE_UPDATE_CHECK: bindings.text(""),
      // wrangler takes this as `--var UPDATE_REPO:<repo>`; cf has no --var,
      // so the deploy workflow exports it and it is read here instead.
      UPDATE_REPO: bindings.text(process.env.UPDATE_REPO ?? ""),
      TELEMETRY_ENDPOINT: bindings.text(""),
      DEMO: bindings.text(""),

      // Secrets (APP_PASSWORD, ENCRYPTION_KEY, optional UPDATE_GITHUB_TOKEN)
      // are deliberately NOT declared: `bindings.secret()` makes cf refuse to
      // deploy until each is set, while EVBook must deploy without them and
      // show its Setup page instead. cf keeps existing secrets on every deploy.

      DB: bindings.d1({ name: "evbook" }),
      BLOBS: bindings.r2({ name: "evbook-documents" }),
      AUTH_DO: bindings.durableObject({ worker: "evbook", exportName: "AuthDO" }),
      VEHICLE_DO: bindings.durableObject({ worker: "evbook", exportName: "VehicleDO" }),
      IMPORT_DO: bindings.durableObject({ worker: "evbook", exportName: "ImportDO" }),
      ASSETS: bindings.assets(),
    },
  },
});
