import { Hono } from "hono";
import type { AppEnv } from "../platform/env";
import { z } from "zod";
import { getCharge, getChargeSamplesForExport, listChargeMapPoints, listCharges } from "../db/queries/charges";
import { toCsv } from "./csv";
import { readGlobalSettings } from "./settings";

const Filters = z.object({
  carId: z.coerce.number().int().optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  currentType: z.enum(["ac", "dc"]).optional(),
  geofenceId: z.coerce.number().int().optional(),
  search: z.string().max(120).optional(),
  minEnergyKwh: z.coerce.number().optional(),
  maxEnergyKwh: z.coerce.number().optional(),
  minDurationMin: z.coerce.number().optional(),
  maxDurationMin: z.coerce.number().optional(),
  minCostCents: z.coerce.number().optional(),
  maxCostCents: z.coerce.number().optional(),
  sort: z.enum(["date", "energy", "duration", "cost", "power", "battery"]).default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The map rolls every matching session up by place, so it neither sorts nor pages. */
const MapFilters = Filters.omit({ sort: true, dir: true, limit: true, offset: true });

/**
 * The session's total cost, in major units, null to clear it. A total is the
 * only shape taken: only the total is stored, so accepting a rate or a fee here
 * would be arithmetic the endpoint immediately forgets. Strict, so a stray
 * field is an error rather than ignored money.
 */
const CostPatch = z.strictObject({ value: z.number().min(0).nullable() });

export const chargeRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/charges", async (c) => {
    const parsed = Filters.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(await listCharges(c.env.DB, { ...parsed.data, preferredRange: settings.preferredRange }));
  })

  // Before "/charges/:id", which would otherwise take "map" for an id.
  .get("/charges/map", async (c) => {
    const parsed = MapFilters.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    return c.json(await listChargeMapPoints(c.env.DB, parsed.data));
  })

  .get("/charges/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const settings = await readGlobalSettings(c.env.DB);
    const charge = await getCharge(c.env.DB, id, settings.preferredRange);
    return charge ? c.json(charge) : c.json({ error: "not_found" }, 404);
  })

  /**
   * The session's samples as CSV, every column the car reported — the charge
   * page's counterpart to the drive page's GPX download. A readable timestamp
   * leads; date_at stays beside it for anything that joins back to the tables.
   */
  .get("/charges/:id/csv", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const track = await getChargeSamplesForExport(c.env.DB, id);
    if (!track) return c.json({ error: "not_found" }, 404);

    const rows = track.samples.map((s) => ({ date: new Date(s.date_at as number).toISOString(), ...s }));
    const filename = `charge-${id}-${new Date(track.startAt).toISOString().slice(0, 10)}.csv`;
    return new Response(toCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  })

  .put("/charges/:id/cost", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const parsed = CostPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);

    const session = await c.env.DB.prepare("SELECT id FROM charging_processes WHERE id = ?")
      .bind(id)
      .first<{ id: number }>();
    if (!session) return c.json({ error: "not_found" }, 404);

    const costCents = parsed.data.value === null ? null : Math.round(parsed.data.value * 100);
    await c.env.DB.prepare("UPDATE charging_processes SET cost_cents = ? WHERE id = ?").bind(costCents, id).run();
    return c.json({ id, costCents });
  });
