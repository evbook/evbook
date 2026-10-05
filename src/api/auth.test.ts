import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@shared/api-types";
import { resetCar } from "../../test/db";
import { authed, login } from "../../test/http";
import { isDevAutoLogin } from "./auth";

/** Session handling and route guarding, through the real Hono app. */

const CAR_ID = 41;

describe("authentication", () => {
  beforeEach(() => resetCar(CAR_ID));

  it("reports session state without credentials", async () => {
    const res = await SELF.fetch("https://x/api/v1/session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionInfo;
    expect(body).toMatchObject({ authenticated: false, setupRequired: false });
  });

  it("rejects a wrong password", async () => {
    const res = await SELF.fetch("https://x/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a request with no password field", async () => {
    const res = await SELF.fetch("https://x/api/v1/auth/login", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("guards every data endpoint", async () => {
    for (const path of ["/api/v1/cars", "/api/v1/settings", "/api/v1/summaries", "/api/v1/cars/1/settings"]) {
      const res = await SELF.fetch(`https://x${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("accepts the session cookie it issued", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/cars");
    expect(res.status).toBe(200);
  });

  it("rejects a forged cookie", async () => {
    const res = await authed(`evbook_session=${Date.now() + 60_000}.forged`, "/api/v1/cars");
    expect(res.status).toBe(401);
  });

  it("serves the health check unauthenticated", async () => {
    const res = await SELF.fetch("https://x/health_check");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s unknown API paths rather than serving the SPA", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/does-not-exist");
    expect(res.status).toBe(404);
  });
});

/**
 * The flag lives in the worker's env, which a running test cannot rewrite, so the
 * gate is exercised directly and the wired-up worker is checked to be flag-free.
 */
describe("dev auto-login", () => {
  const req = (url: string) => new Request(url);

  it("signs in a loopback request when the flag is set", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(isDevAutoLogin({ DEV_AUTOLOGIN: "true" } as Env, req(`http://${host}/api/v1/cars`)), host).toBe(true);
    }
  });

  it("stays inert for a non-loopback host", () => {
    for (const host of ["evbook.example.com", "localhost.evil.com", "127.0.0.1.evil.com", "x"]) {
      expect(isDevAutoLogin({ DEV_AUTOLOGIN: "true" } as Env, req(`https://${host}/api/v1/cars`)), host).toBe(false);
    }
  });

  it('stays inert on localhost unless the flag is exactly "true"', () => {
    for (const value of ["", "1", "yes", "TRUE", undefined as unknown as string]) {
      expect(isDevAutoLogin({ DEV_AUTOLOGIN: value } as Env, req("http://localhost/api/v1/cars")), value).toBe(false);
    }
  });

  it("is off for the rest of the suite, so localhost still needs a session", async () => {
    expect(env.DEV_AUTOLOGIN).toBe("");
    expect((await SELF.fetch("http://localhost/api/v1/cars")).status).toBe(401);
  });
});
