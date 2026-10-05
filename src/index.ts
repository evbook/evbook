import { app, runScheduled } from "./app";
import { applyPending } from "./db/migrate";
import type { AppEnv } from "./platform/env";
import { toAppEnv } from "./platform/cloudflare/env";

/**
 * The Cloudflare entrypoint: wrangler's `main`. The application itself lives
 * in `src/app.ts` and knows nothing about Workers; this file's whole job is to
 * export the Durable Object classes the bindings name and to hand the app an
 * `AppEnv` built from the platform's bindings.
 */

export { AuthDO } from "./do/auth";
export { VehicleDO } from "./do/vehicle";
export { ImportDO } from "./do/import";

/**
 * The worker's equivalent of the Node runtime's boot migrations: the first
 * event an isolate handles applies whatever the bundle carries before the app
 * sees the request. Settled long before most requests — a migrated database
 * costs one read here — and a failure is deliberately not cached, so the next
 * request retries instead of the isolate staying broken until eviction.
 */
let migrated: Promise<void> | null = null;

function ensureMigrated(env: AppEnv): Promise<void> {
  migrated ??= applyPending(env.DB).then(
    (applied) => {
      if (applied.length > 0) console.log(`[db] applied ${applied.length} migration(s): ${applied.join(", ")}`);
    },
    (error) => {
      migrated = null;
      throw error;
    },
  );
  return migrated;
}

export default {
  // The handler takes no ExecutionContext on purpose — the app awaits
  // everything it starts, so there is nothing to waitUntil.
  fetch: async (request: Request, env: Env) => {
    const appEnv = toAppEnv(env);
    await ensureMigrated(appEnv);
    return app.fetch(request, appEnv);
  },

  scheduled: async (controller: ScheduledController, env: Env) => {
    const appEnv = toAppEnv(env);
    await ensureMigrated(appEnv);
    return runScheduled(appEnv, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
