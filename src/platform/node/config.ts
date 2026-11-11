import type { AppConfig } from "../env";

/**
 * Configuration on Node is plain `process.env` — populate it however the host
 * does (systemd Environment=, docker-compose env_file, or `node
 * --env-file-if-exists=.env`). Every app var defaults to "", matching the
 * wrangler vars: the app reads empty as "not configured", and missing secrets
 * put it in the first-run setup flow rather than refusing to boot.
 */

export interface NodeConfig extends AppConfig {
  /** HTTP port. */
  PORT: number;
  /** The SQLite file; its directory is created if missing. */
  DATABASE_PATH: string;
  /** The Vite build to serve. */
  ASSETS_DIR: string;
  /** Where uploaded documents live, one file per blob key. */
  BLOBS_DIR: string;
  /** migrations/ directory. */
  MIGRATIONS_DIR: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): NodeConfig {
  return {
    APP_PASSWORD: env.APP_PASSWORD ?? "",
    ENCRYPTION_KEY: env.ENCRYPTION_KEY ?? "",
    TESLA_API_HOST: env.TESLA_API_HOST ?? "",
    TESLA_AUTH_ISSUER: env.TESLA_AUTH_ISSUER ?? "",
    VOLVO_API_HOST: env.VOLVO_API_HOST ?? "",
    VOLVO_AUTH_ISSUER: env.VOLVO_AUTH_ISSUER ?? "",
    DEV_AUTOLOGIN: env.DEV_AUTOLOGIN ?? "",
    NOMINATIM_HOST: env.NOMINATIM_HOST ?? "",
    ELEVATION_HOST: env.ELEVATION_HOST ?? "",
    IMPORT_TICK_DELAY_MS: env.IMPORT_TICK_DELAY_MS ?? "",
    DEMO: env.DEMO ?? "",
    GITHUB_API_HOST: env.GITHUB_API_HOST ?? "",
    UPDATE_CHANNEL: env.UPDATE_CHANNEL ?? "",
    DISABLE_UPDATE_CHECK: env.DISABLE_UPDATE_CHECK ?? "",
    UPDATE_REPO: env.UPDATE_REPO ?? "",
    UPDATE_GITHUB_TOKEN: env.UPDATE_GITHUB_TOKEN ?? "",
    TELEMETRY_ENDPOINT: env.TELEMETRY_ENDPOINT ?? "",
    PORT: portOf(env.PORT),
    DATABASE_PATH: env.DATABASE_PATH ?? "./data/evbook.sqlite",
    ASSETS_DIR: env.ASSETS_DIR ?? "./dist/client",
    BLOBS_DIR: env.BLOBS_DIR ?? "./data/blobs",
    MIGRATIONS_DIR: env.MIGRATIONS_DIR ?? "./migrations",
  };
}

function portOf(raw: string | undefined): number {
  const parsed = Number(raw ?? NaN);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000;
}
