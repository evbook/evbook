import { Hono } from "hono";
import type { AppEnv } from "../platform/env";
import { z } from "zod";
import type { GeofenceDto, TariffPriceDto } from "@shared/api-types";
import { findGeofence, type GeofenceLike } from "../core/geo/geofence";
import { dayStart, sortPrices, tariffProblem } from "../core/tariff";
import { isValidTimeZone, localDate } from "../core/zone";
import {
  accountTimeZone,
  BUDGET_ON_EDIT,
  markPlaceStale,
  PLACE_COLUMNS,
  repriceScope,
  repriceStale,
  staleCount,
  tariffOf,
  type PlaceRow,
} from "../db/pricing";
import type { SqlDatabase, SqlStatement } from "../platform/ports";

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "a time as HH:MM");

const TariffWindow = z.object({
  label: z.string().trim().max(40).nullable().default(null),
  days: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  start: Time,
  end: Time,
  months: z
    .array(z.number().int().min(1).max(12))
    .nullable()
    .default(null)
    .transform((months) => (months == null || months.length === 0 ? null : [...new Set(months)].sort((a, b) => a - b))),
  rate: z.number().min(0).max(1000),
});

const TariffPrice = z.object({
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  billingType: z.enum(["per_kwh", "per_minute"]),
  rate: z.number().min(0).max(1000),
  sessionFeeCents: z.number().int().min(0).nullable().default(null),
  windows: z.array(TariffWindow).max(24).default([]),
});

const Tariff = z
  .array(TariffPrice)
  .max(100)
  .superRefine((tariff, ctx) => {
    const problem = tariffProblem(tariff);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  })
  .transform((tariff) => sortPrices(tariff));

const GeofenceBody = z.object({
  name: z.string().min(1).max(120),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radius: z.number().int().min(1).max(4999),
  timezone: z
    .string()
    .max(64)
    .nullable()
    .optional()
    .refine((zone) => zone == null || isValidTimeZone(zone), "an IANA time zone"),
  chargerPowerKw: z.number().positive().max(1000).nullable().optional(),
  acEfficiency: z.number().min(0.5).max(1).nullable().optional(),
  dcEfficiency: z.number().min(0.5).max(1).nullable().optional(),
  /** Absent on an update: the tariff stays as it is. */
  tariff: Tariff.optional(),
});

type Body = z.infer<typeof GeofenceBody>;

interface Row extends PlaceRow {
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
}

const ROW_COLUMNS = `${PLACE_COLUMNS}, name, latitude, longitude, radius`;

async function toDto(db: SqlDatabase, row: Row, accountZone: string): Promise<GeofenceDto> {
  const zone = row.timezone ?? accountZone;
  const tariff = sortPrices(await tariffOf(db, row, zone));
  const first = await db
    .prepare("SELECT MIN(start_date_at) AS at FROM charging_processes WHERE geofence_id = ?")
    .bind(row.id)
    .first<{ at: number | null }>();
  let before = 0;
  if (first?.at != null && tariff.length > 0) {
    const counted = await db
      .prepare("SELECT COUNT(*) AS n FROM charging_processes WHERE geofence_id = ? AND start_date_at < ?")
      .bind(row.id, dayStart(tariff[0]!.validFrom, zone))
      .first<{ n: number }>();
    before = counted?.n ?? 0;
  }
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    radius: row.radius,
    timezone: row.timezone,
    chargerPowerKw: row.charger_power_kw,
    acEfficiency: row.ac_efficiency,
    dcEfficiency: row.dc_efficiency,
    tariff,
    firstChargeAt: first?.at ?? null,
    firstChargeDate: first?.at != null ? localDate(first.at, zone) : null,
    chargesBeforeTariff: before,
    repricing: await staleCount(db, row.id),
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
 *
 * A session that lands in a different place (or none) is queued for repricing:
 * it now falls under another tariff.
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
      db
        .prepare("UPDATE drives SET start_geofence_id = ?, end_geofence_id = ? WHERE id = ?")
        .bind(start, end, drive.id),
    );
  }

  const sessions = await db
    .prepare(
      "SELECT cp.id, cp.geofence_id, p.latitude, p.longitude FROM charging_processes cp " +
        "LEFT JOIN positions p ON p.id = cp.position_id",
    )
    .all<{ id: number; geofence_id: number | null; latitude: number | null; longitude: number | null }>();

  for (const session of sessions.results) {
    const match = findGeofence(session, geofences)?.id ?? null;
    if (match === session.geofence_id) continue;
    statements.push(
      db
        .prepare(
          "UPDATE charging_processes SET geofence_id = ?, " +
            "cost_stale = CASE WHEN end_date_at IS NOT NULL AND (cost_source IS NULL OR cost_source <> 'manual') " +
            "THEN 1 ELSE cost_stale END WHERE id = ?",
        )
        .bind(match, session.id),
    );
  }

  // D1 batches are atomic, but must be chunked to stay within statement limits.
  for (let i = 0; i < statements.length; i += 50) {
    await db.batch(statements.slice(i, i + 50));
  }
}

function columns(g: Body) {
  return [
    g.name,
    g.latitude,
    g.longitude,
    g.radius,
    g.timezone ?? null,
    g.chargerPowerKw ?? null,
    g.acEfficiency ?? null,
    g.dcEfficiency ?? null,
  ];
}

async function readRow(db: SqlDatabase, id: number): Promise<Row | null> {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM geofences WHERE id = ?`).bind(id).first<Row>();
}

export const geofenceRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/geofences", async (c) => {
    const db = c.env.DB;
    const rows = await db.prepare(`SELECT ${ROW_COLUMNS} FROM geofences ORDER BY name`).all<Row>();
    const zone = await accountTimeZone(db);
    const out: GeofenceDto[] = [];
    for (const row of rows.results) out.push(await toDto(db, row, zone));
    return c.json(out);
  })

  .get("/geofences/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const row = await readRow(c.env.DB, id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(await toDto(c.env.DB, row, await accountTimeZone(c.env.DB)));
  })

  .post("/geofences", async (c) => {
    const parsed = GeofenceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const g = parsed.data;
    const db = c.env.DB;
    const now = Date.now();
    const row = await db
      .prepare(
        "INSERT INTO geofences (name, latitude, longitude, radius, timezone, charger_power_kw, ac_efficiency, " +
          "dc_efficiency, tariff, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .bind(...columns(g), JSON.stringify(g.tariff ?? []), now, now)
      .first<{ id: number }>();
    await reapplyGeofences(db);
    const repricing = await repriceStale(db, BUDGET_ON_EDIT, row?.id ?? null);
    return c.json({ id: row?.id ?? null, repricing: repricing.remaining }, 201);
  })

  .put("/geofences/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const parsed = GeofenceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const g = parsed.data;
    const db = c.env.DB;

    const before = await readRow(db, id);
    if (!before) return c.json({ error: "not_found" }, 404);
    const accountZone = await accountTimeZone(db);
    const beforeZone = before.timezone ?? accountZone;
    const beforeTariff = sortPrices(await tariffOf(db, before, beforeZone));
    const tariff: TariffPriceDto[] = g.tariff ?? beforeTariff;

    await db
      .prepare(
        "UPDATE geofences SET name = ?, latitude = ?, longitude = ?, radius = ?, timezone = ?, " +
          "charger_power_kw = ?, ac_efficiency = ?, dc_efficiency = ?, tariff = ?, updated_at = ? WHERE id = ?",
      )
      .bind(...columns(g), JSON.stringify(tariff), Date.now(), id)
      .run();

    const afterZone = g.timezone ?? accountZone;
    const scope = repriceScope(
      {
        tariff: beforeTariff,
        timeZone: beforeZone,
        chargerPowerKw: before.charger_power_kw,
        ac: before.ac_efficiency,
        dc: before.dc_efficiency,
      },
      {
        tariff,
        timeZone: afterZone,
        chargerPowerKw: g.chargerPowerKw ?? null,
        ac: g.acEfficiency ?? null,
        dc: g.dcEfficiency ?? null,
      },
    );
    // Read in the zone each range's days were billed in: a zone change is
    // always "all", so the two only differ when no range is given.
    await markPlaceStale(db, id, scope, afterZone);
    await reapplyGeofences(db);
    const repricing = await repriceStale(db, BUDGET_ON_EDIT);
    return c.json({ id, repricing: repricing.remaining });
  })

  .delete("/geofences/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const db = c.env.DB;
    // Its sessions lose their place, and with it their tariff.
    await db
      .prepare(
        "UPDATE charging_processes SET cost_stale = 1 WHERE geofence_id = ? AND end_date_at IS NOT NULL " +
          "AND (cost_source IS NULL OR cost_source <> 'manual')",
      )
      .bind(id)
      .run();
    const result = await db.prepare("DELETE FROM geofences WHERE id = ?").bind(id).run();
    if (!result.meta.changes) return c.json({ error: "not_found" }, 404);
    await reapplyGeofences(db);
    await repriceStale(db, BUDGET_ON_EDIT);
    return c.body(null, 204);
  });
