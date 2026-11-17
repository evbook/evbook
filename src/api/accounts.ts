import { Hono } from "hono";
import { VOLVO_ACCOUNT } from "../actors/volvoAuth";
import { randomToken } from "../core/crypto";
import type { AppEnv } from "../platform/env";
import { PROVIDERS, isProvider, type AccountDto, type Provider, type TeslaAccountInput } from "@shared/api-types";
import type { AccountAdapter, AccountRow } from "./accountAdapter";
import { discoverCars, listCars } from "./cars";
import { DEMO_REFUSAL, isDemo } from "./demo";
import { skodaAccounts } from "./skoda";
import { volvoAccounts } from "./volvo";

/**
 * Every vehicle account the instance reads through: the Tesla account EVBook
 * always had ("default", connected from the first-run screen), any further
 * Tesla accounts, the Volvo ID, and a Škoda's key. Each Tesla account is its
 * own auth actor, named after the account, holding its own encrypted tokens
 * and refresh clock. What each provider's accounts look like is the provider's
 * to say (accountAdapter.ts); this file only puts them together.
 */

async function carCounts(env: AppEnv): Promise<Map<string, number>> {
  const rows = await env.DB.prepare("SELECT account, COUNT(*) AS n FROM cars GROUP BY account").all<{
    account: string;
    n: number;
  }>();
  return new Map(rows.results.map((r) => [r.account, r.n]));
}

/** The Tesla accounts: the original one, which has no row, then any added beside it. */
const teslaAccounts: AccountAdapter = {
  async list(env, rows, cars) {
    const all = [{ name: "default", provider: "tesla", label: null }, ...rows];
    const accounts: AccountDto[] = [];
    for (const row of all) {
      const status = await env.actors.auth(row.name === "default" ? undefined : row.name).status();
      accounts.push({
        name: row.name,
        provider: "tesla",
        label: row.label,
        signedIn: status.signedIn,
        pending: false,
        lastError: status.lastError,
        cars: cars.get(row.name) ?? 0,
      });
    }
    return accounts;
  },
  async remove(env, name) {
    await env.actors.auth(name).signOut();
  },
};

/** Keyed by `Provider`, so a provider added to the type does not compile until Settings can list it. */
const ACCOUNT_ADAPTERS: Record<Provider, AccountAdapter> = {
  tesla: teslaAccounts,
  volvo: volvoAccounts,
  skoda: skodaAccounts,
};

/** Every account, provider by provider in `PROVIDERS` order, each provider's oldest first. */
export async function listAccounts(env: AppEnv): Promise<AccountDto[]> {
  const cars = await carCounts(env);
  const rows = await env.DB.prepare(
    "SELECT name, provider, label FROM accounts ORDER BY created_at, name",
  ).all<AccountRow>();
  const accounts: AccountDto[] = [];
  for (const provider of PROVIDERS) {
    const own = rows.results.filter((row) => row.provider === provider);
    accounts.push(...(await ACCOUNT_ADAPTERS[provider].list(env, own, cars)));
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
   * Forget an account added beside the original ones: sign a further Tesla
   * account out, or drop a Škoda's key. Its cars and their history stay.
   */
  .delete("/accounts/:name", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const name = c.req.param("name");
    if (name === "default" || name === VOLVO_ACCOUNT) {
      return c.json({ error: "invalid_account", message: "Disconnect this account from its own card" }, 400);
    }
    const row = await c.env.DB.prepare("SELECT provider FROM accounts WHERE name = ?")
      .bind(name)
      .first<{ provider: string }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    // A row whose provider this build does not know has nothing else to forget.
    const adapter = isProvider(row.provider) ? ACCOUNT_ADAPTERS[row.provider] : null;
    if (adapter && !adapter.remove) {
      return c.json({ error: "invalid_account", message: "Disconnect this account from its own card" }, 400);
    }
    await adapter?.remove?.(c.env, name);
    await c.env.DB.prepare("DELETE FROM accounts WHERE name = ?").bind(name).run();
    return c.body(null, 204);
  });
