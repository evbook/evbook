import { Hono } from "hono";
import type { CarDto, CarSummaryDto } from "@shared/api-types";
import { OwnerApi } from "../core/tesla/ownerapi";
import { decodeVin, lfpFromVin } from "../../shared/vin";
import { recordEvent } from "../core/telemetry";
import type { AppEnv } from "../platform/env";
import { carsNeedingTyreAttention } from "../db/queries/tyres";
import { DEMO_REFUSAL, demoSummaries, demoSummary, isDemo } from "./demo";

export async function listCars(env: AppEnv): Promise<CarDto[]> {
  // Left joined and coalesced rather than joined: a car whose settings row is
  // missing still belongs in the list — its history is there to read — and it is
  // not being logged, which is the same call the cron makes when it looks for
  // loggers to start.
  const rows = await env.DB.prepare(
    "SELECT c.id, c.provider, c.name, c.model, c.trim_badging, c.vin, c.efficiency, COALESCE(s.enabled, 0) AS enabled " +
      "FROM cars c LEFT JOIN car_settings s ON s.car_id = c.id ORDER BY c.id",
  ).all<{
    id: number;
    provider: string;
    name: string | null;
    model: string | null;
    trim_badging: string | null;
    vin: string;
    efficiency: number | null;
    enabled: number;
  }>();
  const attention = await carsNeedingTyreAttention(env.DB);
  return rows.results.map((r) => ({
    id: r.id,
    provider: r.provider === "volvo" ? "volvo" : "tesla",
    name: r.name,
    model: r.model,
    trimBadging: r.trim_badging,
    vin: r.vin,
    efficiency: r.efficiency,
    logged: r.enabled === 1,
    tyreAttention: attention.has(r.id),
  }));
}

/**
 * Discover vehicles on a Tesla account, upsert them, and start logging. A car
 * already known through another account moves to this one: whichever account
 * last listed it is the one that can read it.
 */
export async function discoverCars(env: AppEnv, account = "default"): Promise<CarDto[]> {
  const auth = env.actors.auth(account);
  const token = await auth.getAccessToken();
  if (!token) return listCars(env);

  const api = new OwnerApi(await auth.getApiHost());
  const result = await api.listVehicles(token);
  if (result.ok) {
    const now = Date.now();
    // Read before the upsert: it cannot tell an insert from an update, and
    // "vehicle added" means the insert.
    const known = new Set(
      (await env.DB.prepare("SELECT vin FROM cars").all<{ vin: string }>()).results.map((row) => row.vin),
    );
    for (const v of result.value) {
      await env.DB.prepare(
        "INSERT INTO cars (eid, vid, vin, name, provider, account, inserted_at, updated_at) VALUES (?, ?, ?, ?, 'tesla', ?, ?, ?) " +
          "ON CONFLICT(vin) DO UPDATE SET eid = excluded.eid, vid = excluded.vid, name = excluded.name, " +
          "provider = 'tesla', account = excluded.account, updated_at = excluded.updated_at",
      )
        .bind(v.id, v.vehicle_id, v.vin, v.display_name ?? null, account, now, now)
        .run();
      // A car's first settings row takes its pack chemistry from the VIN, so the
      // owner is never asked whether the battery is LFP. Only the insert reads
      // it: an answer already stored — detected or corrected by hand — stands.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO car_settings (car_id, lfp_battery) SELECT id, ? FROM cars WHERE vin = ?",
      )
        .bind(lfpFromVin(v.vin) === true ? 1 : 0, v.vin)
        .run();
      if (!known.has(v.vin)) {
        // What the VIN says about the car, never the VIN itself.
        const details = decodeVin(v.vin);
        await recordEvent(env.DB, "extended", "vehicle.added", {
          model: details.modelName,
          modelYear: details.modelYear,
        });
      }
    }
    const cars = await env.DB.prepare(
      "SELECT c.id FROM cars c JOIN car_settings s ON s.car_id = c.id WHERE s.enabled = 1",
    ).all<{ id: number }>();
    for (const row of cars.results) await env.actors.vehicle(row.id).ensureRunning(row.id);
  }
  return listCars(env);
}

export const carRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/cars", async (c) => c.json(await listCars(c.env)))

  .post("/cars/discover", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    // Every Tesla account, so a car added to any of them is found.
    const extra = await c.env.DB.prepare("SELECT name FROM accounts WHERE provider = 'tesla'").all<{ name: string }>();
    await discoverCars(c.env);
    for (const row of extra.results) await discoverCars(c.env, row.name);
    return c.json(await listCars(c.env));
  })

  /** All live summaries in one request — the overview polls this. */
  .get("/summaries", async (c) => {
    // In demo mode no Vehicle DO has ever polled; the seeded history itself
    // is the freshest state there is.
    if (isDemo(c.env)) return c.json(await demoSummaries(c.env.DB));
    const cars = await c.env.DB.prepare("SELECT id FROM cars ORDER BY id").all<{ id: number }>();
    const summaries: CarSummaryDto[] = [];
    for (const row of cars.results) {
      const summary = await c.env.actors.vehicle(row.id).getSummary();
      if (summary) summaries.push(summary);
    }
    return c.json(summaries);
  })

  .get("/cars/:id/summary", async (c) => {
    const carId = Number(c.req.param("id"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_car_id" }, 400);
    const summary = isDemo(c.env) ? await demoSummary(c.env.DB, carId) : await c.env.actors.vehicle(carId).getSummary();
    return summary ? c.json(summary) : c.json({ error: "not_found" }, 404);
  })

  .put("/cars/:id/logging/suspend", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const carId = Number(c.req.param("id"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_car_id" }, 400);
    const result = await c.env.actors.vehicle(carId).suspendLogging();
    return result.ok ? c.body(null, 204) : c.json({ error: "suspend_refused", message: result.reason }, 412);
  })

  .put("/cars/:id/logging/resume", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const carId = Number(c.req.param("id"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_car_id" }, 400);
    await c.env.actors.vehicle(carId).resumeLogging();
    return c.body(null, 204);
  })

  .post("/cars/:id/wake", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const carId = Number(c.req.param("id"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_car_id" }, 400);
    const result = await c.env.actors.vehicle(carId).wake();
    return result.ok ? c.body(null, 204) : c.json({ error: "wake_failed", message: result.reason }, 412);
  })

  .post("/cars/:id/navigation", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const carId = Number(c.req.param("id"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_car_id" }, 400);
    const body = await c.req.json<{ destination?: unknown }>().catch(() => null);
    const destination = typeof body?.destination === "string" ? body.destination.trim() : "";
    if (!destination) return c.json({ error: "invalid_destination" }, 400);
    const result = await c.env.actors.vehicle(carId).sendDestination(destination);
    return result.ok ? c.body(null, 204) : c.json({ error: "navigation_failed", message: result.reason }, 412);
  });
