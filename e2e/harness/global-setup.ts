/**
 * Brings up a complete local stack before any test runs:
 *
 *   1. build the SPA and the Node server bundle
 *   2. migrate + seed three fresh SQLite databases from the same moment
 *   3. start the mock Tesla / Nominatim server
 *   4. start the history, live and sign-in servers (see harness/env.ts)
 *   5. connect the mock Tesla account, and start polling on the live server only
 *
 * Everything runs against localhost on the Node runtime; no wrangler, no
 * Cloudflare account, no network.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  APP_URL,
  ARTIFACT_DIR,
  AUTH_URL,
  CREDENTIALS,
  DB_PATHS,
  LIVE_URL,
  MOCK_URL,
  PORTS,
  ROOT,
  RUNTIME_FILE,
  type Manifest,
  type Runtime,
} from "./env";
import { startProcess, stopAll, waitForHttp } from "./processes";

type SeedFn = (o: { dbPath: string; fresh: boolean; now: number; artifactDir: string }) => { manifest: Manifest };

/** The mock generator is plain ESM; import it by URL so the CJS transform keeps out of the way. */
async function loadSeed(): Promise<SeedFn> {
  const url = pathToFileURL(resolve(ROOT, "e2e/mocks/seed.mjs")).href;
  const module = (await import(url)) as { seed: SeedFn };
  return module.seed;
}

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

/**
 * Shared server env; only DEV_AUTOLOGIN and the cron differ between instances.
 * The cron stays off on the history and sign-in servers: unlike `wrangler dev`,
 * where the trigger never fires, the Node runtime's clock is real — it would
 * poll the mock car and repair-geocode the seeded world every minute, and the
 * screenshots exist to show that world exactly as generated.
 */
function serverEnv(port: number, dbPath: string, autoLogin: boolean, cron: boolean): Record<string, string> {
  return {
    PORT: String(port),
    DATABASE_PATH: dbPath,
    ASSETS_DIR: "dist/client",
    MIGRATIONS_DIR: "migrations",
    DISABLE_CRON: cron ? "" : "true",
    APP_PASSWORD: CREDENTIALS.appPassword,
    ENCRYPTION_KEY: CREDENTIALS.encryptionKey,
    DEV_AUTOLOGIN: autoLogin ? "true" : "",
    TESLA_API_HOST: MOCK_URL,
    TESLA_AUTH_ISSUER: `${MOCK_URL}/oauth2/v3`,
    NOMINATIM_HOST: MOCK_URL,
    ELEVATION_HOST: MOCK_URL,
    // The live server's cron is real, and the update check rides on it. Nothing
    // in this suite may touch the network, and GitHub is not mocked.
    DISABLE_UPDATE_CHECK: "true",
  };
}

/** Poll `/summaries` until the vehicle loop has reported a real state. */
async function waitForLiveState(baseUrl: string, logFile: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no summary";
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/v1/summaries`).catch(() => null);
    if (res?.ok) {
      const summaries = (await res.json()) as { state: string; batteryLevel: number | null }[];
      const summary = summaries[0];
      if (summary && summary.state !== "unknown" && summary.batteryLevel != null) return;
      last = summary ? `state=${summary.state} battery=${summary.batteryLevel}` : "empty list";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The mock car never reported live state (${last}). See ${logFile}`);
}

export default async function globalSetup(): Promise<void> {
  // A previous run that died without teardown would hold the ports.
  stopAll();
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  if (process.env.E2E_SKIP_BUILD === "1") {
    log("skipping SPA and server builds (E2E_SKIP_BUILD=1)");
  } else {
    log("building the SPA and the server…");
    execFileSync("bun", ["run", "build:app"], { cwd: ROOT, stdio: "pipe" });
    execFileSync("bun", ["run", "build:server"], { cwd: ROOT, stdio: "pipe" });
  }

  // All three databases are seeded from the same moment, so every server agrees
  // about what "today" means.
  const now = Date.now();
  log("seeding SQLite…");
  const seed = await loadSeed();
  const { manifest } = seed({ dbPath: DB_PATHS.app, fresh: true, now, artifactDir: ARTIFACT_DIR });
  seed({ dbPath: DB_PATHS.live, fresh: true, now, artifactDir: ARTIFACT_DIR });
  seed({ dbPath: DB_PATHS.auth, fresh: true, now, artifactDir: ARTIFACT_DIR });
  const { drives, charges, positions } = manifest.counts;
  log(`seeded ${drives} drives, ${charges} charging sessions, ${positions} positions`);

  const mock = startProcess("mock-api", "bun", [
    "e2e/mocks/server.mjs",
    "--port",
    String(PORTS.mock),
    "--manifest",
    `${ARTIFACT_DIR}/manifest.json`,
  ]);
  await waitForHttp(`${MOCK_URL}/health`, { logFile: mock.logFile });
  log(`mock Tesla + Nominatim on ${MOCK_URL}`);

  const server = ["dist/server/main.js"];
  const app = startProcess("server-app", "bun", server, serverEnv(PORTS.app, DB_PATHS.app, true, false));
  const auth = startProcess("server-auth", "bun", server, serverEnv(PORTS.auth, DB_PATHS.auth, false, false));
  const live = startProcess("server-live", "bun", server, serverEnv(PORTS.live, DB_PATHS.live, true, true));
  await waitForHttp(`${APP_URL}/health_check`, { logFile: app.logFile });
  await waitForHttp(`${AUTH_URL}/health_check`, { logFile: auth.logFile });
  await waitForHttp(`${LIVE_URL}/health_check`, { logFile: live.logFile });
  log(`history server on ${APP_URL}, live server on ${LIVE_URL}, sign-in server on ${AUTH_URL}`);

  // Both auto-login servers start out connected to Tesla; the sign-in story does
  // that step through the UI on the third one.
  for (const [name, url] of [
    ["history", APP_URL],
    ["live", LIVE_URL],
  ] as const) {
    const connected = await fetch(`${url}/api/v1/auth/tesla`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access: CREDENTIALS.teslaAccessToken, refresh: CREDENTIALS.teslaRefreshToken }),
    });
    if (!connected.ok) {
      throw new Error(
        `Could not connect the mock Tesla account on the ${name} server: HTTP ${connected.status} ${await connected.text()}`,
      );
    }
  }

  // Only the live server polls. The history server is left un-started so its
  // seeded data stays exactly as generated — every list and chart screenshot
  // then shows the world from mocks/world.mjs and nothing else.
  await fetch(`${LIVE_URL}/api/v1/cars/1/logging/resume`, { method: "PUT" });
  await waitForLiveState(LIVE_URL, live.logFile);

  const runtime: Runtime = {
    appUrl: APP_URL,
    authUrl: AUTH_URL,
    liveUrl: LIVE_URL,
    mockUrl: MOCK_URL,
    generatedAt: manifest.generatedAt,
    timezone: manifest.timezone,
    manifest,
  };
  writeFileSync(RUNTIME_FILE, `${JSON.stringify(runtime, null, 2)}\n`);
  log("stack ready");
}
