import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { safeEqual, signSession } from "../core/crypto";
import type { AppConfig, AppEnv } from "../platform/env";
import { discoverCars } from "./cars";
import { DEMO_REFUSAL, isDemo } from "./demo";

export const SESSION_COOKIE = "evbook_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local development convenience: treat the request as signed in so `wrangler dev`
 * never shows the password screen. Double-gated on purpose — `DEV_AUTOLOGIN` is
 * empty in wrangler.jsonc and only ever set in .dev.vars (gitignored, never
 * deployed), and the request must also come from a loopback host, so the flag
 * alone cannot open up a deployment.
 */
export function isDevAutoLogin(env: Pick<AppConfig, "DEV_AUTOLOGIN">, req: Request): boolean {
  if (env.DEV_AUTOLOGIN !== "true") return false;
  return LOOPBACK_HOSTS.has(new URL(req.url).hostname);
}

export const authRoutes = new Hono<{ Bindings: AppEnv }>()
  .post("/auth/login", async (c) => {
    if (!c.env.APP_PASSWORD || !c.env.ENCRYPTION_KEY) {
      return c.json({ error: "setup_required", message: "APP_PASSWORD / ENCRYPTION_KEY secrets are not set" }, 503);
    }
    const body = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
    if (!body.password || !(await safeEqual(body.password, c.env.APP_PASSWORD))) {
      return c.json({ error: "invalid_password" }, 401);
    }
    const expiresAt = Date.now() + SESSION_TTL_MS;
    setCookie(c, SESSION_COOKIE, await signSession(c.env.ENCRYPTION_KEY, expiresAt), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ ok: true });
  })

  .delete("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  })

  .post("/auth/tesla", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const body = await c.req
      .json<{ access?: string; refresh?: string }>()
      .catch((): { access?: string; refresh?: string } => ({}));
    if (!body.access || !body.refresh) {
      return c.json({ error: "invalid_request", message: "access and refresh tokens are required" }, 400);
    }
    const result = await c.env.actors.auth().signIn(body.access.trim(), body.refresh.trim());
    if (!result.ok) return c.json({ error: "tesla_sign_in_failed", message: result.error }, 422);
    return c.json({ ok: true, cars: await discoverCars(c.env) });
  })

  .delete("/auth/tesla", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    await c.env.actors.auth().signOut();
    return c.json({ ok: true });
  });
