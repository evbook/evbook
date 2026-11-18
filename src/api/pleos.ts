import { Hono } from "hono";
import { PLEOS_ACCOUNT_PREFIX } from "../actors/pleosAuth";
import { encryptString, randomToken } from "../core/crypto";
import { PleosClient, isLoggable, type ConsentVehicle, type Token } from "../core/pleos/api";
import { CHECK_TEXT, FAILURE_TEXT, refusedReasonOf } from "../core/pleos/errors";
import type { AppEnv } from "../platform/env";
import {
  isPleosBrand,
  type PleosAccountDto,
  type PleosBrand,
  type PleosConnectResult,
  type PleosKeyInput,
} from "@shared/api-types";
import { keyAccounts, type AccountAdapter } from "./accountAdapter";
import { DEMO_REFUSAL, isDemo } from "./demo";

/**
 * Connecting a Hyundai, Kia or Genesis: the owner issues a personal key in
 * Pleos Playground (Workspace → My Vehicle Data API, choosing the make and
 * signing in with the maker's account) and pastes its client ID and secret
 * here with the make. The key is checked before anything is stored: a token is
 * issued with it and the cars on it are listed. Every electric and plug-in car
 * on the list is then logged; a petrol, hybrid or fuel-cell car is reported
 * and left out.
 *
 * Each key is an account of its own (`pleos-…`) holding the cars it covers.
 * Its list of cars is fixed when the key is issued, so a car added to the
 * maker's account later needs a new key: replacing the key enrols it, and the
 * cars already logged keep their history.
 *
 * The token issued while checking is handed to the key's token holder
 * (src/actors/pleosAuth.ts), so the first reads do not issue another, which
 * would cancel it.
 */

type Checked =
  | { ok: true; token: Token; vehicles: ConsentVehicle[] }
  | { ok: false; status: 422 | 503; error: string; message: string };

/** A token for the key, and the cars on it. */
async function checkKey(input: PleosKeyInput): Promise<Checked> {
  const client = new PleosClient();
  const token = await client.token(input.brand, input.clientId, input.clientSecret);
  const fail = (kind: "key_refused" | "rate_limited" | "unavailable" | "bad_request"): Checked => ({
    ok: false,
    status: kind === "key_refused" || kind === "bad_request" ? 422 : 503,
    error: `pleos_${kind}`,
    message: CHECK_TEXT[kind],
  });
  if (!token.ok) {
    const kind = token.error.kind;
    return fail(kind === "key_refused" || kind === "rate_limited" ? kind : "unavailable");
  }
  const vehicles = await client.vehicles(input.brand, token.value.token);
  if (!vehicles.ok) {
    const kind = vehicles.error.kind;
    // A token refused at once, with no other reader yet, is the key's problem.
    if (kind === "token_refused" || kind === "not_shared") return fail("key_refused");
    return fail(kind === "rate_limited" || kind === "bad_request" ? kind : "unavailable");
  }
  if (!vehicles.value.some(isLoggable)) {
    return {
      ok: false,
      status: 422,
      error: "pleos_no_ev",
      message:
        vehicles.value.length === 0
          ? "The key covers no car. Only the car's primary user can issue a key for it, and the key covers only the cars on the account when it was issued."
          : "None of the cars on this key is electric or a plug-in hybrid, so there is nothing for EVBook to log.",
    };
  }
  return { ok: true, token: token.value, vehicles: vehicles.value };
}

function parseInput(body: Partial<PleosKeyInput>): PleosKeyInput | string {
  if (!isPleosBrand(body.brand)) return "Choose Hyundai, Kia or Genesis.";
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  const plausible = (v: string) => v.length >= 8 && v.length <= 512 && !/\s/.test(v);
  if (!plausible(clientId)) return "Paste the whole Client ID from Pleos Playground.";
  if (!plausible(clientSecret)) return "Paste the whole Client Secret from Pleos Playground.";
  return { brand: body.brand, clientId, clientSecret };
}

/** The name a car goes by until the owner gives it one: the app's nickname, else the model. */
function carName(v: ConsentVehicle): string | null {
  return v.nickname ?? v.sellName ?? v.model;
}

export async function listPleosAccounts(env: AppEnv): Promise<PleosAccountDto[]> {
  const keys = await env.DB.prepare(
    "SELECT account, brand, client_id, secret_last4, refused_reason FROM pleos_keys ORDER BY created_at",
  ).all<{
    account: string;
    brand: string;
    client_id: string;
    secret_last4: string;
    refused_reason: string | null;
  }>();
  const cars = await env.DB.prepare(
    "SELECT id, vin, name, account FROM cars WHERE provider = 'pleos' ORDER BY id",
  ).all<{ id: number; vin: string; name: string | null; account: string }>();
  return keys.results
    .filter((k) => isPleosBrand(k.brand))
    .map((k) => {
      const refused = refusedReasonOf(k.refused_reason);
      return {
        account: k.account,
        brand: k.brand as PleosBrand,
        clientId: k.client_id,
        secretLast4: k.secret_last4,
        refusedReason: refused,
        lastError: refused ? FAILURE_TEXT[refused] : null,
        cars: cars.results
          .filter((c) => c.account === k.account)
          .map((c) => ({ carId: c.id, vin: c.vin, name: c.name })),
      };
    });
}

/**
 * A Pleos key is an account of its own (`keyAccounts`, accountAdapter.ts).
 * Removing one also forgets the token its holder keeps.
 */
export const pleosAccounts: AccountAdapter = keyAccounts({
  provider: "pleos",
  refusal: (reason) => {
    const refused = refusedReasonOf(reason);
    return refused ? FAILURE_TEXT[refused] : null;
  },
  forget: async (env, name) => {
    if (name.startsWith(PLEOS_ACCOUNT_PREFIX)) await env.actors.pleos(name).forget();
  },
});

const LABEL: Record<PleosBrand, string> = { hyundai: "Hyundai", kia: "Kia", genesis: "Genesis" };

/**
 * Store the key's cars that can be logged under `account`, switch their
 * logging on, hand the key's token to its holder, and start reading. A VIN
 * EVBook already knows (imported, say, or read through an older key) becomes
 * a car read through this key.
 */
async function enrol(env: AppEnv, account: string, checked: Extract<Checked, { ok: true }>, now: number) {
  const loggable = checked.vehicles.filter(isLoggable);
  const statements = loggable.flatMap((v) => {
    const name = carName(v);
    return [
      env.DB.prepare(
        "INSERT INTO cars (vin, name, provider, account, inserted_at, updated_at) VALUES (?, ?, 'pleos', ?, ?, ?) " +
          "ON CONFLICT(vin) DO UPDATE SET provider = 'pleos', account = excluded.account, " +
          "name = COALESCE(cars.name, excluded.name), updated_at = excluded.updated_at",
      ).bind(v.vin, name, account, now, now),
      env.DB.prepare("INSERT OR IGNORE INTO car_settings (car_id) SELECT id FROM cars WHERE vin = ?").bind(v.vin),
      // Removing a key switches its cars' logging off (pleosAccounts.remove): connecting it is asking for it back.
      env.DB.prepare("UPDATE car_settings SET enabled = 1 WHERE car_id = (SELECT id FROM cars WHERE vin = ?)").bind(
        v.vin,
      ),
    ];
  });
  await env.DB.batch(statements);
  await env.actors.pleos(account).adopt(checked.token.token, checked.token.expiresAt);
  const cars = await env.DB.prepare("SELECT id FROM cars WHERE account = ? AND provider = 'pleos'")
    .bind(account)
    .all<{ id: number }>();
  for (const car of cars.results) await env.actors.vehicle(car.id).restartPolling(car.id);
  return {
    enrolled: loggable.length,
    skipped: checked.vehicles
      .filter((v) => !isLoggable(v))
      .map((v) => ({ model: v.sellName ?? v.model, type: v.type })),
  };
}

export const pleosRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/pleos", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    return c.json(await listPleosAccounts(c.env));
  })

  /** A new key: checked with a token and the list of its cars, then stored and its cars logged. */
  .post("/pleos/keys", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const parsed = parseInput(await c.req.json<Partial<PleosKeyInput>>().catch(() => ({})));
    if (typeof parsed === "string") return c.json({ error: "invalid_request", message: parsed }, 400);
    const existing = await c.env.DB.prepare("SELECT account FROM pleos_keys WHERE brand = ? AND client_id = ?")
      .bind(parsed.brand, parsed.clientId)
      .first();
    if (existing) {
      return c.json({ error: "already_connected", message: "This key is already connected: replace it instead." }, 409);
    }
    const checked = await checkKey(parsed);
    if (!checked.ok) return c.json({ error: checked.error, message: checked.message }, checked.status);

    const now = Date.now();
    const account = `${PLEOS_ACCOUNT_PREFIX}${randomToken(6).toLowerCase()}`;
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO accounts (name, provider, label, created_at) VALUES (?, 'pleos', ?, ?)").bind(
        account,
        LABEL[parsed.brand],
        now,
      ),
      c.env.DB.prepare(
        "INSERT INTO pleos_keys (account, brand, client_id, secret_enc, secret_last4, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        account,
        parsed.brand,
        parsed.clientId,
        await encryptString(c.env.ENCRYPTION_KEY, parsed.clientSecret),
        parsed.clientSecret.slice(-4),
        now,
        now,
      ),
    ]);
    const result = await enrol(c.env, account, checked, now);
    return c.json({
      ok: true,
      account,
      ...result,
      accounts: await listPleosAccounts(c.env),
    } satisfies PleosConnectResult);
  })

  /**
   * A new key for an account EVBook already has (reissued, or to add a car):
   * the same make, checked the same way, then swapped in. Cars it covers that
   * EVBook did not log yet are added.
   */
  .put("/pleos/keys/:account", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const account = c.req.param("account");
    const row = await c.env.DB.prepare("SELECT brand FROM pleos_keys WHERE account = ?")
      .bind(account)
      .first<{ brand: string }>();
    if (!row || !isPleosBrand(row.brand)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json<Partial<PleosKeyInput>>().catch((): Partial<PleosKeyInput> => ({}));
    const parsed = parseInput({ ...body, brand: row.brand });
    if (typeof parsed === "string") return c.json({ error: "invalid_request", message: parsed }, 400);
    const other = await c.env.DB.prepare(
      "SELECT account FROM pleos_keys WHERE brand = ? AND client_id = ? AND account <> ?",
    )
      .bind(parsed.brand, parsed.clientId, account)
      .first();
    if (other) {
      return c.json({ error: "already_connected", message: "This key is connected as another account already." }, 409);
    }
    const checked = await checkKey(parsed);
    if (!checked.ok) return c.json({ error: checked.error, message: checked.message }, checked.status);

    const now = Date.now();
    await c.env.DB.prepare(
      "UPDATE pleos_keys SET client_id = ?, secret_enc = ?, secret_last4 = ?, refused_at = NULL, " +
        "refused_reason = NULL, updated_at = ? WHERE account = ?",
    )
      .bind(
        parsed.clientId,
        await encryptString(c.env.ENCRYPTION_KEY, parsed.clientSecret),
        parsed.clientSecret.slice(-4),
        now,
        account,
      )
      .run();
    const result = await enrol(c.env, account, checked, now);
    return c.json({
      ok: true,
      account,
      ...result,
      accounts: await listPleosAccounts(c.env),
    } satisfies PleosConnectResult);
  });
