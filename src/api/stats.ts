import { Hono } from "hono";
import type { AppEnv } from "../platform/env";
import { z } from "zod";
import { COUNTED_TABLES, dataHealth } from "../db/queries/dataHealth";
import {
  batteryHealth,
  chargeLevel,
  chargingStats,
  driveStats,
  efficiencyStats,
  odometerSeries,
  periodStats,
  placeStats,
  stateTimeline,
  updateHistory,
  vampireDrain,
} from "../db/queries/stats";
import { TIMELINE_KINDS, eventLog, parseCursor } from "../db/queries/timeline";
import type { TimelineEventKind } from "../../shared/api-types";
import { type FirstDay, statsWindow } from "../../shared/timeBuckets";
import { toCsv } from "./csv";
import { readGlobalSettings } from "./settings";

const DAY = 86_400_000;

const RangeQuery = z.object({
  carId: z.coerce.number().int().optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

const PeriodQuery = RangeQuery.extend({
  period: z.enum(["day", "week", "month", "year"]).default("month"),
  /**
   * Which day the client's weeks start on, ISO numbering: 1 = Monday … 7 = Sunday.
   * The date range picker follows the viewer's locale, so grouping by week has to
   * be told the same thing or a selected week straddles two of these buckets.
   * Monday by default, which is the ISO week and what every earlier client sent.
   */
  weekStart: z.coerce.number().int().min(1).max(7).default(1),
});

const ChargeLevelQuery = RangeQuery.extend({
  /** Upper bound on returned buckets; the width is snapped up to suit. */
  points: z.coerce.number().int().min(10).max(2000).default(400),
  /** The level a car is "sitting high" at, in percent. */
  highSoc: z.coerce.number().int().min(1).max(100).default(80),
});

const TimelineQuery = RangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque `at.rank.id` from a previous page's `nextCursor`. */
  cursor: z.string().optional(),
  search: z.string().trim().max(100).optional(),
  /** Comma-separated event kinds; omitted means all of them. */
  kinds: z.string().optional(),
});

/**
 * The requested kinds, or null if any of them is not a kind. Null rather than a
 * silent drop: a typo that quietly returned a narrower log than asked for would
 * look like missing history.
 */
function parseKinds(raw: string | undefined): TimelineEventKind[] | null {
  if (raw === undefined) return [...TIMELINE_KINDS];
  const requested = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (requested.length === 0) return null;
  const known = new Set<string>(TIMELINE_KINDS);
  if (requested.some((kind) => !known.has(kind))) return null;
  return requested as TimelineEventKind[];
}

/**
 * One list, not two. The data-health card puts a download beside every count, so
 * a table that could be counted but not exported would render a dead link.
 */
const EXPORTABLE = new Set<string>(COUNTED_TABLES);

export const statsRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/stats", async (c) => {
    const parsed = PeriodQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const { period, carId, weekStart } = parsed.data;
    const window = statsWindow(period, Date.now());
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(
      await periodStats(c.env.DB, {
        from: parsed.data.from ?? window.from,
        to: parsed.data.to ?? window.to,
        period,
        timezone: settings.timezone,
        carId,
        preferredRange: settings.preferredRange,
        firstDay: weekStart as FirstDay,
      }),
    );
  })

  .get("/stats/charging", async (c) => {
    const parsed = RangeQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    return c.json(
      await chargingStats(c.env.DB, {
        from: parsed.data.from ?? Date.now() - 365 * DAY,
        to: parsed.data.to ?? Date.now(),
        carId: parsed.data.carId,
        // The heatmap buckets by local weekday and hour, so it needs the same zone
        // every other date on the page is rendered in.
        timezone: (await readGlobalSettings(c.env.DB)).timezone,
      }),
    );
  })

  /** Drive aggregates. Defaults to the last year, like the charging roll-up. */
  .get("/stats/drives", async (c) => {
    const parsed = RangeQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(
      await driveStats(c.env.DB, {
        from: parsed.data.from ?? Date.now() - 365 * DAY,
        to: parsed.data.to ?? Date.now(),
        carId: parsed.data.carId,
        preferredRange: settings.preferredRange,
      }),
    );
  })

  /** Consumption against outside temperature. Defaults to the last year. */
  .get("/stats/efficiency", async (c) => {
    const parsed = RangeQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(
      await efficiencyStats(c.env.DB, {
        from: parsed.data.from ?? Date.now() - 365 * DAY,
        to: parsed.data.to ?? Date.now(),
        carId: parsed.data.carId,
        preferredRange: settings.preferredRange,
      }),
    );
  })

  /** The odometer over a window. One car only — two cars have two odometers. */
  .get("/stats/odometer", async (c) => {
    const parsed = ChargeLevelQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const { carId, points } = parsed.data;
    if (carId === undefined) return c.json({ error: "invalid_request", message: "carId is required" }, 400);
    const now = Date.now();
    return c.json(
      await odometerSeries(c.env.DB, {
        carId,
        from: parsed.data.from ?? now - 365 * DAY,
        to: parsed.data.to ?? now,
        points,
      }),
    );
  })

  /** Lifetime address roll-up for the Places page; no window, by design. */
  .get("/stats/places", async (c) => {
    const carId = c.req.query("carId");
    if (carId !== undefined && !Number.isInteger(Number(carId))) {
      return c.json({ error: "invalid_request", message: "carId must be a number" }, 400);
    }
    // How many top places to return. Grown by the page's "Load more", so it is
    // a size, not a cursor — capped so a hand-written URL cannot ask for the world.
    const limit = c.req.query("limit");
    if (limit !== undefined && (!Number.isInteger(Number(limit)) || Number(limit) < 1)) {
      return c.json({ error: "invalid_request", message: "limit must be a positive number" }, 400);
    }
    return c.json(
      await placeStats(c.env.DB, carId === undefined ? undefined : Number(carId), {
        topLimit: limit === undefined ? undefined : Math.min(Number(limit), 200),
      }),
    );
  })

  .get("/stats/battery-health", async (c) => {
    const carId = Number(c.req.query("carId"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_request", message: "carId is required" }, 400);
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(await batteryHealth(c.env.DB, { carId, preferredRange: settings.preferredRange }));
  })

  .get("/stats/vampire-drain", async (c) => {
    const carId = Number(c.req.query("carId"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_request", message: "carId is required" }, 400);
    const minHours = Number(c.req.query("minHours") ?? 4);
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(
      await vampireDrain(c.env.DB, {
        carId,
        minHours: Number.isFinite(minHours) && minHours > 0 ? minHours : 4,
        preferredRange: settings.preferredRange,
      }),
    );
  })

  /** What the car was doing over a window. Defaults to the last seven days. */
  .get("/stats/states", async (c) => {
    const parsed = RangeQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const { carId } = parsed.data;
    if (carId === undefined) return c.json({ error: "invalid_request", message: "carId is required" }, 400);
    const now = Date.now();
    return c.json(
      await stateTimeline(c.env.DB, {
        carId,
        from: parsed.data.from ?? now - 7 * DAY,
        to: parsed.data.to ?? now,
        now,
      }),
    );
  })

  /** State of charge over a window. Defaults to the last thirty days. */
  .get("/stats/charge-level", async (c) => {
    const parsed = ChargeLevelQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const { carId, points, highSoc } = parsed.data;
    if (carId === undefined) return c.json({ error: "invalid_request", message: "carId is required" }, 400);
    const now = Date.now();
    return c.json(
      await chargeLevel(c.env.DB, {
        carId,
        from: parsed.data.from ?? now - 30 * DAY,
        to: parsed.data.to ?? now,
        points,
        highSocThreshold: highSoc,
      }),
    );
  })

  /**
   * The unified event log. Same window as the band above it on the page, so the
   * two can never disagree about what the period contained.
   */
  .get("/stats/timeline", async (c) => {
    const parsed = TimelineQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const { carId, limit, search } = parsed.data;
    if (carId === undefined) return c.json({ error: "invalid_request", message: "carId is required" }, 400);

    const kinds = parseKinds(parsed.data.kinds);
    if (kinds === null) return c.json({ error: "invalid_request", message: "unknown event kind" }, 400);

    const cursor = parsed.data.cursor === undefined ? undefined : parseCursor(parsed.data.cursor);
    if (cursor === null) return c.json({ error: "invalid_request", message: "malformed cursor" }, 400);

    const now = Date.now();
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(
      await eventLog(c.env.DB, {
        carId,
        from: parsed.data.from ?? now - 7 * DAY,
        to: parsed.data.to ?? now,
        kinds,
        search: search || undefined,
        limit,
        cursor,
        preferredRange: settings.preferredRange,
      }),
    );
  })

  .get("/stats/updates", async (c) => {
    const carId = c.req.query("carId");
    return c.json(await updateHistory(c.env.DB, carId ? Number(carId) : undefined));
  })

  /**
   * What is in the database and what looks half-written. Not under `/stats`
   * because it is not one — it reads the tables rather than the history in them,
   * and it sits beside the export below for the same reason.
   */
  .get("/data-health", async (c) => {
    // Through zod like every other route here. Hand-rolling it with `Number()` let
    // an empty `?carId=` through as car 0 — a car that does not exist, reported as
    // having nothing wrong with it.
    const parsed = z.object({ carId: z.coerce.number().int().positive().optional() }).safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    return c.json(await dataHealth(c.env.DB, parsed.data.carId));
  })

  /** Raw table export so the data is never trapped in this app. */
  .get("/export/:table", async (c) => {
    const table = c.req.param("table").replace(/\.csv$/, "");
    if (!EXPORTABLE.has(table)) return c.json({ error: "unknown_table" }, 404);
    const rows = await c.env.DB.prepare(`SELECT * FROM ${table} LIMIT 100000`).all<Record<string, unknown>>();
    return new Response(toCsv(rows.results), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="evbook-${table}.csv"`,
      },
    });
  });
