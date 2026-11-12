import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { VOLVO_ACCOUNT } from "../actors/volvoAuth";
import { VolvoClient } from "../core/volvo/api";
import type { AppEnv } from "../platform/env";
import type { VolvoCredentialsInput } from "@shared/api-types";
import { DEMO_REFUSAL, isDemo } from "./demo";

/**
 * Connecting a Volvo: the application's credentials, the Volvo ID consent
 * (authorization code + PKCE, the verifier kept server-side in the Volvo
 * actor) and the cars the grant can read.
 *
 * The consent is bound three ways: to the signed-in session (both ends of the
 * flow are behind the app's login), to a single-use expiring state held by the
 * actor, and to this browser by a cookie echoing that state — so a link that
 * finishes someone else's consent in your session fails. Where the browser is
 * sent afterwards is fixed here, never read from the request.
 */

const STATE_COOKIE = "evbook_volvo_state";
const CALLBACK_PATH = "/api/v1/auth/volvo/callback";

/**
 * The callback URL to register on the developer portal and to send Volvo,
 * which must match byte for byte. On Workers the request URL is the public one;
 * behind a reverse proxy the forwarded headers say what the browser used.
 */
export function redirectUriOf(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}${CALLBACK_PATH}`;
}

/** Back to the Volvo connect page, which shows the outcome and what to do about it. */
function back(c: Context, outcome: string) {
  return c.redirect(`/connect/volvo?outcome=${encodeURIComponent(outcome)}`, 303);
}

/**
 * Register the cars the grant can read, and start logging them. Run on consent
 * and again on request — after a corrected API key, say — without consenting
 * again. A VIN EVBook already knows (imported, or once a Tesla) becomes a Volvo
 * car read through this account.
 */
export async function enrollVolvoCars(
  env: AppEnv,
): Promise<{ outcome: "connected" | "key_refused" | "no_vehicle" | "not_connected" | "unavailable"; vins: number }> {
  const access = await env.actors.volvo().getAccessContext();
  if (!access) return { outcome: "not_connected", vins: 0 };
  const listed = await new VolvoClient(access.apiHost).listVins({ token: access.token, apiKey: access.apiKey });
  if (!listed.ok) {
    return { outcome: listed.error.kind === "key_refused" ? "key_refused" : "unavailable", vins: 0 };
  }
  if (listed.value.length === 0) return { outcome: "no_vehicle", vins: 0 };

  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO accounts (name, provider, label, created_at) VALUES (?, 'volvo', 'Volvo ID', ?) ON CONFLICT(name) DO NOTHING",
  )
    .bind(VOLVO_ACCOUNT, now)
    .run();
  for (const vin of listed.value) {
    await env.DB.prepare(
      "INSERT INTO cars (vin, provider, account, inserted_at, updated_at) VALUES (?, 'volvo', ?, ?, ?) " +
        "ON CONFLICT(vin) DO UPDATE SET provider = 'volvo', account = excluded.account, updated_at = excluded.updated_at",
    )
      .bind(vin, VOLVO_ACCOUNT, now, now)
      .run();
    await env.DB.prepare("INSERT OR IGNORE INTO car_settings (car_id) SELECT id FROM cars WHERE vin = ?")
      .bind(vin)
      .run();
  }
  const cars = await env.DB.prepare(
    "SELECT c.id FROM cars c JOIN car_settings s ON s.car_id = c.id WHERE c.provider = 'volvo' AND s.enabled = 1",
  ).all<{ id: number }>();
  // The owner just acted — consented, or asked Volvo for the cars again — so
  // whatever stopped a car before (an unknown VIN, a refused key) is worth
  // asking about again now rather than in hours.
  for (const row of cars.results) await env.actors.vehicle(row.id).restartVolvo(row.id);
  return { outcome: "connected", vins: listed.value.length };
}

export const volvoRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/volvo", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    return c.json({ ...(await c.env.actors.volvo().status()), redirectUri: redirectUriOf(c.req.raw) });
  })

  .put("/volvo/credentials", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const body = await c.req.json<VolvoCredentialsInput>().catch((): VolvoCredentialsInput => ({}));
    const result = await c.env.actors.volvo().setCredentials(body);
    if (!result.ok) return c.json({ error: "invalid_credentials", message: result.error }, 422);
    return c.json(await c.env.actors.volvo().status());
  })

  .delete("/volvo/credentials", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    await c.env.actors.volvo().clearCredentials();
    await c.env.DB.prepare("DELETE FROM accounts WHERE name = ?").bind(VOLVO_ACCOUNT).run();
    return c.body(null, 204);
  })

  /** Revoke the grant; the credentials stay so reconnecting is one click. */
  .delete("/volvo/connection", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    await c.env.actors.volvo().disconnect();
    return c.body(null, 204);
  })

  /** List the grant's cars again, e.g. after fixing the API key. */
  .post("/volvo/vehicles", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const result = await enrollVolvoCars(c.env);
    return c.json(result, result.outcome === "connected" ? 200 : 409);
  })

  .get("/auth/volvo/start", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const begun = await c.env.actors.volvo().beginAuthorization(redirectUriOf(c.req.raw));
    if (!begun.ok) return back(c, "not_configured");
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    // Lax, not Strict: the browser comes back by a top-level redirect from Volvo ID.
    setCookie(c, STATE_COOKIE, begun.state, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/api/v1/auth/volvo",
      maxAge: 600,
    });
    return c.redirect(begun.url, 302);
  })

  .get("/auth/volvo/callback", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/v1/auth/volvo" });

    if (c.req.query("error")) return back(c, c.req.query("error") === "access_denied" ? "denied" : "failed");
    if (!state || !code || cookie !== state) return back(c, "state_mismatch");

    const completed = await c.env.actors.volvo().completeAuthorization(state, code);
    if (!completed.ok) return back(c, "failed");
    // The grant is stored whatever the listing says: a key fixed later lists
    // the cars without asking the owner to consent again.
    const { outcome } = await enrollVolvoCars(c.env);
    return back(c, outcome);
  });
