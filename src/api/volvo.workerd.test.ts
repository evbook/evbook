import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, VolvoStatusDto } from "@shared/api-types";
import { clearDurableObject, clearTables } from "../../test/db";
import { FAKE_CLIENT, FAKE_ISSUER, FAKE_LINK_URL, FakeVolvo, ex30 } from "../../test/fake-volvo";
import { authed, login } from "../../test/http";

/**
 * Connecting a Volvo through the real routes, against the fake Volvo: the
 * credentials, the consent's start and callback (state, cookie, PKCE, the code
 * exchange) and the cars the grant lists.
 */

const CAR_ID = 71;
const VIN = "YV1XZK1V8RX000071";

let fake: FakeVolvo;

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearDurableObject(() => env.AUTH_DO.getByName("volvo"));
  // The session route reads the Tesla account too; absorb its invalidation here.
  await clearDurableObject(() => env.AUTH_DO.getByName("default"));
  await clearDurableObject(() => env.VEHICLE_DO.getByName(`car:${CAR_ID}`));
  await clearTables("volvo_snapshots", "accounts", "positions", "states", "charging_processes", "drives", "cars");
  // The car is already known — imported from another logger, say — and the
  // consent turns it into a Volvo car rather than adding a second one.
  const now = Date.now();
  await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(CAR_ID, VIN, now, now)
    .run();
  fake = new FakeVolvo(ex30({ vin: VIN }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});

afterEach(async () => {
  // The consent starts the car's logger; stop it before the fake goes away.
  await clearDurableObject(() => env.VEHICLE_DO.getByName(`car:${CAR_ID}`));
  vi.restoreAllMocks();
});

async function saveCredentials(cookie: string, body: Record<string, unknown> = FAKE_CLIENT) {
  return authed(cookie, "/api/v1/volvo/credentials", { method: "PUT", body: JSON.stringify(body) });
}

/** Start → consent at the fake Volvo ID → callback, as a browser would. */
async function connect(cookie: string): Promise<Response> {
  const start = await authed(cookie, "/api/v1/auth/volvo/start", { redirect: "manual" });
  expect(start.status).toBe(302);
  const location = start.headers.get("location")!;
  expect(location.startsWith(`${FAKE_ISSUER}/protocol/openid-connect/auth?`)).toBe(true);
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const { code, state } = fake.consent(location);
  return authed(cookie, `/api/v1/auth/volvo/callback?state=${state}&code=${code}`, {
    redirect: "manual",
    headers: { cookie: `${cookie}; ${stateCookie}` },
  });
}

describe("Volvo connection", () => {
  it("connects through EVBook's account linking with nothing but an API key", async () => {
    const cookie = await login();
    const fresh = (await (await authed(cookie, "/api/v1/volvo")).json()) as VolvoStatusDto;
    expect(fresh).toMatchObject({ configured: false, mode: "linked", linkUrl: FAKE_LINK_URL });

    const saved = await saveCredentials(cookie, { apiKey: FAKE_CLIENT.apiKey });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ configured: true, mode: "linked", clientId: null, apiKeyLast4: "1234" });

    const start = await authed(cookie, "/api/v1/auth/volvo/start", { redirect: "manual" });
    const location = new URL(start.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${FAKE_LINK_URL}/authorize`);
    expect(location.searchParams.get("return")).toBe("https://x/api/v1/auth/volvo/callback");
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const { code, state } = fake.consentLinked(location.toString());
    const callback = await authed(cookie, `/api/v1/auth/volvo/callback?state=${state}&code=${code}`, {
      redirect: "manual",
      headers: { cookie: `${cookie}; ${stateCookie}` },
    });
    expect(callback.headers.get("location")).toBe("/settings?volvo=connected");
    expect((await env.DB.prepare("SELECT provider FROM cars WHERE vin = ?").bind(VIN).first())?.provider).toBe("volvo");

    // Renewals go through the linking service too, never to Volvo ID directly.
    expect(await env.AUTH_DO.getByName("volvo").volvoForceRefresh()).toBe(true);
    expect(fake.calls.filter((c) => c === "POST /token")).toHaveLength(2);
    expect(fake.calls.filter((c) => c.endsWith("/openid-connect/token"))).toHaveLength(0);
  });

  it("drops the grant when switching between linking and an own application", async () => {
    const cookie = await login();
    await saveCredentials(cookie);
    await connect(cookie);
    await saveCredentials(cookie, { mode: "linked" });
    const status = (await (await authed(cookie, "/api/v1/volvo")).json()) as VolvoStatusDto;
    expect(status).toMatchObject({
      mode: "linked",
      connected: false,
      reauthReason: "client_changed",
      apiKeyLast4: "1234",
    });
  });

  it("refuses an old Volvo ID client, a missing secret and a command scope", async () => {
    const cookie = await login();
    const old = await saveCredentials(cookie, { ...FAKE_CLIENT, clientId: "dc-old" });
    expect(old.status).toBe(422);
    expect(((await old.json()) as { message: string }).message).toContain("vid-");
    const noSecret = await saveCredentials(cookie, { clientId: FAKE_CLIENT.clientId, apiKey: "k" });
    expect(noSecret.status).toBe(422);
    const command = await saveCredentials(cookie, { ...FAKE_CLIENT, scopes: "openid conve:lock" });
    expect(command.status).toBe(422);
  });

  it("never hands the secret or the key back", async () => {
    const cookie = await login();
    expect((await saveCredentials(cookie)).status).toBe(200);
    const res = await authed(cookie, "/api/v1/volvo");
    const text = await res.text();
    expect(text).not.toContain(FAKE_CLIENT.clientSecret);
    expect(text).not.toContain(FAKE_CLIENT.apiKey);
    const status = JSON.parse(text) as VolvoStatusDto & { redirectUri: string };
    expect(status).toMatchObject({ configured: true, connected: false, apiKeyLast4: "1234" });
    expect(status.redirectUri).toBe("https://x/api/v1/auth/volvo/callback");
  });

  it("connects end to end and registers the grant's car", async () => {
    const cookie = await login();
    await saveCredentials(cookie);
    const callback = await connect(cookie);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/settings?volvo=connected");

    const car = await env.DB.prepare("SELECT id, provider, account FROM cars WHERE vin = ?").bind(VIN).first();
    expect(car).toEqual({ id: CAR_ID, provider: "volvo", account: "volvo" });
    const settings = await env.DB.prepare("SELECT enabled FROM car_settings WHERE car_id = ?").bind(CAR_ID).first();
    expect(settings).toEqual({ enabled: 1 });

    const session = (await (await authed(cookie, "/api/v1/session")).json()) as SessionInfo;
    expect(session.connected).toBe(true);
    expect(session.volvo).toMatchObject({ connected: true, refreshExpiresAt: expect.any(Number) });
    const accounts = (await (await authed(cookie, "/api/v1/accounts")).json()) as { name: string; cars: number }[];
    expect(accounts.find((a) => a.name === "volvo")).toMatchObject({ signedIn: true, cars: 1 });
  });

  it("refuses a callback that did not start in this browser, and a state used twice", async () => {
    const cookie = await login();
    await saveCredentials(cookie);
    const start = await authed(cookie, "/api/v1/auth/volvo/start", { redirect: "manual" });
    const { code, state } = fake.consent(start.headers.get("location")!);
    const foreign = await authed(cookie, `/api/v1/auth/volvo/callback?state=${state}&code=${code}`, {
      redirect: "manual",
    });
    expect(foreign.headers.get("location")).toBe("/settings?volvo=state_mismatch");

    const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const replay = () =>
      authed(cookie, `/api/v1/auth/volvo/callback?state=${state}&code=${code}`, {
        redirect: "manual",
        headers: { cookie: `${cookie}; ${stateCookie}` },
      });
    expect((await replay()).headers.get("location")).toBe("/settings?volvo=connected");
    expect((await replay()).headers.get("location")).toBe("/settings?volvo=failed");
  });

  it("keeps the grant when the key is refused, so fixing the key needs no new consent", async () => {
    const cookie = await login();
    await saveCredentials(cookie, { ...FAKE_CLIENT, apiKey: "wrong-key" });
    const callback = await connect(cookie);
    expect(callback.headers.get("location")).toBe("/settings?volvo=key_refused");
    expect((await env.DB.prepare("SELECT provider FROM cars WHERE vin = ?").bind(VIN).first())?.provider).toBe("tesla");

    await saveCredentials(cookie, { clientId: FAKE_CLIENT.clientId, apiKey: FAKE_CLIENT.apiKey });
    const found = await authed(cookie, "/api/v1/volvo/vehicles", { method: "POST" });
    expect(await found.json()).toEqual({ outcome: "connected", vins: 1 });
  });

  it("says when the Volvo ID consent was refused or the app is not set up", async () => {
    const cookie = await login();
    const unconfigured = await authed(cookie, "/api/v1/auth/volvo/start", { redirect: "manual" });
    expect(unconfigured.headers.get("location")).toBe("/settings?volvo=not_configured");
    const denied = await authed(cookie, "/api/v1/auth/volvo/callback?error=access_denied&state=x", {
      redirect: "manual",
    });
    expect(denied.headers.get("location")).toBe("/settings?volvo=denied");
  });

  it("revokes at Volvo ID on disconnect and keeps the credentials", async () => {
    const cookie = await login();
    await saveCredentials(cookie);
    await connect(cookie);
    expect((await authed(cookie, "/api/v1/volvo/connection", { method: "DELETE" })).status).toBe(204);
    expect(fake.calls).toContain("POST /realms/volvocars/protocol/openid-connect/revoke");
    const status = (await (await authed(cookie, "/api/v1/volvo")).json()) as VolvoStatusDto;
    expect(status).toMatchObject({ configured: true, connected: false });
  });

  it("is unauthenticated nowhere", async () => {
    for (const path of [
      "/api/v1/volvo",
      "/api/v1/auth/volvo/start",
      "/api/v1/auth/volvo/callback",
      "/api/v1/accounts",
    ]) {
      expect((await SELF.fetch(`https://x${path}`, { redirect: "manual" })).status, path).toBe(401);
    }
  });
});
