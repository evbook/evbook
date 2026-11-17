import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDto, SkodaCarDto } from "@shared/api-types";
import { decryptString } from "../core/crypto";
import { clearDurableObject, clearTables } from "../../test/db";
import { FAKE_SKODA_KEY, FakeSkoda, elroq } from "../../test/fake-skoda";
import { authed, getJson, login } from "../../test/http";

/**
 * Connecting a Škoda through the real routes, against the fake MySkoda Public
 * API: the key is checked with one read before anything is stored, stored
 * encrypted, swapped for a new one in place, and forgotten with its account.
 */

const CAR_ID = 82;
const VIN = "TMBJC7NY0SF000082";

let fake: FakeSkoda;

const vehicle = () => env.VEHICLE_DO.getByName(`car:${CAR_ID}`);

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearDurableObject(() => env.AUTH_DO.getByName("default"));
  await clearDurableObject(() => env.AUTH_DO.getByName("volvo"));
  await clearDurableObject(() => vehicle());
  await clearTables("provider_snapshots", "skoda_keys", "accounts", "positions", "states", "drives", "cars");
  // The car is already known (imported from another logger): connecting it
  // turns it into a Škoda rather than adding a second one.
  const now = Date.now();
  await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(CAR_ID, VIN, now, now)
    .run();
  fake = new FakeSkoda(elroq({ vin: VIN }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});

afterEach(async () => {
  await clearDurableObject(() => vehicle());
  vi.restoreAllMocks();
});

const connect = (cookie: string, body: Record<string, unknown>) =>
  authed(cookie, "/api/v1/skoda/cars", { method: "POST", body: JSON.stringify(body) });

describe("Škoda connection", () => {
  it("checks the key with one read, stores it encrypted, and starts the car", async () => {
    const cookie = await login();
    const res = await connect(cookie, { vin: VIN.toLowerCase(), apiKey: FAKE_SKODA_KEY });
    expect(res.status).toBe(200);
    expect(fake.reads).toBe(1);
    expect(fake.commands).toEqual([]);

    const car = await env.DB.prepare("SELECT id, provider, account, name FROM cars WHERE vin = ?").bind(VIN).first<{
      id: number;
      provider: string;
      account: string;
      name: string;
    }>();
    expect(car).toMatchObject({ id: CAR_ID, provider: "skoda", name: "Elroq" });
    const key = await env.DB.prepare("SELECT key_enc, key_last4, expires_at FROM skoda_keys WHERE vin = ?")
      .bind(VIN)
      .first<{ key_enc: string; key_last4: string; expires_at: number }>();
    expect(key!.key_enc).not.toContain(FAKE_SKODA_KEY);
    expect(await decryptString(env.ENCRYPTION_KEY, key!.key_enc)).toBe(FAKE_SKODA_KEY);
    expect(key!.key_last4).toBe("ABCD");

    const listed = await getJson<SkodaCarDto[]>(cookie, "/api/v1/skoda");
    expect(listed).toEqual([
      expect.objectContaining({ vin: VIN, carId: CAR_ID, keyLast4: "ABCD", expiring: false, refusedReason: null }),
    ]);
    const accounts = await getJson<AccountDto[]>(cookie, "/api/v1/accounts");
    expect(accounts.find((a) => a.provider === "skoda")).toMatchObject({
      name: car!.account,
      label: "Elroq",
      signedIn: true,
      cars: 1,
    });
    // The logger is armed.
    const armed = await vehicle().getSummary();
    expect(armed?.carId).toBe(CAR_ID);
  });

  it("stores nothing when Škoda refuses the key, and says why without Škoda's words", async () => {
    const cookie = await login();
    const res = await connect(cookie, { vin: VIN, apiKey: "wrong-key-0000" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("skoda_key_expired");
    expect(body.message).not.toContain(VIN);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM skoda_keys").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT provider FROM cars WHERE id = ?").bind(CAR_ID).first()).toEqual({
      provider: "tesla",
    });
  });

  it("refuses a key that answers for another car", async () => {
    const cookie = await login();
    fake.answerAsVin = "TMBJC7NY0SF000099";
    const res = await connect(cookie, { vin: VIN, apiKey: FAKE_SKODA_KEY });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("skoda_wrong_car");
  });

  it("refuses a malformed VIN or key before asking Škoda anything", async () => {
    const cookie = await login();
    expect((await connect(cookie, { vin: "short", apiKey: FAKE_SKODA_KEY })).status).toBe(400);
    expect((await connect(cookie, { vin: VIN, apiKey: "a b" })).status).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it("replaces a refused key in place, and forgets it with its account", async () => {
    const cookie = await login();
    await connect(cookie, { vin: VIN, apiKey: FAKE_SKODA_KEY });
    const { account } = (await env.DB.prepare("SELECT account FROM skoda_keys").first<{ account: string }>())!;
    await env.DB.prepare("UPDATE skoda_keys SET refused_at = 1, refused_reason = 'key_expired'").run();
    const refused = await getJson<AccountDto[]>(cookie, "/api/v1/accounts");
    expect(refused.find((a) => a.name === account)).toMatchObject({ signedIn: false });

    const newKey = "skoda-new-key-WXYZ";
    fake.keys.set(newKey, { vin: VIN, expiresAt: Date.now() + 5 * 24 * 60 * 60_000 });
    const replaced = await authed(cookie, `/api/v1/skoda/cars/${account}/key`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: newKey }),
    });
    expect(replaced.status).toBe(200);
    const listed = await getJson<SkodaCarDto[]>(cookie, "/api/v1/skoda");
    // Five days left: the owner is told before it lapses.
    expect(listed[0]).toMatchObject({ keyLast4: "WXYZ", refusedReason: null, expiring: true });

    const removed = await authed(cookie, `/api/v1/accounts/${account}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM skoda_keys").first()).toEqual({ n: 0 });
    // The car and its history stay, off both clocks: nothing wakes for a car that cannot be read.
    const car = () =>
      env.DB.prepare(
        "SELECT c.provider, c.next_due_at, s.enabled FROM cars c JOIN car_settings s ON s.car_id = c.id WHERE c.id = ?",
      )
        .bind(CAR_ID)
        .first();
    expect(await car()).toEqual({ provider: "skoda", next_due_at: null, enabled: 0 });

    // Connecting it again is asking for its logging back.
    expect((await connect(cookie, { vin: VIN, apiKey: FAKE_SKODA_KEY })).status).toBe(200);
    expect(await car()).toMatchObject({ enabled: 1 });
    expect((await car())?.next_due_at).not.toBeNull();
  });

  it("will not connect the same car twice", async () => {
    const cookie = await login();
    await connect(cookie, { vin: VIN, apiKey: FAKE_SKODA_KEY });
    const again = await connect(cookie, { vin: VIN, apiKey: FAKE_SKODA_KEY });
    expect(again.status).toBe(409);
  });
});
