import { SELF } from "cloudflare:test";
import { expect } from "vitest";

/**
 * Shared plumbing for the specs that drive the real Hono app through
 * `SELF.fetch`. Specs live next to the route module they cover; only helpers
 * that more than one of them needs belong here.
 */

/** Logs in with the suite's `APP_PASSWORD` and returns the session cookie. */
export async function login(): Promise<string> {
  const res = await SELF.fetch("https://x/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!.split(";")[0]!;
}

/** Authenticated request against a path on the worker. */
export function authed(cookie: string, path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://x${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init.headers },
  });
}

/** Authenticated GET that asserts a 200 and parses the body. */
export async function getJson<T>(cookie: string, path: string): Promise<T> {
  const res = await authed(cookie, path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}
