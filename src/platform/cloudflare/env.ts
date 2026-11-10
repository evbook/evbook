import type { AppEnv, DocumentBucket } from "../env";
import type { Actors, BlobStore, SqlDatabase } from "../ports";

/**
 * Maps the Workers bindings onto the app's ports. The mapping is purely
 * structural — D1 satisfies `SqlDatabase`, the assets `Fetcher` satisfies
 * `AssetFetcher`, and a Durable Object stub satisfies its actor handle — so
 * this file is the one place the generated `Env` type meets the app.
 */

// If this line stops compiling, the port has drifted from what the Cloudflare
// binding actually provides. Type-level only — nothing here survives to runtime.
type _SqlPortCheck = D1Database extends SqlDatabase ? true : never;
const _sqlPortCheck: _SqlPortCheck = true;
void _sqlPortCheck;

/**
 * R2 behind the blob port. Thin on purpose: the content type is stored as the
 * object's own HTTP metadata so the bucket reads sensibly in the dashboard,
 * but the app serves downloads from the database row, not from here.
 */
function r2Blobs(bucket: R2Bucket): BlobStore {
  return {
    async put(key, data, contentType) {
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

/**
 * BLOBS is bound only when the deploy found R2 enabled on the account
 * (cloudflare.config.ts), so the generated `Env` — made from wrangler.jsonc,
 * which never binds it — does not know it. Without it, documents live in D1.
 */
function bucketOf(env: Env): DocumentBucket | null {
  const bucket = (env as Env & { BLOBS?: R2Bucket }).BLOBS;
  return bucket ? { kind: "r2", store: r2Blobs(bucket) } : null;
}

function cfActors(env: Env): Actors {
  return {
    auth: () => env.AUTH_DO.getByName("default"),
    vehicle: (carId: number) => env.VEHICLE_DO.getByName(`car:${carId}`),
    importer: () => env.IMPORT_DO.getByName("default"),
  };
}

/**
 * Memoized per binding-object identity: workerd hands the same `env` to every
 * request of an isolate, so each isolate builds one AppEnv, not one per request.
 */
const cache = new WeakMap<Env, AppEnv>();

export function toAppEnv(env: Env): AppEnv {
  let appEnv = cache.get(env);
  if (!appEnv) {
    appEnv = {
      APP_PASSWORD: env.APP_PASSWORD,
      ENCRYPTION_KEY: env.ENCRYPTION_KEY,
      TESLA_API_HOST: env.TESLA_API_HOST,
      TESLA_AUTH_ISSUER: env.TESLA_AUTH_ISSUER,
      DEV_AUTOLOGIN: env.DEV_AUTOLOGIN,
      NOMINATIM_HOST: env.NOMINATIM_HOST,
      ELEVATION_HOST: env.ELEVATION_HOST,
      IMPORT_TICK_DELAY_MS: env.IMPORT_TICK_DELAY_MS,
      DEMO: env.DEMO,
      GITHUB_API_HOST: env.GITHUB_API_HOST,
      UPDATE_CHANNEL: env.UPDATE_CHANNEL,
      DISABLE_UPDATE_CHECK: env.DISABLE_UPDATE_CHECK,
      UPDATE_REPO: env.UPDATE_REPO,
      // A secret, so absent (not "") until it is set (`bun run setup --github-token`).
      UPDATE_GITHUB_TOKEN: env.UPDATE_GITHUB_TOKEN ?? "",
      TELEMETRY_ENDPOINT: env.TELEMETRY_ENDPOINT,
      DB: env.DB,
      actors: cfActors(env),
      assets: env.ASSETS,
      bucket: bucketOf(env),
    };
    cache.set(env, appEnv);
  }
  return appEnv;
}
