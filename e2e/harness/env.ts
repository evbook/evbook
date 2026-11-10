/**
 * One place for every path, port and credential the local suite uses. Nothing
 * here reads the developer's `.dev.vars`: the suite brings its own values so a
 * run means the same thing on every machine.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Playwright transpiles this file to CommonJS, where `import.meta` is not
 * available, so the root comes from the working directory — the package scripts all
 * run from the repository root.
 */
function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "package.json"))) return cwd;
  throw new Error(`Run the e2e suite from the repository root (cwd was ${cwd}).`);
}

export const ROOT = repoRoot();
const E2E_DIR = resolve(ROOT, "e2e");
export const STORIES_DIR = resolve(E2E_DIR, "stories");
export const ARTIFACT_DIR = resolve(E2E_DIR, ".artifacts");
export const RUNTIME_FILE = resolve(ARTIFACT_DIR, "runtime.json");

/**
 * Three Node servers, three databases, so the stories never disturb each other:
 *
 *   app   the seeded history, with polling never started — every list, chart and
 *         screenshot shows exactly the generated world
 *   live  polling switched on, which writes as it goes; the live story owns it
 *   auth  auto-login off and Tesla not connected, for the sign-in story
 *
 * Ports are offset from the dev server's 8787 so `bun run dev` can stay up.
 */
export const PORTS = {
  mock: Number(process.env.E2E_MOCK_PORT ?? 9199),
  app: Number(process.env.E2E_APP_PORT ?? 8788),
  auth: Number(process.env.E2E_AUTH_PORT ?? 8789),
  live: Number(process.env.E2E_LIVE_PORT ?? 8790),
};

export const APP_URL = `http://localhost:${PORTS.app}`;
export const AUTH_URL = `http://localhost:${PORTS.auth}`;
export const LIVE_URL = `http://localhost:${PORTS.live}`;
export const MOCK_URL = `http://localhost:${PORTS.mock}`;

/** One SQLite file per server, side by side in one state directory. */
const STATE_DIR = resolve(E2E_DIR, ".state");
export const DB_PATHS = {
  app: resolve(STATE_DIR, "app.sqlite"),
  auth: resolve(STATE_DIR, "auth.sqlite"),
  live: resolve(STATE_DIR, "live.sqlite"),
};

export const CREDENTIALS = {
  appPassword: "e2e-password",
  encryptionKey: "e2e-encryption-key-0123456789",
  teslaAccessToken: "e2e-access-token",
  teslaRefreshToken: "e2e-refresh-token",
};

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  /** iPhone 16 portrait. */
  mobile: { width: 393, height: 852 },
};

/** What `mocks/generate.mjs` reports about the world it just built. */
export interface Manifest {
  generatedAt: number;
  timezone: string;
  historyStartAt: number;
  car: { name: string; vin: string; model: string; efficiency: number; odometerKm: number; batteryLevel: number };
  live: {
    place: string;
    scenario: string;
    lat: number;
    lon: number;
    batteryLevel: number;
    ratedRangeKm: number;
    softwareVersion: string;
  };
  places: Record<string, { name: string; lat: number; lon: number; fenced: boolean }>;
  counts: {
    drives: number;
    charges: number;
    positions: number;
    chargeSamples: number;
    geofences: number;
    addresses: number;
  };
}

export interface Runtime {
  appUrl: string;
  authUrl: string;
  liveUrl: string;
  mockUrl: string;
  /** When the world was seeded; all of its history is relative to this moment. */
  generatedAt: number;
  timezone: string;
  manifest: Manifest;
}
