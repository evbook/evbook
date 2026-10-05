import { Hono } from "hono";
import type { AppEnv } from "../platform/env";
import { z } from "zod";
import type { GeofenceDto } from "@shared/api-types";
import { findGeofence, type GeofenceLike } from "../core/geo/geofence";
import { calculateCostCents } from "../core/derive/cost";
import type { SqlDatabase, SqlStatement } from "../platform/ports";

const GeofenceBody = z.object({
  name: z.string().min(1).max(120),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius: z.number().int().min(1).max(4999),
  billingType: z.enum(["per_kwh", "per_minute"]).default("per_kwh"),
  costPerUnit: z.number().min(0).nullable().default(null),
  sessionFeeCents: z.number().int().min(0).nullable().default(null),
});

interface Row {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
  billing_type: "per_kwh" | "per_minute";
  cost_per_unit: number | null;
  session_fee_cents: number | null;
}

function toDto(row: Row): GeofenceDto {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    radius: row.radius,
    billingType: row.billing_type,
    costPerUnit: row.cost_per_unit,
    sessionFeeCents: row.session_fee_cents,
  };
}

async function allGeofences(db: SqlDatabase): Promise<GeofenceLike[]> {
  const rows = await db.prepare("SELECT id, latitude, longitude, radius FROM geofences").all<GeofenceLike>();
  return rows.results;
}

/**
 * Re-match every drive endpoint and charging session against the current set of
 * geofences. TeslaMate does this with raw SQL per affected circle; recomputing
 * the affected rows in TypeScript is clearer and geofence counts are tiny.
 */
async function reapplyGeofences(db: SqlDatabase): Promise<void> {
  const geofences = await allGeofences(db);

  const drives = await db
    .prepare(
      "SELECT d.id, sp.latitude AS s_lat, sp.longitude AS s_lon, ep.latitude AS e_lat, ep.longitude AS e_lon " +
        "FROM drives d LEFT JOIN positions sp ON sp.id = d.start_position_id " +
        "LEFT JOIN positions ep ON ep.id = d.end_position_id",
    )
    .all<{ id: number; s_lat: number | null; s_lon: number | null; e_lat: number | null; e_lon: number | null }>();

  const statements: SqlStatement[] = [];
  for (const drive of drives.results) {
    const start = findGeofence({ latitude: drive.s_lat, longitude: drive.s_lon }, geofences)?.id ?? null;
    const end = findGeofence({ latitude: drive.e_lat, longitude: drive.e_lon }, geofences)?.id ?? null;
    statements.push(
      db.prepare("UPDATE drives SET start_geofence_id = ?, end_geofence_id = ? WHERE id = ?").bind(start, end, drive.id),
    );
  }

  const sessions = await db
    .prepare(
      "SELECT cp.id, p.latitude, p.longitude FROM charging_processes cp LEFT JOIN positions p ON p.id = cp.position_id",
    )
    .all<{ id: number; latitude: number | null; longitude: number | null }>();

  for (const session of sessions.results) {
    const match = findGeofence(session, geofences)?.id ?? null;
    statements.push(db.prepare("UPDATE charging_processes SET geofence_id = ? WHERE id = ?").bind(match, session.id));
  }

  // D1 batches are atomic, but must be chunked to stay within statement limits.
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }
}

export const geofenceRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/geofences", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT id, name, latitude, longitude, radius, billing_type, cost_per_unit, session_fee_cents " +
        "FROM geofences ORDER BY name",
    ).all<Row>();
    return c.json(rows.results.map(toDto));
  })

  .post("/geofences", async (c) => {
    const parsed = GeofenceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const g = parsed.data;
    const now = Date.now();
    const row = await c.env.DB.prepare(
      "INSERT INTO geofences (name, latitude, longitude, radius, billing_type, cost_per_unit, session_fee_cents, " +
        "inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(g.name, g.latitude, g.longitude, g.radius, g.billingType, g.costPerUnit, g.sessionFeeCents, now, now)
      .first<{ id: number }>();
    await reapplyGeofences(c.env.DB);
    return c.json({ id: row?.id ?? null }, 201);
  })

  .put("/geofences/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const parsed = GeofenceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const g = parsed.data;
    const result = await c.env.DB.prepare(
      "UPDATE geofences SET name = ?, latitude = ?, longitude = ?, radius = ?, billing_type = ?, " +
        "cost_per_unit = ?, session_fee_cents = ?, updated_at = ? WHERE id = ?",
    )
      .bind(g.name, g.latitude, g.longitude, g.radius, g.billingType, g.costPerUnit, g.sessionFeeCents, Date.now(), id)
      .run();
    if (!result.meta.changes) return c.json({ error: "not_found" }, 404);
    await reapplyGeofences(c.env.DB);
    return c.json({ id });
  })

  .delete("/geofences/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const result = await c.env.DB.prepare("DELETE FROM geofences WHERE id = ?").bind(id).run();
    if (!result.meta.changes) return c.json({ error: "not_found" }, 404);
    await reapplyGeofences(c.env.DB);
    return c.body(null, 204);
  })

  /** How many sessions at this location still have no cost — drives the prompt. */
  .get("/geofences/:id/uncosted", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM charging_processes WHERE geofence_id = ? AND cost_cents IS NULL",
    )
      .bind(id)
      .first<{ count: number }>();
    return c.json({ count: row?.count ?? 0 });
  })

  /** Apply this geofence's cost rule to its sessions that have no cost yet. */
  .post("/geofences/:id/apply-costs", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const db: SqlDatabase = c.env.DB;

    const geofence = await db.prepare(
      "SELECT billing_type, cost_per_unit, session_fee_cents FROM geofences WHERE id = ?",
    )
      .bind(id)
      .first<{ billing_type: "per_kwh" | "per_minute"; cost_per_unit: number | null; session_fee_cents: number | null }>();
    if (!geofence) return c.json({ error: "not_found" }, 404);

    const sessions = await db.prepare(
      "SELECT cp.id, cp.charge_energy_added, cp.charge_energy_used, cp.duration_min, s.free_supercharging, " +
        "(SELECT fast_charger_type FROM charges WHERE charging_process_id = cp.id AND charger_power > 0 " +
        " GROUP BY fast_charger_type ORDER BY COUNT(*) DESC LIMIT 1) AS charger_type " +
        "FROM charging_processes cp JOIN car_settings s ON s.car_id = cp.car_id " +
        "WHERE cp.geofence_id = ? AND cp.cost_cents IS NULL",
    )
      .bind(id)
      .all<{
        id: number;
        charge_energy_added: number | null;
        charge_energy_used: number | null;
        duration_min: number | null;
        free_supercharging: number;
        charger_type: string | null;
      }>();

    const statements: SqlStatement[] = [];
    for (const session of sessions.results) {
      const cost = calculateCostCents({
        fastChargerType: session.charger_type,
        freeSupercharging: session.free_supercharging === 1,
        energyAdded: session.charge_energy_added,
        energyUsed: session.charge_energy_used,
        durationMin: session.duration_min,
        geofence: {
          billing_type: geofence.billing_type,
          cost_per_unit: geofence.cost_per_unit,
          session_fee_cents: geofence.session_fee_cents,
        },
      });
      if (cost !== null) {
        statements.push(
          db.prepare("UPDATE charging_processes SET cost_cents = ? WHERE id = ?").bind(cost, session.id),
        );
      }
    }
    for (let i = 0; i < statements.length; i += 50) {
      await db.batch(statements.slice(i, i + 50));
    }
    return c.json({ updated: statements.length });
  });
