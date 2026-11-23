import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTables } from "../../test/db";
import {
  clearLoginFailures,
  FORGET_AFTER_MS,
  loginGate,
  recordLoginFailure,
  UNKNOWN_CLIENT,
  type LoginGate,
} from "./loginThrottle";

const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const ADDRESS = "203.0.113.7";

/** `count` wrong passwords from `client`, a second apart; returns the last answer. */
async function fail(client: string | null, count: number, from: number): Promise<LoginGate> {
  let last: LoginGate = { kind: "open" };
  for (let i = 0; i < count; i++) last = await recordLoginFailure(env.DB, client, from + i * 1000);
  return last;
}

describe("a known address", () => {
  beforeEach(() => clearTables("login_failures"));

  it("is locked for a minute by its fifth failure, and only then", async () => {
    expect(await fail(ADDRESS, 4, T0)).toEqual({ kind: "open" });
    expect(await loginGate(env.DB, ADDRESS, T0 + 4000)).toEqual({ kind: "open" });

    expect(await recordLoginFailure(env.DB, ADDRESS, T0 + 4000)).toEqual({ kind: "locked", retryAfterMs: MINUTE });
    expect(await loginGate(env.DB, ADDRESS, T0 + 34_000)).toEqual({ kind: "locked", retryAfterMs: 30_000 });
    expect(await loginGate(env.DB, ADDRESS, T0 + 4000 + MINUTE + 1)).toEqual({ kind: "open" });
  });

  it("is locked twice as long by every further failure, up to an hour", async () => {
    let now = T0;
    await fail(ADDRESS, 4, now);
    const locks: number[] = [];
    for (let i = 0; i < 9; i++) {
      now += 10 * 1000;
      const gate = await recordLoginFailure(env.DB, ADDRESS, now);
      if (gate.kind !== "locked") throw new Error(`failure ${i + 5} did not lock`);
      locks.push(gate.retryAfterMs / MINUTE);
      // The next guess comes the moment the lock ends.
      now += gate.retryAfterMs;
      expect(await loginGate(env.DB, ADDRESS, now)).toEqual({ kind: "open" });
    }
    expect(locks).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("keeps the count through a lock longer than the quiet time", async () => {
    // A 32-minute lock ends; a failure five minutes later still doubles it.
    await fail(ADDRESS, 10, T0);
    const lockedUntil = T0 + 9000 + 32 * MINUTE;
    expect(await recordLoginFailure(env.DB, ADDRESS, lockedUntil + 5 * MINUTE)).toEqual({
      kind: "locked",
      retryAfterMs: 60 * MINUTE,
    });
  });

  it("forgets failures after a quiet quarter hour", async () => {
    await fail(ADDRESS, 4, T0);
    const later = T0 + 3000 + FORGET_AFTER_MS + 1;
    expect(await loginGate(env.DB, ADDRESS, later)).toEqual({ kind: "open" });
    // Counting starts over: four more are not a fifth.
    expect(await fail(ADDRESS, 4, later)).toEqual({ kind: "open" });
  });

  it("is forgotten by a successful sign-in", async () => {
    await fail(ADDRESS, 5, T0);
    await clearLoginFailures(env.DB, ADDRESS);
    expect(await loginGate(env.DB, ADDRESS, T0 + 5000)).toEqual({ kind: "open" });
    expect(await fail(ADDRESS, 4, T0 + 5000)).toEqual({ kind: "open" });
  });

  it("is counted apart from other addresses and from the unknown ones", async () => {
    await fail(ADDRESS, 5, T0);
    expect(await loginGate(env.DB, "198.51.100.4", T0 + 5000)).toEqual({ kind: "open" });
    expect(await loginGate(env.DB, null, T0 + 5000)).toEqual({ kind: "open" });
  });
});

describe("an unknown client", () => {
  beforeEach(() => clearTables("login_failures"));

  it("is never locked, only kept waiting, a second doubling up to eight", async () => {
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      expect(await recordLoginFailure(env.DB, null, T0 + i * 1000)).toEqual({ kind: "open" });
      const gate = await loginGate(env.DB, null, T0 + i * 1000 + 500);
      expect(gate.kind).not.toBe("locked");
      waits.push(gate.kind === "wait" ? gate.ms / 1000 : 0);
    }
    expect(waits).toEqual([0, 0, 0, 0, 1, 2, 4, 8, 8]);
  });

  it("stops waiting after a quiet quarter hour or a successful sign-in", async () => {
    await fail(null, 6, T0);
    expect(await loginGate(env.DB, null, T0 + 5000 + FORGET_AFTER_MS + 1)).toEqual({ kind: "open" });
    await clearLoginFailures(env.DB, null);
    const row = await env.DB.prepare("SELECT 1 FROM login_failures WHERE client = ?").bind(UNKNOWN_CLIENT).first();
    expect(row).toBeNull();
  });
});

describe("POST /api/v1/auth/login", () => {
  beforeEach(() => clearTables("login_failures"));

  const signIn = (password: string, address?: string) =>
    SELF.fetch("https://x/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...(address && { "cf-connecting-ip": address }) },
      body: JSON.stringify({ password }),
    });

  it("answers 429 from the fifth wrong password, even to the right one, and only to that address", async () => {
    for (let i = 0; i < 4; i++) expect((await signIn("nope", ADDRESS)).status).toBe(401);

    const fifth = await signIn("nope", ADDRESS);
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("retry-after")).toBe("60");
    expect(await fifth.json()).toEqual({ error: "too_many_attempts", retryAfter: 60 });

    const right = await signIn("test-password", ADDRESS);
    expect(right.status).toBe(429);
    expect(right.headers.get("set-cookie")).toBeNull();
    expect(Number(right.headers.get("retry-after"))).toBeGreaterThan(0);

    expect((await signIn("test-password", "198.51.100.4")).status).toBe(200);
  });

  it("forgets an address's failures when it signs in", async () => {
    for (let i = 0; i < 4; i++) await signIn("nope", ADDRESS);
    expect((await signIn("test-password", ADDRESS)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await signIn("nope", ADDRESS)).status).toBe(401);
  });

  it("keeps a client it cannot tell apart waiting, but lets the right password in", async () => {
    await env.DB.prepare("INSERT INTO login_failures (client, failures, last_at) VALUES (?, 5, ?)")
      .bind(UNKNOWN_CLIENT, Date.now())
      .run();
    const started = Date.now();
    const res = await signIn("test-password");
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(await env.DB.prepare("SELECT 1 FROM login_failures").first()).toBeNull();
  });
});
