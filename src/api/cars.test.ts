import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCar } from "../../test/db";
import { authed, login } from "../../test/http";

/** HTTP tests for the vehicle list, live summaries and the logging switches. */

const CAR_ID = 43;

describe("cars and summaries", () => {
  beforeEach(() => resetCar(CAR_ID));

  it("lists cars", async () => {
    const cookie = await login();
    const body = (await (await authed(cookie, "/api/v1/cars")).json()) as unknown[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: CAR_ID, vin: "VIN1", name: "Bro", logged: true });
  });

  /** The overview shows only the cars being logged, and reads this to know which. */
  it("says a car is not logged once its switch is off", async () => {
    const cookie = await login();
    await env.DB.prepare("UPDATE car_settings SET enabled = 0 WHERE car_id = ?").bind(CAR_ID).run();

    const body = (await (await authed(cookie, "/api/v1/cars")).json()) as unknown[];
    expect(body[0]).toMatchObject({ id: CAR_ID, logged: false });
  });

  /** An import creates the car before its settings, and left join keeps it listed. */
  it("lists a car with no settings row, as not logged", async () => {
    const cookie = await login();
    await env.DB.prepare("DELETE FROM car_settings WHERE car_id = ?").bind(CAR_ID).run();

    const body = (await (await authed(cookie, "/api/v1/cars")).json()) as { id: number; logged: boolean }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: CAR_ID, logged: false });
  });

  it("returns an empty summary list before any car has been polled", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/summaries");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("refuses to suspend a car that is not being logged", async () => {
    const cookie = await login();
    const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/logging/suspend`, { method: "PUT" });
    expect(res.status).toBe(412);
    expect((await res.json()) as { message: string }).toHaveProperty("message");
  });

  it("validates the car id on logging routes", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/cars/nope/logging/resume", { method: "PUT" })).status).toBe(400);
  });

  it("validates the car id on command routes", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/cars/nope/wake", { method: "POST" })).status).toBe(400);
    expect((await authed(cookie, "/api/v1/cars/nope/navigation", { method: "POST" })).status).toBe(400);
  });

  it("refuses to wake a car that is not being logged", async () => {
    const cookie = await login();
    const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/wake`, { method: "POST" });
    expect(res.status).toBe(412);
    expect((await res.json()) as { message: string }).toHaveProperty("message");
  });

  it("rejects a navigation request without a destination", async () => {
    const cookie = await login();
    for (const body of [undefined, "{}", '{"destination":"   "}', '{"destination":42}', "not json"]) {
      const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/navigation`, { method: "POST", body });
      expect(res.status).toBe(400);
    }
  });

  it("passes a navigation refusal through as a 412", async () => {
    const cookie = await login();
    const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/navigation`, {
      method: "POST",
      body: JSON.stringify({ destination: "Berliner Str. 1" }),
    });
    expect(res.status).toBe(412);
    expect((await res.json()) as { message: string }).toHaveProperty("message");
  });
});
