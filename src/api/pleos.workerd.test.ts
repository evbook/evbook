import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDto, PleosAccountDto, PleosConnectResult } from "@shared/api-types";
import { decryptString } from "../core/crypto";
import type { VehicleDO } from "../do/vehicle";
import { clearDurableObject, clearTables } from "../../test/db";
import { FAKE_PLEOS_CLIENT_ID, FAKE_PLEOS_SECRET, FakePleos, fakeJwt, ioniq5 } from "../../test/fake-pleos";
import { authed, getJson, login } from "../../test/http";

/**
 * Connecting a Hyundai, Kia or Genesis through the real routes, against the
 * fake Pleos Vehicle Data API: the key is checked with a token and its list of
 * cars before anything is stored, its electric cars are logged and the others
 * reported, the secret is stored encrypted, the token issued while checking is
 * the one the cars then read with, and the key is replaced in place and
 * forgotten with its account.
 */

const CAR_ID = 93;
const VIN = "KMHKM81CPNU000093";
const PETROL_VIN = "KMHKM81CPNU000094";

let fake: FakePleos;
const accountsMade: string[] = [];

const vehicle = (id: number) => env.VEHICLE_DO.getByName(`car:${id}`);

async function poll(id: number) {
  await runInDurableObject(vehicle(id), async (instance: VehicleDO) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  // Settings lists the Tesla and Volvo accounts too, through their actors: start those clean.
  await clearDurableObject(() => env.AUTH_DO.getByName("default"));
  await clearDurableObject(() => env.AUTH_DO.getByName("volvo"));
  await clearDurableObject(() => vehicle(CAR_ID));
  await clearTables("provider_snapshots", "pleos_keys", "accounts", "positions", "states", "drives", "cars");
  // The car is already known (imported from another logger): connecting it
  // turns it into a Pleos car rather than adding a second one.
  const now = Date.now();
  await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(CAR_ID, VIN, now, now)
    .run();
  fake = new FakePleos(ioniq5({ vin: VIN, nickname: "Blue" }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});

afterEach(async () => {
  await clearDurableObject(() => vehicle(CAR_ID));
  for (const account of accountsMade.splice(0)) await clearDurableObject(() => env.AUTH_DO.getByName(account));
  vi.restoreAllMocks();
});

async function connect(cookie: string, body: Record<string, unknown>) {
  const res = await authed(cookie, "/api/v1/pleos/keys", { method: "POST", body: JSON.stringify(body) });
  if (res.status === 200) {
    const result = (await res.clone().json()) as PleosConnectResult;
    accountsMade.push(result.account);
  }
  return res;
}

const KEY = { brand: "hyundai", clientId: FAKE_PLEOS_CLIENT_ID, clientSecret: FAKE_PLEOS_SECRET };

describe("Pleos connection", () => {
  it("checks the key, stores the secret encrypted, logs the car, and reads with the token it was given", async () => {
    const cookie = await login();
    const res = await connect(cookie, KEY);
    expect(res.status).toBe(200);
    const result = (await res.json()) as PleosConnectResult;
    expect(result).toMatchObject({ ok: true, enrolled: 1, skipped: [] });
    expect(fake.tokensMinted).toBe(1);
    expect(fake.count((r) => r.path === "/v1/vehicles/consent")).toBe(1);
    expect(fake.commands).toEqual([]);

    const car = await env.DB.prepare("SELECT id, provider, account, name FROM cars WHERE vin = ?").bind(VIN).first();
    expect(car).toEqual({ id: CAR_ID, provider: "pleos", account: result.account, name: "Blue" });
    const key = await env.DB.prepare("SELECT brand, client_id, secret_enc, secret_last4 FROM pleos_keys").first<{
      brand: string;
      client_id: string;
      secret_enc: string;
      secret_last4: string;
    }>();
    expect(key).toMatchObject({ brand: "hyundai", client_id: FAKE_PLEOS_CLIENT_ID, secret_last4: "WXYZ" });
    expect(key!.secret_enc).not.toContain(FAKE_PLEOS_SECRET);
    expect(await decryptString(env.ENCRYPTION_KEY, key!.secret_enc)).toBe(FAKE_PLEOS_SECRET);

    const listed = await getJson<PleosAccountDto[]>(cookie, "/api/v1/pleos");
    expect(listed).toEqual([
      {
        account: result.account,
        brand: "hyundai",
        clientId: FAKE_PLEOS_CLIENT_ID,
        secretLast4: "WXYZ",
        refusedReason: null,
        lastError: null,
        cars: [{ carId: CAR_ID, vin: VIN, name: "Blue" }],
      },
    ]);
    const accounts = await getJson<AccountDto[]>(cookie, "/api/v1/accounts");
    expect(accounts.find((a) => a.provider === "pleos")).toMatchObject({
      name: result.account,
      label: "Hyundai",
      signedIn: true,
      cars: 1,
    });

    // The first pass reads with the token issued while checking: another would have cancelled it.
    await poll(CAR_ID);
    expect(fake.reads).toBe(4);
    expect(fake.tokensMinted).toBe(1);
  });

  it("stores nothing when Pleos refuses the key, and says why without Pleos's words", async () => {
    const cookie = await login();
    for (const body of [
      { ...KEY, clientSecret: "wrong-secret-0000" },
      // A key belongs to one make.
      { ...KEY, brand: "kia" },
    ]) {
      const res = await connect(cookie, body);
      expect(res.status).toBe(422);
      const answer = (await res.json()) as { error: string; message: string };
      expect(answer.error).toBe("pleos_key_refused");
      expect(answer.message).not.toContain("req-");
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pleos_keys").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT provider FROM cars WHERE id = ?").bind(CAR_ID).first()).toEqual({
      provider: "tesla",
    });
  });

  it("logs the electric cars on a key and reports the others; a key with none is refused", async () => {
    const cookie = await login();
    fake.addCar(ioniq5({ vin: PETROL_VIN, type: "GN", sellname: "i30" }));
    const res = await connect(cookie, KEY);
    const result = (await res.json()) as PleosConnectResult;
    expect(result).toMatchObject({ enrolled: 1, skipped: [{ model: "i30", type: "GN" }] });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cars WHERE vin = ?").bind(PETROL_VIN).first()).toEqual({
      n: 0,
    });

    const petrolOnly = new FakePleos(ioniq5({ vin: PETROL_VIN, type: "GN" }), "kia", "kia-client-0001");
    vi.spyOn(globalThis, "fetch").mockImplementation(petrolOnly.fetch);
    const refused = await connect(cookie, {
      brand: "kia",
      clientId: "kia-client-0001",
      clientSecret: FAKE_PLEOS_SECRET,
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe("pleos_no_ev");
  });

  it("refuses a malformed key or an unknown make before asking Pleos anything", async () => {
    const cookie = await login();
    expect((await connect(cookie, { ...KEY, brand: "tesla" })).status).toBe(400);
    expect((await connect(cookie, { ...KEY, clientId: "a b" })).status).toBe(400);
    expect((await connect(cookie, { ...KEY, clientSecret: "" })).status).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it("will not connect the same key twice", async () => {
    const cookie = await login();
    await connect(cookie, KEY);
    expect((await connect(cookie, KEY)).status).toBe(409);
  });

  it("replaces a refused key in place, takes in a car added since, and forgets it with its account", async () => {
    const cookie = await login();
    const { account } = (await (await connect(cookie, KEY)).json()) as PleosConnectResult;
    await env.DB.prepare("UPDATE pleos_keys SET refused_at = 1, refused_reason = 'key_refused'").run();
    const refused = await getJson<AccountDto[]>(cookie, "/api/v1/accounts");
    expect(refused.find((a) => a.name === account)).toMatchObject({ signedIn: false });

    // The owner reissues the key after adding a second car.
    const newId = "pleos-client-0002";
    const second = "KMHKM81CPNU000095";
    fake.keys.set(newId, { brand: "hyundai", secret: "new-secret-ABCD", vins: [VIN], revoked: false, token: null });
    fake.addCar(ioniq5({ vin: second, sellname: "IONIQ 6" }), newId);
    const replaced = await authed(cookie, `/api/v1/pleos/keys/${account}`, {
      method: "PUT",
      body: JSON.stringify({ clientId: newId, clientSecret: "new-secret-ABCD" }),
    });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as PleosConnectResult).enrolled).toBe(2);
    const listed = await getJson<PleosAccountDto[]>(cookie, "/api/v1/pleos");
    expect(listed[0]).toMatchObject({ clientId: newId, secretLast4: "ABCD", refusedReason: null });
    expect(listed[0]!.cars.map((c) => c.vin)).toEqual([VIN, second]);

    const removed = await authed(cookie, `/api/v1/accounts/${account}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pleos_keys").first()).toEqual({ n: 0 });
    // The cars and their history stay, off both clocks: nothing wakes for a car that cannot be read.
    const car = () =>
      env.DB.prepare(
        "SELECT c.provider, c.next_due_at, s.enabled FROM cars c JOIN car_settings s ON s.car_id = c.id WHERE c.id = ?",
      )
        .bind(CAR_ID)
        .first();
    expect(await car()).toEqual({ provider: "pleos", next_due_at: null, enabled: 0 });
    // The key's token is forgotten too.
    const held = await runInDurableObject(env.AUTH_DO.getByName(account), (_i, s) => s.storage.get("pleos:token"));
    expect(held).toBeUndefined();
  });

  it("keeps the token out of every answer", async () => {
    const cookie = await login();
    await connect(cookie, KEY);
    const token = fake.keys.get(FAKE_PLEOS_CLIENT_ID)!.token!;
    expect(token.split(".")).toHaveLength(3);
    for (const path of ["/api/v1/pleos", "/api/v1/accounts"]) {
      const text = await (await authed(cookie, path)).text();
      expect(text).not.toContain(token);
      expect(text).not.toContain(FAKE_PLEOS_SECRET);
    }
    expect(fakeJwt(0)).not.toBe(token);
  });
});
