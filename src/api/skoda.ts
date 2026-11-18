import { Hono } from "hono";
import { encryptString, randomToken } from "../core/crypto";
import { normalizeVin } from "../core/provider/vin";
import { SkodaClient } from "../core/skoda/api";
import { CHECK_TEXT, FAILURE_TEXT, refusedReasonOf } from "../core/skoda/errors";
import { normalize } from "../core/skoda/normalize";
import type { AppEnv } from "../platform/env";
import type { SkodaCarDto, SkodaCarInput } from "@shared/api-types";
import { keyAccounts, type AccountAdapter } from "./accountAdapter";
import { DEMO_REFUSAL, isDemo } from "./demo";

/**
 * Connecting a Škoda: the owner creates an API key in the MySkoda app (Profile,
 * Smart Home, or go.skoda.eu/api-keys; one key per car, shown once) and pastes
 * it here with the car's VIN. The key is checked with one read before anything
 * is stored, and that read must answer for the same VIN, so a key can never
 * fill in another car's history.
 *
 * Each key is an account of its own (`skoda-…`) holding one car. A key that
 * lapses is replaced in place: the car and its history stay.
 */

/** Say so two weeks ahead: Škoda's keys are reported to last about three months. */
const EXPIRING_MS = 14 * 24 * 60 * 60_000;

type Checked =
  | { ok: true; name: string | null; expiresAt: number | null }
  | { ok: false; status: 409 | 422 | 503; error: string; message: string };

/** One read with the key, which must answer for `vin`. */
async function checkKey(vin: string, apiKey: string): Promise<Checked> {
  const result = await new SkodaClient().read(vin, apiKey);
  if (!result.ok) {
    const kind = result.error.kind;
    const transient = kind === "rate_limited" || kind === "vehicle_refused" || kind === "unavailable";
    return { ok: false, status: transient ? 503 : 422, error: `skoda_${kind}`, message: CHECK_TEXT[kind] };
  }
  const normalized = normalize(result.value, Date.now());
  if (normalized.vin !== null && normalized.vin.toUpperCase() !== vin) {
    return { ok: false, status: 422, error: "skoda_wrong_car", message: CHECK_TEXT.wrong_car };
  }
  return { ok: true, name: normalized.patch.name?.v ?? null, expiresAt: result.rate.keyExpiresAt };
}

function parseInput(body: Partial<SkodaCarInput>): { vin: string; apiKey: string } | string {
  const vin = typeof body.vin === "string" ? normalizeVin(body.vin) : null;
  if (!vin) return "A VIN is 17 letters and digits.";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey))
    return "Paste the whole API key from the MySkoda app.";
  return { vin, apiKey };
}

export async function listSkodaCars(env: AppEnv): Promise<SkodaCarDto[]> {
  const rows = await env.DB.prepare(
    "SELECT k.account, k.vin, k.key_last4, k.expires_at, k.refused_reason, c.id AS car_id, c.name " +
      "FROM skoda_keys k LEFT JOIN cars c ON c.vin = k.vin ORDER BY k.created_at",
  ).all<{
    account: string;
    vin: string;
    key_last4: string;
    expires_at: number | null;
    refused_reason: string | null;
    car_id: number | null;
    name: string | null;
  }>();
  const now = Date.now();
  return rows.results.map((r) => {
    const refused = refusedReasonOf(r.refused_reason);
    return {
      account: r.account,
      carId: r.car_id,
      vin: r.vin,
      name: r.name,
      keyLast4: r.key_last4,
      expiresAt: r.expires_at,
      expiring: r.expires_at !== null && r.expires_at - now < EXPIRING_MS,
      refusedReason: refused,
      lastError: refused ? CHECK_TEXT[refused] : null,
    };
  });
}

/**
 * A Škoda key is an account of its own (`keyAccounts`, accountAdapter.ts):
 * removing one forgets the key and switches the car's logging off; connecting
 * the car again switches it back on.
 */
export const skodaAccounts: AccountAdapter = keyAccounts({
  provider: "skoda",
  refusal: (reason) => {
    const refused = refusedReasonOf(reason);
    return refused ? FAILURE_TEXT[refused] : null;
  },
});

async function startLogging(env: AppEnv, vin: string): Promise<void> {
  const car = await env.DB.prepare(
    "SELECT c.id FROM cars c JOIN car_settings s ON s.car_id = c.id WHERE c.vin = ? AND s.enabled = 1",
  )
    .bind(vin)
    .first<{ id: number }>();
  if (car) await env.actors.vehicle(car.id).restartPolling(car.id);
}

export const skodaRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/skoda", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    return c.json(await listSkodaCars(c.env));
  })

  /** A car and its key: checked with one read, then stored and logged. */
  .post("/skoda/cars", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const parsed = parseInput(await c.req.json<Partial<SkodaCarInput>>().catch(() => ({})));
    if (typeof parsed === "string") return c.json({ error: "invalid_request", message: parsed }, 400);
    const { vin, apiKey } = parsed;
    const existing = await c.env.DB.prepare("SELECT account FROM skoda_keys WHERE vin = ?").bind(vin).first();
    if (existing) {
      return c.json(
        { error: "already_connected", message: "This Škoda is already connected: replace its key instead." },
        409,
      );
    }
    const checked = await checkKey(vin, apiKey);
    if (!checked.ok) return c.json({ error: checked.error, message: checked.message }, checked.status);

    const now = Date.now();
    const account = `skoda-${randomToken(6).toLowerCase()}`;
    const keyEnc = await encryptString(c.env.ENCRYPTION_KEY, apiKey);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO accounts (name, provider, label, created_at) VALUES (?, 'skoda', ?, ?)").bind(
        account,
        checked.name ? checked.name.slice(0, 60) : null,
        now,
      ),
      c.env.DB.prepare(
        "INSERT INTO skoda_keys (account, vin, key_enc, key_last4, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(account, vin, keyEnc, apiKey.slice(-4), checked.expiresAt, now, now),
      // A VIN EVBook already knows (imported, say) becomes a Škoda read through this key.
      c.env.DB.prepare(
        "INSERT INTO cars (vin, name, provider, account, inserted_at, updated_at) VALUES (?, ?, 'skoda', ?, ?, ?) " +
          "ON CONFLICT(vin) DO UPDATE SET provider = 'skoda', account = excluded.account, " +
          "name = COALESCE(cars.name, excluded.name), updated_at = excluded.updated_at",
      ).bind(vin, checked.name ? checked.name.slice(0, 60) : null, account, now, now),
      c.env.DB.prepare("INSERT OR IGNORE INTO car_settings (car_id) SELECT id FROM cars WHERE vin = ?").bind(vin),
      // Removing a Škoda switches its logging off (skodaAccounts.remove): connecting it is asking for it back.
      c.env.DB.prepare("UPDATE car_settings SET enabled = 1 WHERE car_id = (SELECT id FROM cars WHERE vin = ?)").bind(
        vin,
      ),
    ]);
    await startLogging(c.env, vin);
    return c.json({ ok: true, account, cars: await listSkodaCars(c.env) });
  })

  /** A new key for a car EVBook already reads: checked against the same VIN, then swapped in. */
  .put("/skoda/cars/:account/key", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const account = c.req.param("account");
    const row = await c.env.DB.prepare("SELECT vin FROM skoda_keys WHERE account = ?")
      .bind(account)
      .first<{ vin: string }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json<Partial<SkodaCarInput>>().catch((): Partial<SkodaCarInput> => ({}));
    const parsed = parseInput({ vin: row.vin, apiKey: body.apiKey });
    if (typeof parsed === "string") return c.json({ error: "invalid_request", message: parsed }, 400);
    const checked = await checkKey(row.vin, parsed.apiKey);
    if (!checked.ok) return c.json({ error: checked.error, message: checked.message }, checked.status);

    const now = Date.now();
    await c.env.DB.prepare(
      "UPDATE skoda_keys SET key_enc = ?, key_last4 = ?, expires_at = ?, refused_at = NULL, refused_reason = NULL, " +
        "updated_at = ? WHERE account = ?",
    )
      .bind(
        await encryptString(c.env.ENCRYPTION_KEY, parsed.apiKey),
        parsed.apiKey.slice(-4),
        checked.expiresAt,
        now,
        account,
      )
      .run();
    await startLogging(c.env, row.vin);
    return c.json({ ok: true, cars: await listSkodaCars(c.env) });
  });
