import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VersionInfoDto } from "@shared/api-types";
import { APP_VERSION } from "@shared/version";
import { authed, getJson, login } from "../../test/http";

/**
 * The version endpoint. The suite's `GITHUB_API_HOST` is not a URL, so a check
 * fired here fails inside fetch rather than reaching GitHub — which is exactly
 * what the "check now" case asserts the route survives.
 */

beforeEach(() =>
  env.DB.prepare(
    "UPDATE settings SET update_checked_at = NULL, update_latest_tag = NULL, update_latest_sha = NULL, update_latest_at = NULL WHERE id = 1",
  ).run(),
);
afterEach(() =>
  env.DB.prepare(
    "UPDATE settings SET update_checked_at = NULL, update_latest_tag = NULL, update_latest_sha = NULL, update_latest_at = NULL WHERE id = 1",
  ).run(),
);

describe("GET /api/v1/version", () => {
  it("needs a session", async () => {
    // Which build a self-hosted instance runs is not for a signed-out visitor.
    const res = await SELF.fetch("https://x/api/v1/version");
    expect(res.status).toBe(401);
  });

  it("reports the running build and what the last check found", async () => {
    await env.DB.prepare(
      "UPDATE settings SET update_checked_at = 1700000000000, update_latest_tag = 'v9.9.9-stable' WHERE id = 1",
    ).run();
    const cookie = await login();
    const info = await getJson<VersionInfoDto>(cookie, "/api/v1/version");
    expect(info).toMatchObject({
      current: APP_VERSION,
      channel: "stable",
      latest: "9.9.9",
      checkedAt: 1700000000000,
      updateAvailable: true,
      checkDisabled: false,
      // The suite runs the Worker, which is what says so.
      platform: "cloudflare",
    });
  });
});

describe("POST /api/v1/version/check", () => {
  it("answers with the same shape even when GitHub cannot be reached", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/version/check", { method: "POST" });
    expect(res.status).toBe(200);
    const info = (await res.json()) as VersionInfoDto;
    expect(info.current).toBe(APP_VERSION);
    expect(info.latest).toBeNull();
    // The failed attempt is still recorded, so the cron backs off rather than
    // retrying a dead host every ten minutes.
    expect(info.checkedAt).not.toBeNull();
  });

  it("needs a session", async () => {
    const res = await SELF.fetch("https://x/api/v1/version/check", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/version/update", () => {
  it("refuses when no GitHub token is configured", async () => {
    // The suite's bindings carry no UPDATE_GITHUB_TOKEN, which is the default
    // state of a deployment: the Install button must not pretend otherwise.
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/version/update", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_configured");
  });

  it("needs a session", async () => {
    const res = await SELF.fetch("https://x/api/v1/version/update", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/version/update/run", () => {
  it("answers null when installing is not configured, without asking GitHub", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/version/update/run");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
