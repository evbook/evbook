import { Hono } from "hono";
import type { AppEnv } from "../platform/env";
import { z } from "zod";
import { listTrips } from "../db/queries/trips";
import { readGlobalSettings } from "./settings";

const DAY = 86_400_000;

const Query = z.object({
  carId: z.coerce.number().int(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

export const tripRoutes = new Hono<{ Bindings: AppEnv }>()
  /**
   * The journeys in a window. One car only: a trip is a run of one car's drives,
   * and two cars' drives interleaved would be grouped into nonsense.
   *
   * Defaults to a year, which is the span a question about road trips is asked over
   * — nobody wonders how this week went.
   */
  .get("/trips", async (c) => {
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const now = Date.now();
    const settings = await readGlobalSettings(c.env.DB);
    return c.json(
      await listTrips(c.env.DB, {
        carId: parsed.data.carId,
        from: parsed.data.from ?? now - 365 * DAY,
        to: parsed.data.to ?? now,
        preferredRange: settings.preferredRange,
        now,
      }),
    );
  });
