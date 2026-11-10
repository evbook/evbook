import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CarSettingsDto, GlobalSettingsDto } from "@shared/api-types";
import { resetCar } from "../../test/db";
import { authed, login } from "../../test/http";

/** HTTP tests for the global and per-car settings endpoints. */

const CAR_ID = 42;

describe("global settings", () => {
  beforeEach(() => resetCar(CAR_ID));

  it("returns defaults", async () => {
    const cookie = await login();
    const body = (await (await authed(cookie, "/api/v1/settings")).json()) as GlobalSettingsDto;
    expect(body).toMatchObject({
      unitOfLength: "km",
      unitOfTemperature: "C",
      preferredRange: "rated",
      currency: "EUR",
      // The test pool binds an R2 bucket; storing in it is still opt-in.
      documentStorage: "database",
      documentBucket: "r2",
    });
  });

  it("round-trips the currency", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ currency: "USD" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as GlobalSettingsDto).currency).toBe("USD");
    await env.DB.prepare("UPDATE settings SET currency = 'EUR' WHERE id = 1").run();
  });

  it("falls back when the column holds a code the app does not know", async () => {
    // The column carries no CHECK (SQLite cannot add one), so a hand-edited or
    // future value must not reach the formatter, which throws on a bad code.
    await env.DB.prepare("UPDATE settings SET currency = 'XYZ' WHERE id = 1").run();
    try {
      const cookie = await login();
      const body = (await (await authed(cookie, "/api/v1/settings")).json()) as GlobalSettingsDto;
      expect(body.currency).toBe("EUR");
    } finally {
      // The settings row is a singleton the whole suite shares, and `resetCar`
      // does not touch it.
      await env.DB.prepare("UPDATE settings SET currency = 'EUR' WHERE id = 1").run();
    }
  });

  it("applies a partial update and leaves the rest alone", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ unitOfLength: "mi" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GlobalSettingsDto;
    expect(body.unitOfLength).toBe("mi");
    expect(body.unitOfTemperature).toBe("C");
  });

  it("tells the untouched UTC default apart from a chosen zone", async () => {
    const cookie = await login();
    const read = async () => (await (await authed(cookie, "/api/v1/settings")).json()) as GlobalSettingsDto;
    try {
      // A fresh install: the column default, which nobody picked.
      expect(await read()).toMatchObject({ timezone: "UTC", timezoneChosen: false });

      // Saving UTC on purpose is a choice, and it must stick as one.
      const res = await authed(cookie, "/api/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ timezone: "UTC" }),
      });
      expect(((await res.json()) as GlobalSettingsDto).timezoneChosen).toBe(true);

      // Any other zone counts as chosen even without the flag — an install from
      // before the column, or the demo's seed.
      await env.DB.prepare("UPDATE settings SET timezone = 'Europe/Moscow', timezone_chosen = 0 WHERE id = 1").run();
      expect(await read()).toMatchObject({ timezone: "Europe/Moscow", timezoneChosen: true });
    } finally {
      await env.DB.prepare("UPDATE settings SET timezone = 'UTC', timezone_chosen = 0 WHERE id = 1").run();
    }
  });

  it("rejects invalid values", async () => {
    const cookie = await login();
    for (const patch of [
      { unitOfLength: "parsecs" },
      { preferredRange: "vibes" },
      { timezone: "" },
      { currency: "doubloons" },
      { currency: "eur" },
    ]) {
      const res = await authed(cookie, "/api/v1/settings", { method: "PUT", body: JSON.stringify(patch) });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
  });

  it("recalculates efficiency when the preferred range changes", async () => {
    const cookie = await login();
    // Eight comparable sessions imply 0.15 kWh per ideal-range km.
    for (let i = 0; i < 8; i++) {
      await env.DB.prepare(
        "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, duration_min, " +
          "end_battery_level, start_ideal_range_km, end_ideal_range_km) VALUES (?, ?, ?, 15, 60, 80, 100, 200)",
      )
        .bind(CAR_ID, Date.now() + i * 1000, Date.now() + i * 1000 + 60_000)
        .run();
    }
    // Rated ranges are absent, so efficiency is unknown until we switch.
    const before = await env.DB.prepare("SELECT efficiency FROM cars WHERE id = ?")
      .bind(CAR_ID)
      .first<{ efficiency: number | null }>();
    expect(before?.efficiency).toBeNull();

    const res = await authed(cookie, "/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ preferredRange: "ideal" }),
    });
    expect(res.status).toBe(200);
    const after = await env.DB.prepare("SELECT efficiency FROM cars WHERE id = ?")
      .bind(CAR_ID)
      .first<{ efficiency: number | null }>();
    expect(after?.efficiency).toBeCloseTo(0.15, 5);
  });
});

describe("car settings", () => {
  beforeEach(() => resetCar(CAR_ID));

  it("returns the per-car defaults", async () => {
    const cookie = await login();
    const body = (await (await authed(cookie, `/api/v1/cars/${CAR_ID}/settings`)).json()) as CarSettingsDto;
    expect(body).toMatchObject({
      carId: CAR_ID,
      enabled: true,
      suspendMin: 21,
      suspendAfterIdleMin: 15,
      reqNotUnlocked: false,
    });
  });

  it("round-trips booleans and numbers", async () => {
    const cookie = await login();
    const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/settings`, {
      method: "PUT",
      body: JSON.stringify({ reqNotUnlocked: true, suspendMin: 30, freeSupercharging: true }),
    });
    const body = (await res.json()) as CarSettingsDto;
    expect(body).toMatchObject({ reqNotUnlocked: true, suspendMin: 30, freeSupercharging: true });
  });

  it("round-trips the as-new capacity pick, and null hands it back to the VIN", async () => {
    const cookie = await login();
    const set = await authed(cookie, `/api/v1/cars/${CAR_ID}/settings`, {
      method: "PUT",
      body: JSON.stringify({ usableWhenNewKwh: 74 }),
    });
    expect(((await set.json()) as CarSettingsDto).usableWhenNewKwh).toBe(74);

    const clear = await authed(cookie, `/api/v1/cars/${CAR_ID}/settings`, {
      method: "PUT",
      body: JSON.stringify({ usableWhenNewKwh: null }),
    });
    expect(((await clear.json()) as CarSettingsDto).usableWhenNewKwh).toBeNull();
  });

  it("rejects an implausible as-new capacity", async () => {
    const cookie = await login();
    for (const usableWhenNewKwh of [5, 400]) {
      const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/settings`, {
        method: "PUT",
        body: JSON.stringify({ usableWhenNewKwh }),
      });
      expect(res.status, String(usableWhenNewKwh)).toBe(400);
    }
  });

  it("rejects sleep timings outside the safe range", async () => {
    const cookie = await login();
    for (const patch of [{ suspendMin: 1 }, { suspendMin: 500 }, { suspendAfterIdleMin: 0 }]) {
      const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/settings`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
  });

  it("404s for an unknown car", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/cars/424242/settings")).status).toBe(404);
    const res = await authed(cookie, "/api/v1/cars/424242/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a non-numeric car id", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/cars/abc/settings")).status).toBe(400);
  });

  it("stops the logging loop when a car is disabled", async () => {
    const cookie = await login();
    await authed(cookie, `/api/v1/cars/${CAR_ID}/logging/resume`, { method: "PUT" });
    const res = await authed(cookie, `/api/v1/cars/${CAR_ID}/settings`, {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CarSettingsDto).enabled).toBe(false);
  });
});
