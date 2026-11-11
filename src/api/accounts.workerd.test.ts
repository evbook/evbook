import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDto } from "@shared/api-types";
import { clearDurableObject, clearTables } from "../../test/db";
import { authed, login } from "../../test/http";

/**
 * More than one Tesla account: each is its own auth actor with its own tokens,
 * and its cars are registered through it.
 */

const FIRST = { id: 81, vin: "5YJ3E7EB0LF000081" };
const SECOND = { id: 82, vin: "5YJ3E7EB0LF000082" };

/** A Tesla that hands every token pair a different car list. */
function fakeTesla() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/token")) {
      const body = String(init?.body ?? "");
      const which = body.includes("refresh-2") ? "2" : "1";
      return Response.json({ access_token: `access-${which}`, refresh_token: `refresh-${which}`, expires_in: 28_800 });
    }
    if (url.includes("/api/1/products")) {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      const car = headers.get("authorization")?.includes("access-2") ? SECOND : FIRST;
      return Response.json({
        response: [{ id: car.id * 10, vehicle_id: car.id * 100, vin: car.vin, display_name: `Car ${car.id}` }],
      });
    }
    throw new Error(`unexpected request to ${url}`);
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await clearDurableObject(() => env.AUTH_DO.getByName("default"));
  for (const car of [FIRST, SECOND]) await clearDurableObject(() => env.VEHICLE_DO.getByName(`car:${car.id}`));
  await clearTables("accounts", "positions", "states", "charging_processes", "drives", "cars");
  const now = Date.now();
  // Ids fixed up front so the upsert lands on cars this file owns.
  for (const car of [FIRST, SECOND]) {
    await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(car.id, car.vin, now, now)
      .run();
  }
  fakeTesla();
});

afterEach(async () => {
  for (const car of [FIRST, SECOND]) await clearDurableObject(() => env.VEHICLE_DO.getByName(`car:${car.id}`));
  const rows = await env.DB.prepare("SELECT name FROM accounts").all<{ name: string }>();
  for (const row of rows.results) await clearDurableObject(() => env.AUTH_DO.getByName(row.name));
  vi.restoreAllMocks();
});

describe("Tesla accounts", () => {
  it("connects the original account first, then adds a second beside it", async () => {
    const cookie = await login();
    const first = await authed(cookie, "/api/v1/accounts/tesla", {
      method: "POST",
      body: JSON.stringify({ access: "a", refresh: "refresh-1" }),
    });
    expect(((await first.json()) as { account: string }).account).toBe("default");

    const second = await authed(cookie, "/api/v1/accounts/tesla", {
      method: "POST",
      body: JSON.stringify({ access: "a", refresh: "refresh-2", label: "Work" }),
    });
    const name = ((await second.json()) as { account: string }).account;
    expect(name).toMatch(/^tesla-/);

    const cars = await env.DB.prepare("SELECT id, account FROM cars ORDER BY id").all();
    expect(cars.results).toEqual([
      { id: FIRST.id, account: "default" },
      { id: SECOND.id, account: name },
    ]);
    const accounts = (await (await authed(cookie, "/api/v1/accounts")).json()) as AccountDto[];
    expect(accounts.map((a) => [a.name === name ? "second" : a.name, a.label, a.signedIn, a.cars])).toEqual([
      ["default", null, true, 1],
      ["second", "Work", true, 1],
    ]);
    // Only the original account is mirrored to the tokens table.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM tokens").first<{ n: number }>())!.n).toBeLessThanOrEqual(1);

    expect((await authed(cookie, `/api/v1/accounts/${name}`, { method: "DELETE" })).status).toBe(204);
    const after = (await (await authed(cookie, "/api/v1/accounts")).json()) as AccountDto[];
    expect(after.map((a) => a.name)).toEqual(["default"]);
    // The car and its history stay.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM cars").first<{ n: number }>())!.n).toBe(2);
  });

  it("refuses to remove the original or the Volvo account from here", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/accounts/default", { method: "DELETE" })).status).toBe(400);
    expect((await authed(cookie, "/api/v1/accounts/volvo", { method: "DELETE" })).status).toBe(400);
    expect((await authed(cookie, "/api/v1/accounts/tesla-nope", { method: "DELETE" })).status).toBe(404);
  });

  it("refuses tokens Tesla does not accept", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 401 }));
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/accounts/tesla", {
      method: "POST",
      body: JSON.stringify({ access: "a", refresh: "bad" }),
    });
    expect(res.status).toBe(422);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>())!.n).toBe(0);
  });
});
