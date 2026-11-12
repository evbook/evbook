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
      pending: false,
      lastError: tesla.lastError,
      cars: counts.get("default") ?? 0,
    },
  ];
  const volvo = await env.actors.volvo().status();
  const volvoAccount = (label: string | null): AccountDto => ({
    name: VOLVO_ACCOUNT,
    provider: "volvo",
    label,
    signedIn: volvo.connected,
    // A grant that lapsed is a sign-in to repeat, not a setup to finish.
    pending: !volvo.connected && !volvo.reauthReason,
    lastError: volvo.lastError,
    cars: counts.get(VOLVO_ACCOUNT) ?? 0,
  });
  for (const row of rows.results) {
    if (row.provider === "volvo") {
      accounts.push(volvoAccount(row.label));
    } else {
      const status = await env.actors.auth(row.name).status();
      accounts.push({
        name: row.name,
        provider: "tesla",
        label: row.label,
        signedIn: status.signedIn,
        pending: false,
        lastError: status.lastError,
        cars: counts.get(row.name) ?? 0,
      });
    }
  }
  // The Volvo row is only written once a car is listed. Until then — a key
  // saved, or a consent whose key Volvo refused — the connection still exists
  // and has to be somewhere the owner can finish or remove it.
  if (volvo.configured && !accounts.some((a) => a.provider === "volvo")) accounts.push(volvoAccount(null));
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
   * A Tesla account's tokens, checked by refreshing them at once, and its cars
   * registered. Which account they belong to:
   *
   *   - `account` names one EVBook already has, to sign it back in;
   *   - otherwise the original account, while that is not connected;
   *   - otherwise a new one beside it.
   */
  .post("/accounts/tesla", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const body = await c.req.json<TeslaAccountInput>().catch((): Partial<TeslaAccountInput> => ({}));
    if (!body.access || !body.refresh) {
      return c.json({ error: "invalid_request", message: "access and refresh tokens are required" }, 400);
    }
    let name: string;
    let added = false;
    if (typeof body.account === "string" && body.account) {
      name = body.account;
      if (name !== "default") {
        const known = await c.env.DB.prepare("SELECT 1 FROM accounts WHERE name = ? AND provider = 'tesla'")
          .bind(name)
          .first();
        if (!known) return c.json({ error: "not_found", message: "No such Tesla account" }, 404);
      }
    } else if ((await c.env.actors.auth().status()).signedIn) {
      name = `tesla-${randomToken(6).toLowerCase()}`;
      added = true;
    } else {
      name = "default";
    }
    const result = await c.env.actors.auth(name).signIn(body.access.trim(), body.refresh.trim(), name);
    if (!result.ok) return c.json({ error: "tesla_sign_in_failed", message: result.error }, 422);
    if (added) {
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
