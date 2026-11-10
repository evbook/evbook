import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "@shared/version";
import { CHECK_INTERVAL_MS, checkForUpdate, latestUpdateRun, readVersionInfo, triggerUpdateRun } from "./update";

/**
 * The update check, and the three ways it could misbehave: telling someone to
 * install a version that does not exist, going quiet about one that does, or
 * pestering GitHub for an answer it was already given.
 */

const CONFIG = {
  GITHUB_API_HOST: "https://github.test",
  UPDATE_CHANNEL: "",
  DISABLE_UPDATE_CHECK: "",
  UPDATE_REPO: "",
  UPDATE_GITHUB_TOKEN: "",
};

/** Answers the tag listing with these tag names, and records what was asked. */
function stubTags(tags: string[], init: { ok?: boolean } = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(String(url));
    return Promise.resolve({
      ok: init.ok ?? true,
      status: init.ok === false ? 503 : 200,
      json: () => Promise.resolve(tags.map((name) => ({ name }))),
    } as Response);
  });
  return calls;
}

/** Fetch that would fail an assertion if anything called it. */
function stubNoNetwork(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(String(url));
    return Promise.reject(new Error("offline"));
  });
  return calls;
}

beforeEach(() =>
  env.DB.prepare("UPDATE settings SET update_checked_at = NULL, update_latest_tag = NULL WHERE id = 1").run(),
);
afterEach(() => vi.unstubAllGlobals());

describe("readVersionInfo", () => {
  it("says nothing about a latest version before any check has run", async () => {
    const info = await readVersionInfo(env.DB, CONFIG);
    expect(info).toMatchObject({
      current: APP_VERSION,
      channel: "stable",
      latest: null,
      releaseUrl: null,
      checkedAt: null,
      updateAvailable: false,
      checkDisabled: false,
    });
  });

  it("ignores a tag stored while a different channel was being followed", async () => {
    // Switching channel must re-read, not offer the other channel's build.
    await env.DB.prepare("UPDATE settings SET update_latest_tag = 'v9.9.9-canary' WHERE id = 1").run();
    expect((await readVersionInfo(env.DB, CONFIG)).latest).toBeNull();
    expect((await readVersionInfo(env.DB, { ...CONFIG, UPDATE_CHANNEL: "canary" })).latest).toBe("9.9.9");
  });
});

describe("checkForUpdate", () => {
  it("records the newest tag on the channel and offers it", async () => {
    const calls = stubTags(["v0.0.9-stable", "v9.9.9-stable", "v9.9.9-canary", "some-branch-tag"]);
    const info = await checkForUpdate(env.DB, CONFIG, { now: 1_000 });
    expect(calls[0]).toContain("https://github.test/repos/");
    expect(info.latest).toBe("9.9.9");
    expect(info.updateAvailable).toBe(true);
    expect(info.releaseUrl).toBe("https://github.com/evbook/evbook/releases/tag/v9.9.9-stable");
    expect(info.checkedAt).toBe(1_000);
  });

  it("does not offer the version already running", async () => {
    stubTags([`v${APP_VERSION}-stable`]);
    const info = await checkForUpdate(env.DB, CONFIG, { now: 1_000 });
    expect(info.latest).toBe(APP_VERSION);
    expect(info.updateAvailable).toBe(false);
  });

  it("follows the channel it is configured for", async () => {
    stubTags(["v9.9.9-stable", "v10.0.0-canary"]);
    const info = await checkForUpdate(env.DB, { ...CONFIG, UPDATE_CHANNEL: "canary" }, { now: 1_000 });
    expect(info.latest).toBe("10.0.0");
  });

  it("asks once a day and not once a cron tick", async () => {
    stubTags(["v9.9.9-stable"]);
    await checkForUpdate(env.DB, CONFIG, { now: 1_000 });
    vi.unstubAllGlobals();

    const calls = stubNoNetwork();
    const soon = await checkForUpdate(env.DB, CONFIG, { now: 1_000 + CHECK_INTERVAL_MS - 1 });
    expect(calls).toEqual([]);
    expect(soon.latest).toBe("9.9.9");
    expect(soon.checkedAt).toBe(1_000);
  });

  it("asks again once the answer is a day old", async () => {
    stubTags(["v9.9.9-stable"]);
    await checkForUpdate(env.DB, CONFIG, { now: 1_000 });
    stubTags(["v9.9.9-stable", "v10.0.0-stable"]);
    const info = await checkForUpdate(env.DB, CONFIG, { now: 1_000 + CHECK_INTERVAL_MS });
    expect(info.latest).toBe("10.0.0");
  });

  it("asks straight away when a person pressed the button", async () => {
    stubTags(["v9.9.9-stable"]);
    await checkForUpdate(env.DB, CONFIG, { now: 1_000 });
    stubTags(["v10.0.0-stable"]);
    const info = await checkForUpdate(env.DB, CONFIG, { now: 2_000, force: true });
    expect(info.latest).toBe("10.0.0");
    expect(info.checkedAt).toBe(2_000);
  });

  it("keeps the last known version when the request fails, and still backs off", async () => {
    // Telling someone they are up to date because the network is down is worse
    // than saying nothing, and retrying every ten minutes is worse than both.
    stubTags(["v9.9.9-stable"]);
    await checkForUpdate(env.DB, CONFIG, { now: 1_000 });
    stubNoNetwork();
    const info = await checkForUpdate(env.DB, CONFIG, { now: 1_000 + CHECK_INTERVAL_MS, force: true });
    expect(info.latest).toBe("9.9.9");
    expect(info.updateAvailable).toBe(true);
    expect(info.checkedAt).toBe(1_000 + CHECK_INTERVAL_MS);
  });

  it("survives an error page where the tag listing should be", async () => {
    stubTags([], { ok: false });
    const info = await checkForUpdate(env.DB, CONFIG, { now: 1_000 });
    expect(info.latest).toBeNull();
    expect(info.checkedAt).toBe(1_000);
  });

  it("touches nothing at all when checking is turned off", async () => {
    const calls = stubNoNetwork();
    const info = await checkForUpdate(env.DB, { ...CONFIG, DISABLE_UPDATE_CHECK: "true" }, { now: 1_000, force: true });
    expect(calls).toEqual([]);
    expect(info.checkDisabled).toBe(true);
    expect(info.checkedAt).toBeNull();
  });
});

const INSTALL_CONFIG = { ...CONFIG, UPDATE_GITHUB_TOKEN: "gh-token" };

/** Routes GitHub API paths to canned answers, recording every request made. */
function stubGithub(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const path = String(url).replace("https://github.test", "");
    const route = routes[path];
    if (!route) return Promise.reject(new Error(`unstubbed: ${path}`));
    const status = route.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(route.body ?? {}),
    } as Response);
  });
  return calls;
}

describe("triggerUpdateRun", () => {
  it("dispatches the workflow on the default branch with the tag as input", async () => {
    const calls = stubGithub({
      "/repos/evbook/evbook": { body: { default_branch: "trunk" } },
      "/repos/evbook/evbook/actions/workflows/deploy.yml/dispatches": { status: 204 },
    });
    const result = await triggerUpdateRun(INSTALL_CONFIG, "v9.9.9-stable");
    expect(result).toEqual({ ok: true });

    const dispatch = calls[1]!;
    expect(dispatch.url).toContain("/actions/workflows/deploy.yml/dispatches");
    expect(dispatch.init?.method).toBe("POST");
    expect(JSON.parse(String(dispatch.init?.body))).toEqual({ ref: "trunk", inputs: { tag: "v9.9.9-stable" } });
    const headers = dispatch.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gh-token");
  });

  it("dispatches against the configured fork rather than the release repo", async () => {
    const calls = stubGithub({
      "/repos/someone/evbook": { body: { default_branch: "main" } },
      "/repos/someone/evbook/actions/workflows/deploy.yml/dispatches": { status: 204 },
    });
    const result = await triggerUpdateRun({ ...INSTALL_CONFIG, UPDATE_REPO: "someone/evbook" }, "v9.9.9-stable");
    expect(result).toEqual({ ok: true });
    expect(calls.every((call) => call.url.includes("/repos/someone/evbook"))).toBe(true);
  });

  it("carries GitHub's own words back when the dispatch is refused", async () => {
    stubGithub({
      "/repos/evbook/evbook": { body: { default_branch: "main" } },
      "/repos/evbook/evbook/actions/workflows/deploy.yml/dispatches": {
        status: 422,
        body: { message: "Workflow does not have workflow_dispatch trigger" },
      },
    });
    const result = await triggerUpdateRun(INSTALL_CONFIG, "v9.9.9-stable");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("workflow_dispatch");
  });

  it("points at the configuration when the repository itself cannot be read", async () => {
    stubGithub({ "/repos/evbook/evbook": { status: 404, body: { message: "Not Found" } } });
    const result = await triggerUpdateRun(INSTALL_CONFIG, "v9.9.9-stable");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("UPDATE_REPO");
  });

  it("answers with the failure rather than throwing when GitHub is unreachable", async () => {
    stubNoNetwork();
    const result = await triggerUpdateRun(INSTALL_CONFIG, "v9.9.9-stable");
    expect(result.ok).toBe(false);
  });
});

describe("latestUpdateRun", () => {
  it("reads the newest run of the deploy workflow", async () => {
    stubGithub({
      "/repos/evbook/evbook/actions/workflows/deploy.yml/runs?per_page=1": {
        body: {
          workflow_runs: [
            {
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/evbook/evbook/actions/runs/1",
              run_started_at: "2026-08-15T08:00:00Z",
              created_at: "2026-08-15T07:59:00Z",
            },
          ],
        },
      },
    });
    const run = await latestUpdateRun(INSTALL_CONFIG);
    expect(run).toEqual({
      status: "in_progress",
      conclusion: null,
      url: "https://github.com/evbook/evbook/actions/runs/1",
      startedAt: Date.parse("2026-08-15T08:00:00Z"),
    });
  });

  it("answers null for no runs, an error page, or no network", async () => {
    stubGithub({
      "/repos/evbook/evbook/actions/workflows/deploy.yml/runs?per_page=1": { body: { workflow_runs: [] } },
    });
    expect(await latestUpdateRun(INSTALL_CONFIG)).toBeNull();

    stubGithub({
      "/repos/evbook/evbook/actions/workflows/deploy.yml/runs?per_page=1": { status: 500, body: {} },
    });
    expect(await latestUpdateRun(INSTALL_CONFIG)).toBeNull();

    stubNoNetwork();
    expect(await latestUpdateRun(INSTALL_CONFIG)).toBeNull();
  });
});

describe("checkForUpdate against a private release repo", () => {
  it("sends the install token with the tag listing when one is configured", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ name: "v9.9.9-stable" }]),
      } as Response);
    });
    const info = await checkForUpdate(env.DB, INSTALL_CONFIG, { now: 1_000, force: true });
    expect(info.latest).toBe("9.9.9");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBe("Bearer gh-token");
  });

  it("asks anonymously when no token is configured, exactly as before", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ name: "v9.9.9-stable" }]),
      } as Response);
    });
    await checkForUpdate(env.DB, CONFIG, { now: 1_000, force: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.authorization).toBeUndefined();
  });

  it("falls back to an anonymous ask when the token is refused", async () => {
    // An expired token must not blind an instance watching a public repo.
    const seen: (Record<string, string> | undefined)[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seen.push(headers);
      if (headers.authorization) {
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ name: "v9.9.9-stable" }]),
      } as Response);
    });
    const info = await checkForUpdate(env.DB, INSTALL_CONFIG, { now: 1_000, force: true });
    expect(info.latest).toBe("9.9.9");
    expect(seen).toHaveLength(2);
    expect(seen[1]?.authorization).toBeUndefined();
  });
});
