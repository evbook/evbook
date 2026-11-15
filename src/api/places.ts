import { Hono } from "hono";
import type { PlaceDto } from "@shared/api-types";
import {
  boundingBox,
  findGeofence,
  haversineMeters,
  type GeofenceLike,
} from "../core/geo/geofence";
import { placeRegion, placeSpot } from "../db/queries/address";
import { Repo } from "../db/repo";
import type { AppEnv } from "../platform/env";
import { isDemo } from "./demo";

/**
 * How far a stored address may be from the point and still be its answer. A car
 * parked where it has parked before is answered from the addresses the logger has
 * already paid for, rather than with another request to Nominatim.
 */
const NEARBY_M = 40;

const NOTHING: PlaceDto = { label: null, region: null, geofence: false };

/**
 * Name a coordinate the way every list in the app would: the geofence it is in,
 * else the nearest stored address, else a fresh lookup (which is then stored, so
 * the next ask is answered locally). Demo mode never goes out to the geocoder.
 */
export async function placeAt(
  env: AppEnv,
  latitude: number,
  longitude: number,
): Promise<PlaceDto> {
  const fences = await env.DB.prepare(
    "SELECT id, name, latitude, longitude, radius FROM geofences",
  ).all<GeofenceLike & { name: string }>();
  const fence = findGeofence({ latitude, longitude }, fences.results) as
    (GeofenceLike & { name: string }) | null;
  if (fence) return { label: fence.name, region: null, geofence: true };

  const box = boundingBox(latitude, longitude, NEARBY_M);
  const near = await env.DB.prepare(
    "SELECT id, latitude, longitude FROM addresses " +
      "WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?",
  )
    .bind(box.minLat, box.maxLat, box.minLon, box.maxLon)
    .all<{ id: number; latitude: number; longitude: number }>();
  let addressId: number | null = null;
  let best = NEARBY_M;
  for (const row of near.results) {
    const d = haversineMeters(latitude, longitude, row.latitude, row.longitude);
    if (d <= best) {
      best = d;
      addressId = row.id;
    }
  }

  if (addressId == null && !isDemo(env)) {
    // The car id is only used by the drive and charge writers; resolving and
    // storing an address is shared by every car.
    addressId = await new Repo(env.DB, 0, env.NOMINATIM_HOST).resolveAddress(
      latitude,
      longitude,
    );
  }
  if (addressId == null) return NOTHING;

  const row = await env.DB.prepare(
    `SELECT ${placeSpot("a")} AS label, ${placeRegion("a")} AS region FROM addresses a WHERE a.id = ?`,
  )
    .bind(addressId)
    .first<{ label: string | null; region: string | null }>();
  return row
    ? { label: row.label, region: row.region, geofence: false }
    : NOTHING;
}

export const placeRoutes = new Hono<{ Bindings: AppEnv }>().get(
  "/place",
  async (c) => {
    const latitude = Number(c.req.query("lat"));
    const longitude = Number(c.req.query("lon"));
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return c.json({ error: "invalid_coordinates" }, 400);
    }
    return c.json(await placeAt(c.env, latitude, longitude));
  },
);
