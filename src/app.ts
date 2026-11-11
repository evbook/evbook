import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { verifySession } from "./core/crypto";
import { authRoutes, isDevAutoLogin, SESSION_COOKIE } from "./api/auth";
import { isDemo } from "./api/demo";
import { carRoutes } from "./api/cars";
import { chargeRoutes } from "./api/charges";
import { documentRoutes } from "./api/documents";
import { driveRoutes } from "./api/drives";
import { geofenceRoutes } from "./api/geofences";
import { importRoutes } from "./api/imports";
import { settingsRoutes } from "./api/settings";
import { statsRoutes } from "./api/stats";
import { telemetryRoutes } from "./api/telemetry";
import { tripRoutes } from "./api/trips";
import { versionRoutes } from "./api/version";
import { checkForUpdate } from "./core/update";
import { collectTelemetryStats, flushTelemetry, recordVersionMilestones, reportError } from "./core/telemetry";
import { BUDGET_PER_SWEEP, repriceStale } from "./db/pricing";
import { closeAbandonedSessions, repairDriveOrigins, repairMissingAddresses, repairMissingPois } from "./db/repair";
import { reconstructHiddenEvents } from "./db/hiddenEvents";
import type { AppEnv } from "./platform/env";
import type { SessionInfo } from "@shared/api-types";

/**
 * The whole application, provider-free: everything it needs arrives on an
 * `AppEnv`. The Cloudflare entrypoint (`src/index.ts`) and the Node one
 * (`src/platform/node/main.ts`) both serve this same app and drive the same
 * `runScheduled` clock.
 */

/** Half the cron's period — see `runScheduled`. */
const CRON_SLACK_MS = 30_000;

export const app = new Hono<{ Bindings: AppEnv }>();

async function isAuthenticated(env: AppEnv, req: Request): Promise<boolean> {
  if (isDemo(env)) return true;
  if (!env.APP_PASSWORD || !env.ENCRYPTION_KEY) return false;
  if (isDevAutoLogin(env, req)) return true;
  const cookie = getCookie({ req: { raw: req } } as never, SESSION_COOKIE);
  return verifySession(env.ENCRYPTION_KEY, cookie);
}

app.get("/health_check", (c) => c.json({ ok: true }));

/** Unauthenticated: tells the SPA which screen to show. */
app.get("/api/v1/session", async (c) => {
  if (isDemo(c.env)) {
    // The demo needs no password and no Tesla account: the shell renders
    // straight away against the fixture history.
    const info: SessionInfo = {
      authenticated: true,
      setupRequired: false,
      tesla: { signedIn: true, expiresAt: null, lastRefreshAt: null, lastError: null },
      demo: true,
    };
    return c.json(info);
  }
  const setupRequired = !c.env.APP_PASSWORD || !c.env.ENCRYPTION_KEY;
  const authenticated = await isAuthenticated(c.env, c.req.raw);
  const info: SessionInfo = {
    authenticated,
    setupRequired,
    tesla: authenticated ? await c.env.actors.auth().status() : null,
  };
  return c.json(info);
});

// Everything else under /api requires a valid session.
app.use("/api/v1/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/api/v1/session" || path === "/api/v1/auth/login") return next();
  if (!(await isAuthenticated(c.env, c.req.raw))) return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.route("/api/v1", authRoutes);
app.route("/api/v1", carRoutes);
app.route("/api/v1", settingsRoutes);
app.route("/api/v1", driveRoutes);
app.route("/api/v1", chargeRoutes);
app.route("/api/v1", geofenceRoutes);
app.route("/api/v1", statsRoutes);
app.route("/api/v1", tripRoutes);
app.route("/api/v1", importRoutes);
app.route("/api/v1", documentRoutes);
app.route("/api/v1", versionRoutes);
app.route("/api/v1", telemetryRoutes);

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

/**
 * A route that threw is a crash worth hearing about — this is the server-side
 * twin of the client's window.onerror reporter, behind the same opt-in level.
 * Best-effort on purpose: the report must never turn one failure into two.
 */
app.onError(async (error, c) => {
  console.error("[app] unhandled error:", error);
  try {
    await reportError(c.env.DB, "server", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: `${c.req.method} ${c.req.path}`,
    });
  } catch {
    // The database being the thing that failed is exactly this case.
  }
  return c.json({ error: "internal_error" }, 500);
});

// Unknown paths fall through to the SPA (the provider's asset layer serves
// index.html at every SPA route).
app.notFound((c) => c.env.assets.fetch(c.req.raw));

/**
 * Cron: the slow clock for the logging actors. A car parked or asleep has no
 * alarm armed — an armed alarm would keep its Durable Object resident, and
 * residency is what they bill — so its next poll is a deadline on the cars
 * row and this is what comes round to honour it. Cars in a fast loop keep a
 * deadline too, one period behind their alarm, so a lost alarm heals here.
 * (On a long-lived Node process the residency concern is moot and the same
 * clock simply runs from a timer — the deadline column costs nothing there.)
 *
 * Reading the deadlines from the database is the point: waking every actor
 * each minute just to ask whether it was due would cost more than the polling
 * does.
 */
export async function runScheduled(env: AppEnv, scheduledTime: number): Promise<void> {
  // Demo mode has no Tesla account: waking a logger would only make it fail
  // against the real API, and the fixture history needs no repair.
  if (isDemo(env)) return;
  const now = Date.now();
  const cars = await env.DB.prepare(
    "SELECT c.id, c.next_due_at, s.enabled FROM cars c JOIN car_settings s ON s.car_id = c.id",
  ).all<{ id: number; next_due_at: number | null; enabled: number }>();
  for (const row of cars.results) {
    const vehicle = env.actors.vehicle(row.id);
    if (row.enabled !== 1) {
      // Only wake a disabled car's actor if it still has a deadline to clear.
      if (row.next_due_at !== null) await vehicle.stop(row.id);
      continue;
    }
    // Half a period of slack. A deadline landing just after this run would
    // otherwise wait for the next one, stretching a 60 s cadence to 120 s.
    if (row.next_due_at === null || row.next_due_at <= now + CRON_SLACK_MS) {
      await vehicle.pollDue(row.id);
    }
  }
  // Geocoding repair is a ten-minute job that happened to share the old
  // ten-minute trigger. The poll clock now runs every minute; this does not.
  if (new Date(scheduledTime).getUTCMinutes() % 10 === 0) {
    // First: a drive closed here is a drive the address pass below can then
    // resolve, and an abandoned one costs every page it appears on until it is.
    await closeAbandonedSessions(env.DB, env.NOMINATIM_HOST);
    await repairMissingAddresses(env.DB, env.NOMINATIM_HOST);
    // After it, not beside it: both talk to Nominatim, and running them
    // concurrently would put two requests a second on a service that asks for
    // one. A place with no address at all is the worse gap, so it goes first.
    await repairMissingPois(env.DB, env.NOMINATIM_HOST);
    // Last, and one-off: reconstructs the missed start of drives recorded
    // before openDrive learned to. Self-terminating via its settings cursor.
    await repairDriveOrigins(env.DB, env.NOMINATIM_HOST);
    // After it, always: a gap before a drive is the origin sweep's to explain
    // first, and this one waits until that sweep is done.
    await reconstructHiddenEvents(env.DB);
    // Costs a tariff change, a moved place or the arrival of tariffs left
    // stale, a batch at a time (db/pricing.ts). After the sweep above, whose
    // reconstructed charges are priced as they are written.
    await repriceStale(env.DB, BUDGET_PER_SWEEP);

    // And, at most once a day — the interval is a stamp in the database, not a
    // clause here — whether there is a newer EVBook to install. It swallows
    // its own network failures, so a GitHub that is down cannot fail the run.
    await checkForUpdate(env.DB, env);

    // Telemetry, only ever from here: notice an install or update, take the
    // daily statistics snapshot (its interval is a stamp too), and export the
    // outbox to the collector. All opt-in, all no-ops at the default 'off' —
    // and none of it is allowed to fail the run that polls the cars.
    try {
      await recordVersionMilestones(env.DB);
      await collectTelemetryStats(env.DB);
      await flushTelemetry(env.DB, env);
    } catch (error) {
      console.warn("[telemetry] cron pass failed:", error);
    }
  }
}
