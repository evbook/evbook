import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChargeDetailDto, ChargeListDto, ChargeMapDto } from "@shared/api-types";
import { authed, getJson, login } from "../../test/http";
import { resetLoggedCar, seedCharge, seedComparableCharge, seedGeofence } from "../../test/seed";

/** HTTP tests for the charging session list, detail and cost editing. */

/** Sessions with a full sample track, for detail and costing. */
const DETAIL_CAR = 7;
/** Sessions that differ on energy, duration and cost, for sorting and filters. */
const SORT_CAR = 12;
const T0 = 1_760_000_000_000;
const TS = 1_770_000_000_000;
const DAY = 86_400_000;

describe("charges API", () => {
  beforeEach(() => resetLoggedCar(DETAIL_CAR, { efficiency: 0.15, insertedAt: T0 }));

  it("lists sessions with totals", async () => {
    const cookie = await login();
    await seedCharge(DETAIL_CAR, { startAt: T0 });
    const body = (await (await authed(cookie, "/api/v1/charges")).json()) as ChargeListDto;
    expect(body.charges).toHaveLength(1);
    expect(body.totals.energyAddedKwh).toBeCloseTo(10, 5);
    expect(body.charges[0]!.currentType).toBe("ac");
  });

  it("lists a charge nobody saw, with its cost as a range and its energy unknown", async () => {
    const cookie = await login();
    await seedCharge(DETAIL_CAR, { startAt: T0 });
    await env.DB.prepare("UPDATE charging_processes SET cost_cents = 0").run();
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, start_after_at, start_before_at, " +
        "end_after_at, end_before_at, start_battery_level, end_battery_level, cost_cents, cost_max_cents, reconstructed) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 40, 80, 524, 579, 1)",
    )
      .bind(DETAIL_CAR, T0 + DAY, T0 + 2 * DAY, T0 + DAY, T0 + 2 * DAY, T0 + DAY, T0 + 2 * DAY)
      .run();

    const body = (await (await authed(cookie, "/api/v1/charges?sort=date&dir=asc")).json()) as ChargeListDto;
    expect(body.charges).toHaveLength(2);
    // Free is a figure: 0, not null.
    expect(body.charges[0]).toMatchObject({ reconstructed: false, costCents: 0, costMaxCents: null });
    expect(body.charges[1]).toMatchObject({
      reconstructed: true,
      energyAddedKwh: null,
      durationMin: null,
      costCents: 524,
      costMaxCents: 579,
      startSpan: { after: T0 + DAY, before: T0 + 2 * DAY },
    });
    expect(body.totals).toMatchObject({ count: 2, costCents: 524, costMaxCents: 579, energyAddedCount: 1 });
  });

  /*
    The per-session averages on the list page divide by these, not by the session
    count: a cost is null unless something priced the session, and dividing the
    priced total by every session would read as though charging were nearly free.
  */
  it("counts how many sessions each total has a figure for", async () => {
    const cookie = await login();
    const priced = await seedCharge(DETAIL_CAR, { startAt: T0 });
    await seedCharge(DETAIL_CAR, { startAt: T0 + DAY });
    await env.DB.prepare("UPDATE charging_processes SET cost_cents = 1200 WHERE id = ?").bind(priced).run();
    await env.DB.prepare("UPDATE charging_processes SET charge_energy_added = NULL WHERE id = ?").bind(priced).run();

    const body = await getJson<ChargeListDto>(cookie, "/api/v1/charges");
    expect(body.totals).toMatchObject({ count: 2, energyAddedCount: 1, costCount: 1 });
  });

  it("classifies a session the car said had a fast charger as DC", async () => {
    const cookie = await login();
    await seedCharge(DETAIL_CAR, { startAt: T0, phases: null });
    const body = (await (await authed(cookie, "/api/v1/charges")).json()) as ChargeListDto;
    expect(body.charges[0]!.currentType).toBe("dc");
    expect(body.charges[0]!.chargerType).toBe("Combo");
  });

  /*
    Two ways the old rule — "no phase count means DC" — labelled home AC charging as
    DC. Both were reported from real data: a car that reports no phases on perfectly
    ordinary AC, and an evening where the car was plugged in and never drew a watt.
  */
  it("does not call AC charging DC just because no phase count was reported", async () => {
    const cookie = await login();
    // No fast charger on the other end: the phase count is simply missing.
    await seedCharge(DETAIL_CAR, { startAt: T0, phases: null, fastCharger: false });

    const body = (await (await authed(cookie, "/api/v1/charges")).json()) as ChargeListDto;
    expect(body.charges[0]!.currentType).toBe("ac");
  });

  it("leaves out a session that moved no energy", async () => {
    const cookie = await login();
    await seedCharge(DETAIL_CAR, { startAt: T0, energy: 12 });
    // Plugged in, nothing happened: no energy, and no sample ever drew power.
    await seedCharge(DETAIL_CAR, { startAt: T0 + DAY, energy: 0, phases: null });

    const body = (await (await authed(cookie, "/api/v1/charges")).json()) as ChargeListDto;
    // The real session only, and it is not somehow DC either.
    expect(body.charges).toHaveLength(1);
    expect(body.charges[0]!.energyAddedKwh).toBe(12);
    expect(body.totals.count).toBe(1);
  });

  it("filters by current type", async () => {
    const cookie = await login();
    await seedCharge(DETAIL_CAR, { startAt: T0, phases: 3 });
    await seedCharge(DETAIL_CAR, { startAt: T0 + DAY, phases: null });

    const dc = (await (await authed(cookie, "/api/v1/charges?currentType=dc")).json()) as ChargeListDto;
    expect(dc.charges).toHaveLength(1);
    const ac = (await (await authed(cookie, "/api/v1/charges?currentType=ac")).json()) as ChargeListDto;
    expect(ac.charges).toHaveLength(1);
  });

  it("returns detail with samples", async () => {
    const cookie = await login();
    const id = await seedCharge(DETAIL_CAR, { startAt: T0 });
    const body = (await (await authed(cookie, `/api/v1/charges/${id}`)).json()) as ChargeDetailDto;
    expect(body.samples).toHaveLength(5);
    expect(body.latitude).toBeCloseTo(52.52, 4);
    // The supply and the pack, per sample: what the charge charts are drawn from.
    expect(body.samples[0]).toMatchObject({
      voltage: 230,
      current: 16,
      batteryTempMin: 18,
      batteryTempMax: 19,
    });
    expect(body.samples[4]).toMatchObject({ batteryTempMin: 20, batteryTempMax: 21 });
  });

  /*
    The rows a session keeps at its edges are the plug's, not the charge's — a
    0 kW / 2 V reading before the ramp and another after completion. On the
    chart they drag the voltage and current axes to zero, so the detail trims
    them; a zero in the middle is a real interruption and stays.
  */
  it("trims the zero-power readings off the edges of the sample track", async () => {
    const cookie = await login();
    const id = await seedCharge(DETAIL_CAR, { startAt: T0 });
    for (const at of [T0 - 60_000, T0 + 5 * 60_000]) {
      await env.DB.prepare(
        "INSERT INTO charges (charging_process_id, date_at, battery_level, charge_energy_added, charger_power, " +
          "charger_voltage, charger_actual_current, ideal_battery_range_km) VALUES (?, ?, 50, 0, 0, 2, 0, 200)",
      )
        .bind(id, at)
        .run();
    }

    const body = (await (await authed(cookie, `/api/v1/charges/${id}`)).json()) as ChargeDetailDto;
    expect(body.samples).toHaveLength(5);
    expect(body.samples[0]!.powerKw).toBeGreaterThan(0);
    expect(body.samples[4]!.powerKw).toBeGreaterThan(0);

    // The CSV is the raw record and keeps every row: header + seven samples.
    const csv = await (await authed(cookie, `/api/v1/charges/${id}/csv`)).text();
    expect(csv.trim().split("\n")).toHaveLength(8);
  });

  it("exports the samples as CSV", async () => {
    const cookie = await login();
    const id = await seedCharge(DETAIL_CAR, { startAt: T0 });
    const res = await authed(cookie, `/api/v1/charges/${id}/csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");

    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(6); // header + five samples
    const header = lines[0]!.split(",");
    // A readable timestamp first, then every column the car reports.
    expect(header[0]).toBe("date");
    expect(header).toContain("charger_voltage");
    expect(header).toContain("battery_temp_max");
    // The first sample as seeded: 230 V at 16 A.
    expect(lines[1]).toContain('"230"');
    expect(lines[1]).toContain('"16"');
  });

  it("404s exporting an unknown session", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/charges/99999/csv")).status).toBe(404);
  });

  it("sets a total cost", async () => {
    const cookie = await login();
    const id = await seedCharge(DETAIL_CAR, { startAt: T0 });
    const res = await authed(cookie, `/api/v1/charges/${id}/cost`, {
      method: "PUT",
      body: JSON.stringify({ value: 12.34 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { costCents: number }).toMatchObject({ costCents: 1234 });
  });

  it("clears a cost when the total is null", async () => {
    const cookie = await login();
    const id = await seedCharge(DETAIL_CAR, { startAt: T0 });
    await authed(cookie, `/api/v1/charges/${id}/cost`, {
      method: "PUT",
      body: JSON.stringify({ value: 5 }),
    });
    await authed(cookie, `/api/v1/charges/${id}/cost`, {
      method: "PUT",
      body: JSON.stringify({ value: null }),
    });
    const body = (await (await authed(cookie, `/api/v1/charges/${id}`)).json()) as ChargeDetailDto;
    expect(body.costCents).toBeNull();
  });

  it("rejects a negative cost and a stray field", async () => {
    const cookie = await login();
    const id = await seedCharge(DETAIL_CAR, { startAt: T0 });
    // The mode variant is the endpoint's old shape — gone, not silently accepted.
    for (const patch of [{ value: -1 }, { mode: "per_kwh", value: 1 }]) {
      const res = await authed(cookie, `/api/v1/charges/${id}/cost`, { method: "PUT", body: JSON.stringify(patch) });
      expect(res.status, JSON.stringify(patch)).toBe(400);
    }
  });

  it("404s costing an unknown session", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/charges/99999/cost", {
      method: "PUT",
      body: JSON.stringify({ value: 1 }),
    });
    expect(res.status).toBe(404);
  });

  // The composition rules are covered once, on drives; this is the wiring.
  it("locates a session by street and town, and by its geofence when it has one", async () => {
    const cookie = await login();
    const id = await seedCharge(DETAIL_CAR, { startAt: T0 });
    const address = await env.DB.prepare(
      "INSERT INTO addresses (road, house_number, city, display_name, latitude, longitude, inserted_at, updated_at) " +
        "VALUES ('Torstraße', '1', 'Berlin', 'Torstraße 1, 10119 Berlin, Germany', 52.5, 13.4, 0, 0) RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare("UPDATE charging_processes SET address_id = ? WHERE id = ?").bind(address!.id, id).run();

    const located = await getJson<ChargeListDto>(cookie, "/api/v1/charges");
    expect(located.charges[0]!.label).toBe("Torstraße 1");
    expect(located.charges[0]!.region).toBe("Berlin");

    // A geofence is the owner's own name for the place and stands on its own.
    const geofence = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4 });
    await env.DB.prepare("UPDATE charging_processes SET geofence_id = ? WHERE id = ?").bind(geofence, id).run();
    const named = await getJson<ChargeListDto>(cookie, "/api/v1/charges");
    expect(named.charges[0]!.label).toBe("Home");
    expect(named.charges[0]!.region).toBeNull();
  });
});

describe("charge sorting and ranges", () => {
  beforeEach(() => resetLoggedCar(SORT_CAR, { efficiency: 0.2 }));

  async function seedSortableCharges() {
    await seedComparableCharge(SORT_CAR, { at: TS, energy: 10, durationMin: 30, costCents: 300 });
    await seedComparableCharge(SORT_CAR, { at: TS + DAY, energy: 50, durationMin: 90, costCents: 1500 });
    await seedComparableCharge(SORT_CAR, { at: TS + 2 * DAY, energy: 25, durationMin: 60, costCents: null });
  }

  it("sorts by energy and by cost", async () => {
    const cookie = await login();
    await seedSortableCharges();
    const byEnergy = await getJson<ChargeListDto>(cookie, "/api/v1/charges?sort=energy&dir=asc");
    expect(byEnergy.charges.map((c) => c.energyAddedKwh)).toEqual([10, 25, 50]);

    const byCost = await getJson<ChargeListDto>(cookie, "/api/v1/charges?sort=cost&dir=desc");
    // Sessions with no cost sort last in both directions.
    expect(byCost.charges.map((c) => c.costCents)).toEqual([1500, 300, null]);
  });

  it("filters on an energy window", async () => {
    const cookie = await login();
    await seedSortableCharges();
    const body = await getJson<ChargeListDto>(cookie, "/api/v1/charges?minEnergyKwh=20&maxEnergyKwh=30");
    expect(body.charges.map((c) => c.energyAddedKwh)).toEqual([25]);
  });

  it("filters on a cost window in cents", async () => {
    const cookie = await login();
    await seedSortableCharges();
    const body = await getJson<ChargeListDto>(cookie, "/api/v1/charges?minCostCents=1000");
    expect(body.charges.map((c) => c.costCents)).toEqual([1500]);
  });

  it("filters on a duration window", async () => {
    const cookie = await login();
    await seedSortableCharges();
    const body = await getJson<ChargeListDto>(cookie, "/api/v1/charges?minDurationMin=45&maxDurationMin=75");
    expect(body.charges.map((c) => c.durationMin)).toEqual([60]);
  });

  it("carries the per-session aggregates onto a later page", async () => {
    const cookie = await login();
    await seedSortableCharges();
    // The page's rows are picked before the aggregates are computed, so an
    // offset must still land on the right session with its power and type.
    const body = await getJson<ChargeListDto>(cookie, "/api/v1/charges?limit=1&offset=1");
    expect(body.charges).toHaveLength(1);
    expect(body.charges[0]).toMatchObject({ energyAddedKwh: 50, maxPowerKw: 11, currentType: "ac" });
    expect(body.totals.count).toBe(3);
  });

  it("reports bounds for the sliders", async () => {
    const cookie = await login();
    await seedSortableCharges();
    const body = await getJson<ChargeListDto>(cookie, "/api/v1/charges");
    expect(body.bounds.energyKwh).toEqual({ min: 10, max: 50 });
    expect(body.bounds.costCents).toEqual({ min: 300, max: 1500 });
  });

  it("rejects an unknown sort column", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/charges?sort=cost--")).status).toBe(400);
  });
});

/** Where a session happened, as one of the places the owner named. */
describe("charge place filter", () => {
  const PLACE_CAR = 23;
  beforeEach(() => resetLoggedCar(PLACE_CAR));

  it("keeps the sessions at one place, and the map with them", async () => {
    const cookie = await login();
    const home = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4, radius: 200 });
    await seedCharge(PLACE_CAR, { startAt: T0, energy: 10, geofenceId: home, lat: 52.5, lng: 13.4 });
    await seedCharge(PLACE_CAR, { startAt: T0 + DAY, energy: 40, lat: 48.137, lng: 11.575 });

    const body = await getJson<ChargeListDto>(cookie, `/api/v1/charges?geofenceId=${home}`);
    expect(body.totals.count).toBe(1);
    expect(body.charges[0]!.label).toBe("Home");
    expect(body.totals.energyAddedKwh).toBe(10);

    // The map answers the same question as the list it sits above.
    const map = await getJson<ChargeMapDto>(cookie, `/api/v1/charges/map?geofenceId=${home}`);
    expect(map.points).toHaveLength(1);
    expect(map.points[0]).toMatchObject({ label: "Home", count: 1 });
  });

  it("leaves the sliders alone, so picking a place does not collapse them", async () => {
    const cookie = await login();
    const home = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4 });
    await seedCharge(PLACE_CAR, { startAt: T0, energy: 10, geofenceId: home });
    await seedCharge(PLACE_CAR, { startAt: T0 + DAY, energy: 40 });

    const body = await getJson<ChargeListDto>(cookie, `/api/v1/charges?geofenceId=${home}`);
    expect(body.bounds.energyKwh).toEqual({ min: 10, max: 40 });
  });
});

/** The map rolls the same filtered sessions up by place. */
describe("charge map", () => {
  const MAP_CAR = 21;
  beforeEach(() => resetLoggedCar(MAP_CAR));

  it("rolls repeated sessions at one spot into a single point", async () => {
    const cookie = await login();
    await seedCharge(MAP_CAR, { startAt: T0, energy: 10 });
    // A few metres of GPS drift is the same driveway, not a second charger.
    await seedCharge(MAP_CAR, { startAt: T0 + DAY, energy: 15, lat: 52.5201, lng: 13.4049 });

    const body = await getJson<ChargeMapDto>(cookie, "/api/v1/charges/map");
    expect(body.points).toHaveLength(1);
    expect(body.points[0]).toMatchObject({ count: 2, energyKwh: 25 });
    expect(body.points[0]!.latitude).toBeCloseTo(52.52, 3);
    expect(body.points[0]!.lastAt).toBe(T0 + DAY);
    expect(body.truncated).toBe(false);
  });

  it("keeps separate places apart, busiest first", async () => {
    const cookie = await login();
    await seedCharge(MAP_CAR, { startAt: T0 });
    await seedCharge(MAP_CAR, { startAt: T0 + DAY });
    await seedCharge(MAP_CAR, { startAt: T0 + 2 * DAY, lat: 48.137, lng: 11.575 });

    const body = await getJson<ChargeMapDto>(cookie, "/api/v1/charges/map");
    expect(body.points.map((p) => p.count)).toEqual([2, 1]);
    expect(body.points[1]!.latitude).toBeCloseTo(48.137, 3);
  });

  it("groups a geofence's sessions under its name and centre", async () => {
    const cookie = await login();
    const home = await seedGeofence({ name: "Home", latitude: 52.5, longitude: 13.4, radius: 200 });
    await seedCharge(MAP_CAR, { startAt: T0, geofenceId: home, lat: 52.4998, lng: 13.4008 });
    await seedCharge(MAP_CAR, { startAt: T0 + DAY, geofenceId: home, lat: 52.5005, lng: 13.3991 });

    const body = await getJson<ChargeMapDto>(cookie, "/api/v1/charges/map");
    expect(body.points).toHaveLength(1);
    expect(body.points[0]).toMatchObject({ label: "Home", count: 2, latitude: 52.5, longitude: 13.4 });
  });

  it("counts sessions with no coordinates instead of drawing them", async () => {
    const cookie = await login();
    await seedCharge(MAP_CAR, { startAt: T0 });
    await seedCharge(MAP_CAR, { startAt: T0 + DAY, located: false });

    const body = await getJson<ChargeMapDto>(cookie, "/api/v1/charges/map");
    expect(body.points).toHaveLength(1);
    expect(body.points[0]!.count).toBe(1);
    expect(body.unlocated).toBe(1);
  });

  it("narrows on the same filters as the list", async () => {
    const cookie = await login();
    await seedCharge(MAP_CAR, { startAt: T0, phases: 3 });
    await seedCharge(MAP_CAR, { startAt: T0 + DAY, phases: null, lat: 48.137, lng: 11.575 });

    const dc = await getJson<ChargeMapDto>(cookie, "/api/v1/charges/map?currentType=dc");
    expect(dc.points).toHaveLength(1);
    expect(dc.points[0]!.latitude).toBeCloseTo(48.137, 3);

    const window = await getJson<ChargeMapDto>(cookie, `/api/v1/charges/map?from=${T0}&to=${T0 + 1}`);
    expect(window.points.map((p) => p.count)).toEqual([1]);
  });

  it("rejects an invalid filter", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/charges/map?currentType=magic")).status).toBe(400);
  });
});
