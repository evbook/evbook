import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { encryptString } from "../core/crypto";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import { AuthActor } from "./auth";

const KEY = "test-encryption-key";

/** Just enough of `ActorStorage` for the token actor: a map and an alarm. */
function memoryStorage(): ActorStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: (async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      const entries = typeof keyOrEntries === "string" ? { [keyOrEntries]: value } : keyOrEntries;
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    }) as ActorStorage["put"],
    delete: (async (keyOrKeys: string | string[]) =>
      typeof keyOrKeys === "string"
        ? data.delete(keyOrKeys)
        : keyOrKeys.filter((k) => data.delete(k)).length) as ActorStorage["delete"],
    deleteAll: async () => data.clear(),
    list: async () => new Map(),
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => {
      alarm = t;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}

function actorEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  const statement = { bind: () => statement, run: async () => ({}) };
  return {
    ENCRYPTION_KEY: KEY,
    TESLA_AUTH_ISSUER: "",
    DB: { prepare: () => statement },
    ...overrides,
  } as unknown as AppEnv;
}

function fakeJwt(payload: object): string {
  const b64 = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.sig`;
}

/** Answers every token request with a fresh pair and records where it went. */
function stubTokenEndpoint(): string[] {
  const urls: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 28_800 });
  }) as typeof fetch);
  return urls;
}

afterEach(() => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("AuthActor issuer", () => {
  it("sends the refresh token to Tesla, whatever host the pasted token names", async () => {
    const urls = stubTokenEndpoint();
    const actor = new AuthActor(memoryStorage(), actorEnv());
    const result = await actor.signIn(fakeJwt({ iss: "https://evil.example/oauth2/v3" }), "refresh-1");
    expect(result.ok).toBe(true);
    expect(urls).toEqual(["https://auth.tesla.com/oauth2/v3/token"]);
  });

  it("keeps a China account on Tesla's China issuer", async () => {
    const urls = stubTokenEndpoint();
    const actor = new AuthActor(memoryStorage(), actorEnv());
    await actor.signIn(fakeJwt({ iss: "https://auth.tesla.cn/oauth2/v3" }), "refresh-1");
    expect(urls).toEqual(["https://auth.tesla.cn/oauth2/v3/token"]);
    expect(await actor.getApiHost()).toBe("https://owner-api.vn.cloud.tesla.cn");
  });

  it("stops refreshing at a foreign issuer stored before the restriction", async () => {
    const urls = stubTokenEndpoint();
    const storage = memoryStorage();
    await storage.put("auth", {
      account: "default",
      accessEnc: await encryptString(KEY, "access-1"),
      refreshEnc: await encryptString(KEY, "refresh-1"),
      issuer: "https://evil.example/oauth2/v3",
      expiresAt: 0,
      lastRefreshAt: 0,
    });
    const actor = new AuthActor(storage, actorEnv());
    expect(await actor.forceRefresh()).toBe(true);
    expect(urls).toEqual(["https://auth.tesla.com/oauth2/v3/token"]);
    expect((storage.data.get("auth") as { issuer: string }).issuer).toBe("https://auth.tesla.com/oauth2/v3");
  });

  it("still follows TESLA_AUTH_ISSUER, the deliberate override", async () => {
    const urls = stubTokenEndpoint();
    const actor = new AuthActor(memoryStorage(), actorEnv({ TESLA_AUTH_ISSUER: "http://localhost:9099/oauth2/v3" }));
    await actor.signIn(fakeJwt({ iss: "https://auth.tesla.com/oauth2/v3" }), "refresh-1");
    expect(urls).toEqual(["http://localhost:9099/oauth2/v3/token"]);
  });
});
