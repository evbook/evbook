import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTables } from "../../test/db";
import {
  beginLogin,
  FORGET_AFTER_MS,
  forgetLoginFailures,
  loginFailed,
  loginSucceeded,
  UNKNOWN_CLIENT,
  type LoginAttempt,
} from "./loginThrottle";

const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const ADDRESS = "203.0.113.7";

/** One wrong password from `client` at `now`: the attempt as it began. */
async function wrong(client: string | null, now: number): Promise<LoginAttempt> {
  const attempt = await beginLogin(env.DB, client, now);
  if (attempt.kind === "check") await loginFailed(env.DB, client, now);
  return attempt;
}

/** `count` wrong passwords from `client`, a second apart; returns the last attempt. */
async function fail(client: string | null, count: number, from: number): Promise<LoginAttempt> {
  let last: LoginAttempt = { kind: "check", waitMs: 0, lockedUntil: null };
  for (let i = 0; i < count; i++) last = await wrong(client, from + i * 1000);
  return last;
}

const open = { kind: "check", waitMs: 0, lockedUntil: null };

describe("a known address", () => {
  beforeEach(() => clearTables("login_failures"));

  it("is locked for a minute by its fifth attempt, which is still checked", async () => {
    expect(await fail(ADDRESS, 4, T0)).toEqual(open);
    expect(await wrong(ADDRESS, T0 + 4000)).toEqual({ kind: "check", waitMs: 0, lockedUntil: T0 + 4000 + MINUTE });
    expect(await beginLogin(env.DB, ADDRESS, T0 + 34_000)).toEqual({ kind: "locked", retryAfterMs: 30_000 });
    expect((await beginLogin(env.DB, ADDRESS, T0 + 4000 + MINUTE + 1)).kind).toBe("check");
  });

  it("lets a burst of parallel attempts check five passwords, not one per request", async () => {
    const attempts = await Promise.all(Array.from({ length: 50 }, () => beginLogin(env.DB, ADDRESS, T0)));
    expect(attempts.filter((a) => a.kind === "check")).toHaveLength(5);
    expect(attempts.filter((a) => a.kind === "locked")).toHaveLength(45);
    const row = await env.DB.prepare("SELECT failures FROM login_failures WHERE client = ?").bind(ADDRESS).first();
    expect(row).toEqual({ failures: 5 });
  });

  it("is locked twice as long by every further attempt, up to an hour", async () => {
    let now = T0;
    await fail(ADDRESS, 4, now);
    const locks: number[] = [];
    for (let i = 0; i < 9; i++) {
      now += 10 * 1000;
      const attempt = await wrong(ADDRESS, now);
      if (attempt.kind !== "check" || attempt.lockedUntil === null) throw new Error(`attempt ${i + 5} did not lock`);
      locks.push((attempt.lockedUntil - now) / MINUTE);
      // The next guess comes the moment the lock ends.
      now = attempt.lockedUntil;
    }
    expect(locks).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("keeps the count through a lock longer than the quiet time", async () => {
    // A 32-minute lock (the tenth attempt's) ends; one five minutes later still doubles it.
    await env.DB.prepare("INSERT INTO login_failures (client, failures, last_at, locked_until) VALUES (?, 10, ?, ?)")
      .bind(ADDRESS, T0, T0 + 32 * MINUTE)
      .run();
    const later = T0 + 37 * MINUTE;
    expect(await wrong(ADDRESS, later)).toEqual({ kind: "check", waitMs: 0, lockedUntil: later + 60 * MINUTE });
  });

  it("forgets failures after a quiet quarter hour", async () => {
    await fail(ADDRESS, 4, T0);
    const later = T0 + 3000 + FORGET_AFTER_MS + 1;
    // Counting starts over: four more and a fifth are not a sixth.
    expect(await fail(ADDRESS, 4, later)).toEqual(open);
    expect(await wrong(ADDRESS, later + 4000)).toMatchObject({ lockedUntil: later + 4000 + MINUTE });
  });

  it("is forgotten by a successful sign-in, the lock it started included", async () => {
    await fail(ADDRESS, 4, T0);
    const fifth = await beginLogin(env.DB, ADDRESS, T0 + 4000);
    expect(fifth).toMatchObject({ kind: "check", lockedUntil: T0 + 4000 + MINUTE });
    await loginSucceeded(env.DB, ADDRESS);
    expect(await fail(ADDRESS, 4, T0 + 5000)).toEqual(open);
  });

  it("is counted apart from other addresses and from the unknown ones", async () => {
    await fail(ADDRESS, 5, T0);
    expect(await beginLogin(env.DB, "198.51.100.4", T0 + 5000)).toEqual(open);
    expect(await beginLogin(env.DB, null, T0 + 5000)).toEqual(open);
  });
});

describe("an unknown client", () => {
  beforeEach(() => clearTables("login_failures"));

  it("is never locked, only kept waiting, a second doubling up to eight", async () => {
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      await wrong(null, T0 + i * 1000);
      const attempt = await beginLogin(env.DB, null, T0 + i * 1000 + 500);
      if (attempt.kind !== "check") throw new Error("an unknown client was locked");
      expect(attempt.lockedUntil).toBeNull();
      waits.push(attempt.waitMs / 1000);
    }
    expect(waits).toEqual([0, 0, 0, 0, 1, 2, 4, 8, 8]);
  });

  it("stops waiting after a quiet quarter hour or a successful sign-in", async () => {
    await fail(null, 6, T0);
    expect(await beginLogin(env.DB, null, T0 + 5000 + FORGET_AFTER_MS + 1)).toEqual(open);
    await loginSucceeded(env.DB, null);
    const row = await env.DB.prepare("SELECT 1 FROM login_failures WHERE client = ?").bind(UNKNOWN_CLIENT).first();
    expect(row).toBeNull();
  });
});

describe("forgetLoginFailures", () => {
  beforeEach(() => clearTables("login_failures"));

  it("drops what nobody needs to remember, and keeps a lock still running", async () => {
    await fail("198.51.100.1", 2, T0); // quiet since T0 + 1 s
    await env.DB.prepare("INSERT INTO login_failures (client, failures, last_at, locked_until) VALUES (?, 11, ?, ?)")
      .bind(ADDRESS, T0, T0 + 60 * MINUTE)
      .run();
    await fail(null, 2, T0 + 10 * MINUTE);
    await forgetLoginFailures(env.DB, T0 + 20 * MINUTE);
    const rows = await env.DB.prepare("SELECT client FROM login_failures ORDER BY client").all<{ client: string }>();
    expect(rows.results.map((r) => r.client)).toEqual([UNKNOWN_CLIENT, ADDRESS]);
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

  it("checks no more than five passwords from a burst of parallel requests", async () => {
    const statuses = await Promise.all(Array.from({ length: 30 }, () => signIn("nope", ADDRESS).then((r) => r.status)));
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(26);
    const row = await env.DB.prepare("SELECT failures FROM login_failures WHERE client = ?").bind(ADDRESS).first();
    expect(row).toEqual({ failures: 5 });
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
