import { Hono } from "hono";
import type { AppEnv } from "../platform/env";
import { z } from "zod";
import { drivesRoute, getDrive, getDriveTrack, listDrives, type DriveFilters } from "../db/queries/drives";
import { readGlobalSettings } from "./settings";
import type { SqlDatabase } from "../platform/ports";

const Filters = z.object({
  carId: z.coerce.number().int().optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  minDistanceKm: z.coerce.number().optional(),
  maxDistanceKm: z.coerce.number().optional(),
  minDurationMin: z.coerce.number().optional(),
  maxDurationMin: z.coerce.number().optional(),
  minConsumption: z.coerce.number().optional(),
  maxConsumption: z.coerce.number().optional(),
  startGeofenceId: z.coerce.number().int().optional(),
  endGeofenceId: z.coerce.number().int().optional(),
  search: z.string().max(120).optional(),
  sort: z.enum(["date", "distance", "duration", "speed", "consumption", "energy", "battery"]).default("date"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function parseFilters(
  db: SqlDatabase,
  query: Record<string, string>,
): Promise<{ ok: true; filters: DriveFilters } | { ok: false; message: string }> {
  const parsed = Filters.safeParse(query);
  if (!parsed.success) return { ok: false, message: parsed.error.message };
  const settings = await readGlobalSettings(db);
  return { ok: true, filters: { ...parsed.data, preferredRange: settings.preferredRange } };
}

export const driveRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/drives", async (c) => {
    const result = await parseFilters(c.env.DB, c.req.query());
    if (!result.ok) return c.json({ error: "invalid_request", message: result.message }, 400);
    return c.json(await listDrives(c.env.DB, result.filters));
  })

  /**
   * Combined route across the filtered drives. Kept separate from the list so
   * the table stays light and the map is only fetched when it is shown.
   */
  .get("/drives/route", async (c) => {
    const result = await parseFilters(c.env.DB, c.req.query());
    if (!result.ok) return c.json({ error: "invalid_request", message: result.message }, 400);
    return c.json(await drivesRoute(c.env.DB, result.filters));
  })

  .get("/drives/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const settings = await readGlobalSettings(c.env.DB);
    const drive = await getDrive(c.env.DB, id, settings.preferredRange);
    return drive ? c.json(drive) : c.json({ error: "not_found" }, 404);
  })

  .get("/drives/:id/gpx", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
    const track = await getDriveTrack(c.env.DB, id);
    if (!track) return c.json({ error: "not_found" }, 404);

    const name = `EVBook drive ${new Date(track.startAt).toISOString()}`;
    const points = track.points
      .map((p) => {
        const elevation = p.elevation != null ? `<ele>${p.elevation}</ele>` : "";
        return `<trkpt lat="${p.lat}" lon="${p.lon}">${elevation}<time>${new Date(p.at).toISOString()}</time></trkpt>`;
      })
      .join("\n      ");

    const gpx =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="EVBook" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      `  <metadata><name>${escapeXml(name)}</name><time>${new Date(track.startAt).toISOString()}</time></metadata>\n` +
      `  <trk>\n    <name>${escapeXml(name)}</name>\n    <trkseg>\n      ${points}\n    </trkseg>\n  </trk>\n</gpx>\n`;

    const filename = `drive-${id}-${new Date(track.startAt).toISOString().slice(0, 10)}.gpx`;
    return new Response(gpx, {
      headers: {
        "content-type": "application/gpx+xml; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });
