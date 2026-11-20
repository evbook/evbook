#!/usr/bin/env bun
/**
 * Fetches the road geometry of every demo route from the public OSRM server
 * and writes it to `demo/routes.json`, which is committed: seeding reads the
 * file and never the network.
 *
 *   bun demo/fetch-routes.mjs [--all]
 *
 * Only routes whose ends or vias changed since the last fetch are asked for
 * again, unless --all. The demo server allows about one request a second, and
 * this stays under that.
 *
 * What is stored per route: the track as an encoded polyline, the time at each
 * of its points, and the distance and duration the drive takes. OSRM's times
 * are free-flow; they are stretched here by road speed — town streets with
 * lights and traffic by half again, motorways barely — so a 6 km crosstown
 * drive takes the twenty minutes it does in Berlin rather than the twelve on
 * an empty map, and motorways sped up to what a Tesla actually holds there.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeTrack } from "./track.mjs";
import { PLACES, ROUTE_SPECS } from "./geography.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "routes.json");
const OSRM = "https://router.project-osrm.org/route/v1/driving";

/** Points closer than this to the line through their neighbours are dropped. */
const SIMPLIFY_M = 6;

const pointOf = (key) => {
  const place = PLACES[key];
  if (!place) throw new Error(`unknown place ${key}`);
  return [place.lat, place.lon];
};

const stopsOf = (spec) => [pointOf(spec.from), ...(spec.via ?? []), pointOf(spec.to)];
const fingerprint = (spec) => JSON.stringify(stopsOf(spec));

function distanceM([lat1, lon1], [lat2, lon2]) {
  const x = (((lon2 - lon1) * Math.PI) / 180) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const y = ((lat2 - lat1) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/** How much slower than free-flow a stretch really goes, by how fast it is. */
function trafficFactor(kmh) {
  if (kmh < 30) return 1.8;
  if (kmh < 45) return 1.6;
  if (kmh < 60) return 1.35;
  if (kmh < 85) return 1.15;
  if (kmh < 105) return 1.04;
  // OSRM's motorway speeds are a cautious ~113 km/h; a Tesla on an open
  // Autobahn sits nearer 130.
  return 0.88;
}

/** Distance from p to the segment a–b, in metres (flat-earth, fine at this scale). */
function offsetM(p, a, b) {
  const kx = Math.cos((p[0] * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  const ax = a[1] * kx;
  const ay = a[0] * ky;
  const bx = b[1] * kx - ax;
  const by = b[0] * ky - ay;
  const px = p[1] * kx - ax;
  const py = p[0] * ky - ay;
  const len = bx * bx + by * by;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Douglas–Peucker over [lat, lon, t] points; keeps the ends. */
function simplify(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i++) {
      const d = offsetM(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worst > tolerance) {
      keep[worstAt] = 1;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

async function fetchRoute(spec) {
  const coords = stopsOf(spec)
    .map(([lat, lon]) => `${lon},${lat}`)
    .join(";");
  const url = `${OSRM}/${coords}?overview=full&geometries=geojson&annotations=duration,distance&continue_straight=true`;
  const response = await fetch(url, { headers: { "User-Agent": "evbook-demo-route-fetch" } });
  if (!response.ok) throw new Error(`OSRM ${response.status} for ${url}`);
  const body = await response.json();
  if (body.code !== "Ok") throw new Error(`OSRM ${body.code} for ${url}`);
  const route = body.routes[0];

  // The geometry has one more point than the per-segment annotations of all
  // legs together; walk them in step, stretching each segment's time.
  const coordinates = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const durations = route.legs.flatMap((leg) => leg.annotation.duration);
  const distances = route.legs.flatMap((leg) => leg.annotation.distance);
  if (durations.length !== coordinates.length - 1) throw new Error("annotation and geometry disagree");

  const points = [[...coordinates[0], 0]];
  let t = 0;
  let metres = 0;
  const speedByMetre = [];
  for (let i = 0; i < durations.length; i++) {
    const d = distances[i];
    const free = Math.max(durations[i], 0.05);
    const kmh = Math.min(150, (d / free) * 3.6);
    const factor = trafficFactor(kmh);
    t += free * factor;
    metres += d;
    speedByMetre.push([kmh / factor, d]);
    points.push([...coordinates[i + 1], t]);
  }

  // The speed the car holds on the fastest real stretch: the 95th percentile
  // by distance, so one odd fast segment does not set it.
  speedByMetre.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  let maxKmh = speedByMetre[speedByMetre.length - 1][0];
  for (const [kmh, d] of speedByMetre) {
    acc += d;
    if (acc >= metres * 0.95) {
      maxKmh = kmh;
      break;
    }
  }

  const simple = simplify(points, SIMPLIFY_M);
  return {
    fingerprint: fingerprint(spec),
    km: Math.round(metres / 10) / 100,
    minutes: Math.max(2, Math.round(t / 60)),
    maxKmh: Math.round(maxKmh),
    ...encodeTrack(simple),
  };
}

const all = process.argv.includes("--all");
const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const result = {};
let fetched = 0;

for (const [key, spec] of Object.entries(ROUTE_SPECS)) {
  const prior = existing[key];
  if (!all && prior && prior.fingerprint === fingerprint(spec)) {
    result[key] = prior;
    continue;
  }
  if (fetched > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
  result[key] = await fetchRoute(spec);
  fetched++;
  const { km, minutes, maxKmh } = result[key];
  const straight = distanceM(...[pointOf(spec.from), pointOf(spec.to)]) / 1000;
  console.log(
    `${key.padEnd(22)} ${String(km).padStart(7)} km  ${String(minutes).padStart(4)} min  max ${maxKmh} km/h  (${(km / straight).toFixed(2)}× straight)`,
  );
}

writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
console.log(`${fetched} fetched, ${Object.keys(result).length} routes in ${OUT}`);
