// The Worker's configuration for the Cloudflare CLI (`cf dev`, `cf build`,
// `cf deploy`). It mirrors wrangler.jsonc, which stays for what cf cannot do
// yet (the vitest pool, `wrangler tail`) and for
// deploying release tags cut before this file existed. The two must agree:
// `bun run test:cf-config` (part of `bun run test`) fails when they drift.
// docs/cloudflare-cli.md explains the split.
//
// Like wrangler.jsonc, this file carries no per-account state: no accountId
// and no resource IDs. `cf deploy` resolves the database and the bucket by
// name in whatever account is deploying, and creates them on a first deploy.
//
// The R2 bucket is optional. Cloudflare will not enable R2 on an account
// without a payment method, so binding it unconditionally would make every
// deploy to such an account fail. Instead, each evaluation asks the account
// (see r2Available below) and binds BLOBS only where R2 is enabled; without
// it, documents live in D1. wrangler.jsonc never binds it.
import { execFileSync } from "node:child_process";
import { bindings, defineConfig, exports, triggers } from "cf/config";

const BUCKET = "evbook-documents";

/**
 * Whether this deploy should bind the documents bucket. EVBOOK_R2=true|false
 * decides outright (`bun run dev` sets true: R2 is simulated locally); left
 * unset, the account is asked with `cf r2 buckets get`:
 *
 *   - the bucket exists            → bind it;
 *   - R2 is on, the bucket is not  → bind it, and `cf deploy` creates it;
 *   - R2 is not enabled on the account → leave it out.
 *
 * Anything else — a token without R2 permission, no network, not logged in —
 * fails the deploy instead of guessing: guessing wrong would cut an install
 * off from the documents it keeps in R2. The answer is put back into
 * EVBOOK_R2, so the rest of this process — and the `cf` run below, which
 * evaluates this file too — reuse it.
 */
function r2Available(): boolean {
  const preset = process.env.EVBOOK_R2;
  if (preset === "true" || preset === "false") return preset === "true";

  let answer: boolean;
  try {
    // npx, not bunx: cf runs on Node, and a deploy workflow written before the
    // move to Bun evaluates this file on a runner without Bun.
    execFileSync("npx", ["cf", "r2", "buckets", "get", BUCKET], {
      env: { ...process.env, EVBOOK_R2: "false", CF_SEND_TELEMETRY: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    answer = true;
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };
    const output = `${String(stdout ?? "")}${String(stderr ?? "")}`;
    if (/\[10006\]|bucket does not exist/i.test(output)) {
      answer = true;
    } else if (/\[10042\]|enable R2/i.test(output)) {
      answer = false;
    } else {
      throw new Error(
        `Could not tell whether R2 is enabled on this account (cf r2 buckets get ${BUCKET}):\n${output.trim()}\n` +
          "Set EVBOOK_R2=true to bind the documents bucket, or EVBOOK_R2=false to keep documents in D1.",
        { cause: error },
      );
    }
  }
  process.env.EVBOOK_R2 = String(answer);
  if (!answer) {
    console.warn(`R2 is not enabled on this account: deploying without the ${BUCKET} bucket (documents stay in D1).`);
  }
  return answer;
}

/** Where a checkout remembers which repository deploys it: `git config evbook.updateRepo`. */
const UPDATE_REPO_KEY = "evbook.updateRepo";

/**
 * The repository whose deploy workflow installs updates for this instance —
 * the value of the UPDATE_REPO var, which every deploy sets afresh.
 *
 *   - UPDATE_REPO in the environment decides outright, empty included. The
 *     deploy workflow exports it as the repository it runs in.
 *   - Otherwise, what this checkout was told (`bun run setup --github-token`
 *     records the fork in the repository's own git config). Without this a
 *     deploy typed at a terminal would reset the var to nothing, and the app
 *     would go back to asking the release repo — which the owner's token is
 *     not for — the next time Update is pressed.
 *   - Otherwise empty: the app dispatches the release repo's own workflow.
 *
 * git config rather than a file: it belongs to the checkout, is never
 * committed, and is shared by every worktree of it.
 */
function updateRepo(): string {
  const fromEnv = process.env.UPDATE_REPO;
  if (fromEnv !== undefined) return fromEnv;
  try {
    const out = execFileSync("git", ["config", "--local", "--get", UPDATE_REPO_KEY], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim();
  } catch {
    // Not set, not a repository, or no git: all of them mean "nothing remembered".
    return "";
  }
}

export default defineConfig(() => ({
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
      VOLVO_API_HOST: bindings.text(""),
      VOLVO_AUTH_ISSUER: bindings.text(""),
      VOLVO_LINK_URL: bindings.text(""),
      DEV_AUTOLOGIN: bindings.text(""),
      NOMINATIM_HOST: bindings.text(""),
      ELEVATION_HOST: bindings.text(""),
      IMPORT_TICK_DELAY_MS: bindings.text(""),
      GITHUB_API_HOST: bindings.text(""),
      UPDATE_CHANNEL: bindings.text(""),
      DISABLE_UPDATE_CHECK: bindings.text(""),
      // wrangler takes this as `--var UPDATE_REPO:<repo>`; cf has no --var,
      // so it is worked out here instead — see updateRepo above.
      UPDATE_REPO: bindings.text(updateRepo()),
      TELEMETRY_ENDPOINT: bindings.text(""),
      DEMO: bindings.text(""),

      // Secrets (APP_PASSWORD, ENCRYPTION_KEY, optional UPDATE_GITHUB_TOKEN)
      // are deliberately NOT declared: `bindings.secret()` makes cf refuse to
      // deploy until each is set, while EVBook must deploy without them and
      // show its Setup page instead. cf keeps existing secrets on every deploy.

      DB: bindings.d1({ name: "evbook" }),
      ...(r2Available() ? { BLOBS: bindings.r2({ name: BUCKET }) } : {}),
      AUTH_DO: bindings.durableObject({ worker: "evbook", exportName: "AuthDO" }),
      VEHICLE_DO: bindings.durableObject({ worker: "evbook", exportName: "VehicleDO" }),
      IMPORT_DO: bindings.durableObject({ worker: "evbook", exportName: "ImportDO" }),
      ASSETS: bindings.assets(),
    },
  },
}));
