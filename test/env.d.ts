declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    /** The documents bucket, bound by vitest.config.ts (wrangler.jsonc leaves it out). */
    BLOBS: R2Bucket;
    TEST_MIGRATIONS: D1Migration[];
  }
}
