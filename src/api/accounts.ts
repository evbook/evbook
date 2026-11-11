import { Hono } from "hono";
import { VOLVO_ACCOUNT } from "../actors/volvoAuth";
import { randomToken } from "../core/volvo/oauth";
import type { AppEnv } from "../platform/env";
import type { AccountDto, TeslaAccountInput } from "@shared/api-types";
import { discoverCars, listCars } from "./cars";
import { DEMO_REFUSAL, isDemo } from "./demo";

/**
 * Every vehicle account the instance reads through: the Tesla account EVBook
 * always had ("default", connected from the first-run screen), any further
 * Tesla accounts, and the Volvo ID. Each Tesla account is its own auth actor,
 * named after the account, holding its own encrypted tokens and refresh clock.
 */

async function carCounts(env: AppEnv): Promise<Map<string, number>> {
  const rows = await env.DB.prepare("SELECT account, COUNT(*) AS n FROM cars GROUP BY account").all<{
    account: string;
    n: number;
  }>();
  return new Map(rows.results.map((r) => [r.account, r.n]));
}

export async function listAccounts(env: AppEnv): Promise<AccountDto[]> {
  const counts = await carCounts(env);
  const rows = await env.DB.prepare("SELECT name, provider, label FROM accounts ORDER BY created_at, name").all<{
    name: string;
    provider: "tesla" | "volvo";
    label: string | null;
  }>();
  const tesla = await env.actors.auth().status();
  const accounts: AccountDto[] = [
    {
      name: "default",
      provider: "tesla",
      label: null,
      signedIn: tesla.signedIn,
      lastError: tesla.lastError,
      cars: counts.get("default") ?? 0,
    },
  ];
  for (const row of rows.results) {
    if (row.provider === "volvo") {
      const volvo = await env.actors.volvo().status();
      accounts.push({
        name: row.name,
        provider: "volvo",
        label: row.label,
        signedIn: volvo.connected,
        lastError: volvo.lastError,
        cars: counts.get(row.name) ?? 0,
      });
    } else {
      const status = await env.actors.auth(row.name).status();
      accounts.push({
        name: row.name,
        provider: "tesla",
        label: row.label,
        signedIn: status.signedIn,
        lastError: status.lastError,
        cars: counts.get(row.name) ?? 0,
      });
    }
  }
  return accounts;
}

/** Whether any account can read a car — what decides between the app and the connect screen. */
export async function anyAccountConnected(env: AppEnv, teslaSignedIn: boolean): Promise<boolean> {
  if (teslaSignedIn) return true;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return true;
  // Credentials saved but no consent yet still counts: the owner is mid-way
  // through connecting a Volvo, and the app's Settings is where that finishes.
  return (await env.actors.volvo().status()).configured;
}

export const accountRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/accounts", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    return c.json(await listAccounts(c.env));
  })

  /**
   * Another Tesla account. Its tokens are checked by refreshing them at once,
   * exactly as the first account's are, and its cars are registered. While the
   * original account is not connected, this connects that one instead.
   */
  .post("/accounts/tesla", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const body = await c.req.json<TeslaAccountInput>().catch((): Partial<TeslaAccountInput> => ({}));
    if (!body.access || !body.refresh) {
      return c.json({ error: "invalid_request", message: "access and refresh tokens are required" }, 400);
    }
    const original = await c.env.actors.auth().status();
    const name = original.signedIn ? `tesla-${randomToken(6).toLowerCase()}` : "default";
    const result = await c.env.actors.auth(name).signIn(body.access.trim(), body.refresh.trim(), name);
    if (!result.ok) return c.json({ error: "tesla_sign_in_failed", message: result.error }, 422);
    if (name !== "default") {
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : null;
      await c.env.DB.prepare("INSERT INTO accounts (name, provider, label, created_at) VALUES (?, 'tesla', ?, ?)")
        .bind(name, label, Date.now())
        .run();
    }
    await discoverCars(c.env, name);
    return c.json({ ok: true, account: name, cars: await listCars(c.env) });
  })

  /**
   * Sign a further Tesla account out and forget it. Its cars and their history
   * stay; they stop being polled until an account that can read them lists them.
   */
  .delete("/accounts/:name", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const name = c.req.param("name");
    if (name === "default" || name === VOLVO_ACCOUNT) {
      return c.json({ error: "invalid_account", message: "Disconnect this account from its own card" }, 400);
    }
    const row = await c.env.DB.prepare("SELECT provider FROM accounts WHERE name = ?").bind(name).first();
    if (!row) return c.json({ error: "not_found" }, 404);
    await c.env.actors.auth(name).signOut();
    await c.env.DB.prepare("DELETE FROM accounts WHERE name = ?").bind(name).run();
    return c.body(null, 204);
  });
