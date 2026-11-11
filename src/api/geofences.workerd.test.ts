import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChargeDetailDto, DriveListDto, GeofenceDto } from "@shared/api-types";
import { authed, getJson, login } from "../../test/http";
import { resetLoggedCar, seedCharge, seedDrive } from "../../test/seed";

/** HTTP tests for named places: CRUD, drive labelling, tariffs and repricing. */

const CAR_ID = 7;
const T0 = 1_760_000_000_000;

describe("geofences API", () => {
  beforeEach(() => resetLoggedCar(CAR_ID, { efficiency: 0.15, insertedAt: T0 }));

  async function create(cookie: string, overrides: Record<string, unknown> = {}) {
    const res = await authed(cookie, "/api/v1/geofences", {
      method: "POST",
      body: JSON.stringify({ name: "Home", latitude: 52.52, longitude: 13.4, radius: 2000, ...overrides }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: number }).id;
  }

  it("creates, lists, updates and deletes", async () => {
    const cookie = await login();
    const id = await create(cookie);

    let list = (await (await authed(cookie, "/api/v1/geofences")).json()) as GeofenceDto[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Home", radius: 2000, tariff: [], timezone: null });

    const update = await authed(cookie, `/api/v1/geofences/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Casa",
        latitude: 52.52,
        longitude: 13.4,
        radius: 300,
        tariff: [{ validFrom: "2026-01-01", billingType: "per_minute", rate: 0.05 }],
      }),
    });
    expect(update.status).toBe(200);
    list = (await (await authed(cookie, "/api/v1/geofences")).json()) as GeofenceDto[];
    expect(list[0]).toMatchObject({
      name: "Casa",
      radius: 300,
      tariff: [{ validFrom: "2026-01-01", billingType: "per_minute", rate: 0.05, sessionFeeCents: null, windows: [] }],
    });

    expect((await authed(cookie, `/api/v1/geofences/${id}`, { method: "DELETE" })).status).toBe(204);
    list = (await (await authed(cookie, "/api/v1/geofences")).json()) as GeofenceDto[];
    expect(list).toHaveLength(0);
  });

  it("rejects an invalid radius or missing name", async () => {
    const cookie = await login();
    for (const patch of [{ radius: 0 }, { radius: 5000 }, { name: "" }]) {
      const res = await authed(cookie, "/api/v1/geofences", {
        method: "POST",
        body: JSON.stringify({ name: "X", latitude: 1, longitude: 1, radius: 100, ...patch }),
      });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
  });

  it("labels existing drives when a geofence is created", async () => {
    const cookie = await login();
    await seedDrive(CAR_ID, { startAt: T0, startLat: 52.52 });
    let drives = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(drives.drives[0]!.startLabel).toBeNull();

    await create(cookie);
    drives = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(drives.drives[0]!.startLabel).toBe("Home");
  });

  it("unlabels drives when the geofence is deleted", async () => {
    const cookie = await login();
    await seedDrive(CAR_ID, { startAt: T0, startLat: 52.52 });
    const id = await create(cookie);
    await authed(cookie, `/api/v1/geofences/${id}`, { method: "DELETE" });
    const drives = (await (await authed(cookie, "/api/v1/drives")).json()) as DriveListDto;
    expect(drives.drives[0]!.startLabel).toBeNull();
  });

  it("404s unknown geofences", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/geofences/9999", { method: "DELETE" })).status).toBe(404);
    expect((await authed(cookie, "/api/v1/geofences/9999")).status).toBe(404);
    const body = JSON.stringify({ name: "X", latitude: 1, longitude: 1, radius: 100 });
    expect((await authed(cookie, "/api/v1/geofences/9999", { method: "PUT", body })).status).toBe(404);
  });
});

/** 20:00 Berlin (UTC+2) on Wednesday 1 July 2026. */
const EVENING = Date.UTC(2026, 6, 1, 18);
const HOUR = 3_600_000;
const NIGHT = { label: "Night", days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "06:00", months: null, rate: 0.1 };

function flat(validFrom: string, rate = 0.3, extra: Record<string, unknown> = {}) {
  return { validFrom, billingType: "per_kwh", rate, sessionFeeCents: null, windows: [], ...extra };
}

/**
 * A session whose samples are two, four hours apart — 20:00 and midnight — so
 * when its energy flowed between them is not known: the cheapest and dearest
 * placements within the car's 11.5 kW are a range.
 */
async function seedSparseCharge(carId: number, startAt: number, kwh = 30): Promise<number> {
  const position = await env.DB.prepare(
    "INSERT INTO positions (car_id, date_at, latitude, longitude) VALUES (?, ?, 52.52, 13.405) RETURNING id",
  )
    .bind(carId, startAt)
    .first<{ id: number }>();
  const cproc = await env.DB.prepare(
    "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, charge_energy_used, " +
      "duration_min, start_battery_level, end_battery_level, position_id) VALUES (?, ?, ?, ?, ?, 240, 30, 80, ?) RETURNING id",
  )
    .bind(carId, startAt, startAt + 4 * HOUR, kwh, kwh, position!.id)
    .first<{ id: number }>();
  for (const at of [startAt, startAt + 4 * HOUR]) {
    await env.DB.prepare(
      "INSERT INTO charges (charging_process_id, date_at, charge_energy_added, charger_power, ideal_battery_range_km, " +
        "fast_charger_present) VALUES (?, ?, 0, 11, 300, 0)",
    )
      .bind(cproc!.id, at)
      .run();
  }
  return cproc!.id;
}

async function costOf(id: number) {
  return env.DB.prepare(
    "SELECT cost_cents, cost_max_cents, cost_source, cost_stale FROM charging_processes WHERE id = ?",
  )
    .bind(id)
    .first<{
      cost_cents: number | null;
      cost_max_cents: number | null;
      cost_source: string | null;
      cost_stale: number;
    }>();
}

describe("geofence tariffs", () => {
  beforeEach(() => resetLoggedCar(CAR_ID, { efficiency: 0.15, insertedAt: T0 }));

  async function create(cookie: string, body: Record<string, unknown>) {
    const res = await authed(cookie, "/api/v1/geofences", {
      method: "POST",
      body: JSON.stringify({ name: "Home", latitude: 52.52, longitude: 13.405, radius: 500, ...body }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: number }).id;
  }

  async function update(cookie: string, id: number, body: Record<string, unknown>) {
    const res = await authed(cookie, `/api/v1/geofences/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Home", latitude: 52.52, longitude: 13.405, radius: 500, ...body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: number; repricing: number };
  }

  it("prices the sessions a new place covers, and none before the tariff's first day", async () => {
    const cookie = await login();
    const before = await seedCharge(CAR_ID, { startAt: Date.UTC(2026, 5, 1, 12) });
    const after = await seedCharge(CAR_ID, { startAt: EVENING });
    const id = await create(cookie, { timezone: "Europe/Berlin", tariff: [flat("2026-06-15")] });

    // 11 kWh drawn at 0.30.
    expect(await costOf(after)).toMatchObject({ cost_cents: 330, cost_max_cents: null, cost_source: "tariff" });
    expect(await costOf(before)).toMatchObject({ cost_cents: null, cost_source: null });

    const place = await getJson<GeofenceDto>(cookie, `/api/v1/geofences/${id}`);
    expect(place).toMatchObject({
      timezone: "Europe/Berlin",
      firstChargeDate: "2026-06-01",
      chargesBeforeTariff: 1,
      repricing: 0,
    });
  });

  it("starting the tariff on the first charge's day prices the earlier sessions too", async () => {
    const cookie = await login();
    const before = await seedCharge(CAR_ID, { startAt: Date.UTC(2026, 5, 1, 12) });
    const id = await create(cookie, { tariff: [flat("2026-06-15")] });
    await update(cookie, id, { tariff: [flat("2026-06-01")] });
    expect(await costOf(before)).toMatchObject({ cost_cents: 330, cost_source: "tariff" });
  });

  it("prices an off-peak night as a range where the samples do not say when the energy flowed", async () => {
    const cookie = await login();
    // A Model 3: its onboard charger takes at most 11.5 kW.
    await env.DB.prepare("UPDATE cars SET model = '3' WHERE id = ?").bind(CAR_ID).run();
    const id = await seedSparseCharge(CAR_ID, EVENING);
    const tariff = [flat("2026-01-01", 0.3, { windows: [NIGHT] })];
    const placeId = await create(cookie, { timezone: "Europe/Berlin", tariff });

    const charge = await getJson<ChargeDetailDto>(cookie, `/api/v1/charges/${id}`);
    // 30 kWh between 20:00 and 24:00. Cheapest: 23 kWh in the two night hours
    // (2 h at 11.5 kW), 7 by day; dearest: 23 kWh in the day hours, 7 at night.
    expect(charge.costCents).toBe(Math.round((7 * 0.3 + 23 * 0.1) * 100));
    expect(charge.costMaxCents).toBe(Math.round((23 * 0.3 + 7 * 0.1) * 100));
    expect(charge.costSource).toBe("tariff");
    expect(charge.costDetail).toMatchObject({ priceFrom: "2026-01-01", billingType: "per_kwh", estimated: false });
    expect(charge.costDetail!.parts.map((p) => p.label)).toEqual([null, "Night"]);

    // The charger here is known to give 9 kW: 18 kWh fit in two hours, and the range narrows.
    await update(cookie, placeId, { timezone: "Europe/Berlin", chargerPowerKw: 9, tariff });
    const narrowed = await getJson<ChargeDetailDto>(cookie, `/api/v1/charges/${id}`);
    expect(narrowed.costCents).toBe(Math.round((12 * 0.3 + 18 * 0.1) * 100));
    expect(narrowed.costMaxCents).toBe(Math.round((18 * 0.3 + 12 * 0.1) * 100));
  });

  it("leaves older sessions alone when a new price starts, and reprices only a corrected price's days", async () => {
    const cookie = await login();
    const old = await seedCharge(CAR_ID, { startAt: Date.UTC(2026, 2, 1, 12) });
    const recent = await seedCharge(CAR_ID, { startAt: EVENING });
    const id = await create(cookie, { tariff: [flat("2026-01-01", 0.3)] });
    expect(await costOf(old)).toMatchObject({ cost_cents: 330 });

    // A new price from June: only the July session changes.
    const v2 = [flat("2026-01-01", 0.3), flat("2026-06-01", 0.4)];
    await update(cookie, id, { tariff: v2 });
    expect(await costOf(old)).toMatchObject({ cost_cents: 330 });
    expect(await costOf(recent)).toMatchObject({ cost_cents: 440 });

    // Correcting the first price touches the March session, not the July one.
    await env.DB.prepare("UPDATE charging_processes SET cost_cents = 1 WHERE id = ?").bind(recent).run();
    await update(cookie, id, { tariff: [flat("2026-01-01", 0.35), flat("2026-06-01", 0.4)] });
    expect(await costOf(old)).toMatchObject({ cost_cents: 385 });
    expect(await costOf(recent)).toMatchObject({ cost_cents: 1 });

    // An update that leaves the tariff out keeps it.
    await update(cookie, id, {});
    const place = await getJson<GeofenceDto>(cookie, `/api/v1/geofences/${id}`);
    expect(place.tariff.map((p) => p.rate)).toEqual([0.35, 0.4]);
  });

  it("never touches a manual cost, and clearing it lets the tariff price the session again", async () => {
    const cookie = await login();
    const chargeId = await seedCharge(CAR_ID, { startAt: EVENING });
    const put = await authed(cookie, `/api/v1/charges/${chargeId}/cost`, {
      method: "PUT",
      body: JSON.stringify({ value: 9.99, billedKwh: 12.5, note: "From the wallbox app" }),
    });
    expect(put.status).toBe(200);
    const id = await create(cookie, { tariff: [flat("2026-01-01")] });
    await update(cookie, id, { tariff: [flat("2026-01-01", 0.5)] });

    let charge = await getJson<ChargeDetailDto>(cookie, `/api/v1/charges/${chargeId}`);
    expect(charge).toMatchObject({
      costCents: 999,
      costSource: "manual",
      costBilledKwh: 12.5,
      costNote: "From the wallbox app",
      costDetail: null,
    });
    expect(charge.costPerKwhCents).toBeCloseTo(999 / 12.5);

    const cleared = await authed(cookie, `/api/v1/charges/${chargeId}/cost`, {
      method: "PUT",
      body: JSON.stringify({ value: null }),
    });
    expect(await cleared.json()).toMatchObject({ costCents: 550 });
    charge = await getJson<ChargeDetailDto>(cookie, `/api/v1/charges/${chargeId}`);
    expect(charge).toMatchObject({ costCents: 550, costSource: "tariff", costNote: null });
  });

  it("reprices a session that moves to another place when a place moves", async () => {
    const cookie = await login();
    const chargeId = await seedCharge(CAR_ID, { startAt: EVENING });
    const id = await create(cookie, { tariff: [flat("2026-01-01", 0.3)] });
    expect(await costOf(chargeId)).toMatchObject({ cost_cents: 330 });
    // Moved a long way off: the session is no longer inside it.
    await update(cookie, id, { latitude: 48.1, longitude: 11.5, tariff: [flat("2026-01-01", 0.3)] });
    expect(await costOf(chargeId)).toMatchObject({ cost_cents: null, cost_source: null });
  });

  it("converts a flat price from before tariffs into one dated price on first read", async () => {
    const cookie = await login();
    const first = await seedCharge(CAR_ID, { startAt: Date.UTC(2026, 2, 1, 23, 30) });
    await env.DB.prepare(
      "INSERT INTO geofences (id, name, latitude, longitude, radius, billing_type, cost_per_unit, session_fee_cents, " +
        "timezone, inserted_at, updated_at) VALUES (77, 'Old', 52.52, 13.405, 500, 'per_kwh', 0.3, 100, 'Europe/Berlin', 0, ?)",
    )
      .bind(EVENING)
      .run();
    await env.DB.prepare(
      "UPDATE charging_processes SET geofence_id = 77, cost_cents = 430, cost_source = 'legacy' WHERE id = ?",
    )
      .bind(first)
      .run();

    const place = await getJson<GeofenceDto>(cookie, "/api/v1/geofences/77");
    // The first priced session's local day: 00:30 on 2 March in Berlin.
    expect(place.tariff).toEqual([
      { validFrom: "2026-03-02", billingType: "per_kwh", rate: 0.3, sessionFeeCents: 100, windows: [] },
    ]);
  });

  it("rejects a tariff it cannot read", async () => {
    const cookie = await login();
    for (const tariff of [
      [flat("2026-02-30")],
      [flat("2026-01-01"), flat("2026-01-01")],
      [flat("2026-01-01", 0.3, { windows: [{ ...NIGHT, start: "25:00" }] })],
      [flat("2026-01-01", 0.3, { windows: [{ ...NIGHT, days: [] }] })],
    ]) {
      const res = await authed(cookie, "/api/v1/geofences", {
        method: "POST",
        body: JSON.stringify({ name: "X", latitude: 1, longitude: 1, radius: 100, tariff }),
      });
      expect(res.status, JSON.stringify(tariff)).toBe(400);
    }
    const res = await authed(cookie, "/api/v1/geofences", {
      method: "POST",
      body: JSON.stringify({ name: "X", latitude: 1, longitude: 1, radius: 100, timezone: "Mars/Olympus" }),
    });
    expect(res.status).toBe(400);
  });
});
