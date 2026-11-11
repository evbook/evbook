import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetLoggedCar, seedCharge, seedGeofence } from "../../test/seed";
import { repriceCharge, repriceStale, staleCount } from "./pricing";

/** The repricing queue and the costs that predate tariffs. */

const CAR_ID = 31;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 3, 1, 10);
const FLAT = JSON.stringify([
  { validFrom: "2026-01-01", billingType: "per_kwh", rate: 0.3, sessionFeeCents: null, windows: [] },
]);

async function cost(id: number) {
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

describe("pricing", () => {
  let place: number;
  beforeEach(async () => {
    await resetLoggedCar(CAR_ID);
    place = await seedGeofence({ name: "Home", latitude: 52.52, longitude: 13.405 });
    await env.DB.prepare("UPDATE geofences SET tariff = ? WHERE id = ?").bind(FLAT, place).run();
  });

  it("works the queue off in batches, newest first, until none is left", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedCharge(CAR_ID, { startAt: T0 + i * DAY, geofenceId: place }));
    await env.DB.prepare("UPDATE charging_processes SET cost_stale = 1").run();

    expect(await repriceStale(env.DB, 2)).toEqual({ repriced: 2, remaining: 3 });
    // The newest two first: the ones the owner is about to look at.
    expect(await cost(ids[4]!)).toMatchObject({ cost_cents: 330, cost_stale: 0 });
    expect(await cost(ids[3]!)).toMatchObject({ cost_cents: 330, cost_stale: 0 });
    expect(await cost(ids[0]!)).toMatchObject({ cost_cents: null, cost_stale: 1 });

    expect(await repriceStale(env.DB, 10)).toEqual({ repriced: 3, remaining: 0 });
    expect(await staleCount(env.DB)).toBe(0);
  });

  it("adopts a legacy cost the tariff reproduces, and keeps one it does not", async () => {
    const same = await seedCharge(CAR_ID, { startAt: T0, geofenceId: place });
    const typed = await seedCharge(CAR_ID, { startAt: T0 + DAY, geofenceId: place });
    await env.DB.prepare(
      "UPDATE charging_processes SET cost_cents = 330, cost_source = 'legacy', cost_stale = 1 WHERE id = ?",
    )
      .bind(same)
      .run();
    await env.DB.prepare(
      "UPDATE charging_processes SET cost_cents = 1234, cost_source = 'legacy', cost_stale = 1 WHERE id = ?",
    )
      .bind(typed)
      .run();

    await repriceStale(env.DB, 10);
    expect(await cost(same)).toMatchObject({ cost_cents: 330, cost_source: "tariff", cost_stale: 0 });
    expect(await cost(typed)).toMatchObject({ cost_cents: 1234, cost_source: "legacy", cost_stale: 0 });
  });

  it("leaves a manual cost exactly as it is", async () => {
    const id = await seedCharge(CAR_ID, { startAt: T0, geofenceId: place });
    await env.DB.prepare(
      "UPDATE charging_processes SET cost_cents = 5, cost_source = 'manual', cost_stale = 1 WHERE id = ?",
    )
      .bind(id)
      .run();
    expect(await repriceCharge(env.DB, id)).toEqual({ min: 5, max: 5 });
    expect(await cost(id)).toMatchObject({ cost_cents: 5, cost_source: "manual", cost_stale: 0 });
  });

  it("clears a tariff cost the place no longer prices", async () => {
    const id = await seedCharge(CAR_ID, { startAt: T0, geofenceId: place });
    await repriceCharge(env.DB, id);
    expect(await cost(id)).toMatchObject({ cost_cents: 330, cost_source: "tariff" });
    await env.DB.prepare("UPDATE geofences SET tariff = '[]' WHERE id = ?").bind(place).run();
    await repriceCharge(env.DB, id);
    expect(await cost(id)).toMatchObject({ cost_cents: null, cost_max_cents: null, cost_source: null });
  });
});
