import { z } from "zod";
import { APP_VERSION } from "@shared/version";
import { withDeadline } from "../deadline";

/**
 * Ground height for a coordinate, via Open-Meteo's elevation API — the public
 * service standing in for the SRTM tiles TeslaMate reads off disk. No key, and
 * up to `MAX_BATCH` coordinates per request, which is what makes enriching a
 * whole drive one call instead of hundreds.
 *
 * The model behind it is the Copernicus DEM at roughly 90 m, so the figures are
 * the shape of the terrain rather than a surveyed altitude. That is the right
 * resolution for a drive's climb and descent and wrong for anything finer.
 */

const DEFAULT_BASE_URL = "https://api.open-meteo.com";
const USER_AGENT = `EVBook/${APP_VERSION} (self-hosted EV logbook; https://evbook.app)`;

/** Open-Meteo's documented ceiling for one request. */
export const MAX_BATCH = 100;

/** The scale `terrain` is keyed on: 1e-4 degrees, about 11 m. */
const KEY_SCALE = 1e4;

const ElevationResponse = z.object({
  elevation: z.array(z.number().nullable()).nullish(),
});

export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** A coordinate reduced to the integer pair the terrain cache is keyed on. */
export interface TerrainKey {
  latE4: number;
  lonE4: number;
}

export function terrainKey(latitude: number, longitude: number): TerrainKey {
  return { latE4: Math.round(latitude * KEY_SCALE), lonE4: Math.round(longitude * KEY_SCALE) };
}

/** The coordinate a key stands for — what actually gets asked about. */
export function keyToCoordinate(key: TerrainKey): Coordinate {
  return { latitude: key.latE4 / KEY_SCALE, longitude: key.lonE4 / KEY_SCALE };
}

export function keyOf(key: TerrainKey): string {
  return `${key.latE4},${key.lonE4}`;
}

/**
 * Look up one batch of coordinates. Returns one entry per input coordinate, in
 * the same order, `null` where the service had no figure. Returns `null` for the
 * whole batch on any failure — a network error is not the same as "no ground
 * here", and must not be cached as one.
 *
 * Never throws, and never sends more than `MAX_BATCH`: a longer list is the
 * caller's bug, and silently truncating it would lose coordinates.
 */
export async function lookupElevations(
  points: readonly Coordinate[],
  baseUrl?: string,
  timeoutMs = 8_000,
): Promise<(number | null)[] | null> {
  if (points.length === 0) return [];
  if (points.length > MAX_BATCH) throw new Error(`elevation batch of ${points.length} exceeds ${MAX_BATCH}`);

  const url =
    `${baseUrl || DEFAULT_BASE_URL}/v1/elevation` +
    `?latitude=${points.map((p) => p.latitude).join(",")}` +
    `&longitude=${points.map((p) => p.longitude).join(",")}`;

  try {
    const body = await withDeadline(timeoutMs, async (signal) => {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal,
      });
      return res.ok ? ((await res.json()) as unknown) : null;
    });
    if (body === null) return null;
    const parsed = ElevationResponse.safeParse(body);
    if (!parsed.success) return null;
    const values = parsed.data.elevation;
    // A short or absent array is a response this code does not understand, and
    // lining it up with the inputs by position would attribute one coordinate's
    // height to another.
    if (!values || values.length !== points.length) return null;
    return values.map((value) => (value == null || !Number.isFinite(value) ? null : Math.round(value)));
  } catch {
    return null;
  }
}
