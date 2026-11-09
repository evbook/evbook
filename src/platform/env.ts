import type { DocumentBucketKind } from "@shared/api-types";
import type { Actors, BlobStore, SqlDatabase } from "./ports";

/**
 * The provider-neutral shape the app runs against. Each entrypoint —
 * `src/index.ts` on Cloudflare, `src/platform/node/main.ts` on a VPS — builds
 * one of these and hands it to the Hono app and the cron body.
 */

/**
 * The string configuration, names unchanged from the wrangler vars so the
 * modules reading them (`isDemo`, `isDevAutoLogin`, the Tesla and geocoder
 * clients) work against either provider. All of them default to "" — the app
 * treats an empty value as "not configured" everywhere, including the two
 * secrets, which is what drives the first-run setup screen.
 */
export interface AppConfig {
  APP_PASSWORD: string;
  ENCRYPTION_KEY: string;
  TESLA_API_HOST: string;
  TESLA_AUTH_ISSUER: string;
  DEV_AUTOLOGIN: string;
  NOMINATIM_HOST: string;
  ELEVATION_HOST: string;
  IMPORT_TICK_DELAY_MS: string;
  DEMO: string;
  /** Override the tag listing the update check reads; empty = the real GitHub. */
  GITHUB_API_HOST: string;
  /** Which release channel to follow; empty = "stable". */
  UPDATE_CHANNEL: string;
  /** "true" and the instance never asks GitHub anything. */
  DISABLE_UPDATE_CHECK: string;
  /** The repository whose deploy workflow installs updates; empty = the release repo. */
  UPDATE_REPO: string;
  /** A GitHub token allowed to dispatch that workflow; empty = no Install button. */
  UPDATE_GITHUB_TOKEN: string;
  /** Override the OTLP collector telemetry is exported to; empty = the project default. */
  TELEMETRY_ENDPOINT: string;
}

/** Serves the built SPA; the Workers `Fetcher` binding satisfies this shape. */
export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface AppEnv extends AppConfig {
  DB: SqlDatabase;
  actors: Actors;
  assets: AssetFetcher;
  /**
   * The optional home for uploaded documents besides the database
   * (src/api/documents.ts): the R2 bucket on Cloudflare — null when the deploy
   * found R2 not enabled on the account (cloudflare.config.ts) — and a
   * directory of files on Node, which is always there.
   */
  bucket: DocumentBucket | null;
}

export interface DocumentBucket {
  kind: DocumentBucketKind;
  store: BlobStore;
}
