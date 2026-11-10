import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "./repo";
import { ImportRepo } from "../core/import/repo";
import { createPosition } from "../core/tesla/payload";
import { driving } from "../../test/fixtures";

/**
 * Elevation enrichment against a real (local) SQLite database, with the terrain
 * service stubbed. What is being covered is the cache: the whole point of the
 * `terrain` table is that a road is only ever asked about once, and the way that
 * goes wrong is silently — by working, but sending a request every time.
 */

const T0 = 1_700_000_000_000;
const CAR_ID = 1;
const HOST = "http://terrain.test";

async function reset() {
  for (const table of ["positions", "drives", "terrain", "car_settings", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, 10, 20, 'VIN1', 'Bro', ?, ?)",
  )
    .bind(CAR_ID, T0, T0)
    .run();
  await env.DB.prepare("INSERT INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
}

/** Answers every coordinate with a height derived from its latitude. */
function stubTerrain(): { urls: string[]; coordinates: () => number } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(String(url));
    const lats = (new URL(String(url)).searchParams.get("latitude") ?? "").split(",").filter(Boolean);
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ elevation: lats.map((lat) => Math.round(Number(lat) * 2)) }),
    } as Response);
  });
  return {
    urls,
    coordinates: () =>
      urls.reduce(
        (total, url) => total + (new URL(url).searchParams.get("latitude") ?? "").split(",").filter(Boolean).length,
        0,
      ),
  };
}

/** A drive along a track of coordinates, left open. */
async function openDriveAlong(repo: Repo, points: { latitude: number; longitude: number }[]): Promise<number> {
  const driveId = await repo.openDrive(T0);
  await repo.insertPositions(
    points.map((point, i) => ({
      driveId,
      attrs: createPosition(
        driving({ at: T0 + i * 60_000, odometer: 1000 + i * 5, speed: 30, ...point }),
      ),
    })),
  );
  return driveId;
}

function repo(): Repo {
  return new Repo(env.DB, CAR_ID, undefined, HOST);
}

beforeEach(reset);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("elevation enrichment", () => {
  it("fills every position on the drive and caches what it learned", async () => {
    stubTerrain();
    const r = repo();
    const driveId = await openDriveAlong(r, [
      { latitude: 52.52, longitude: 13.4 },
      { latitude: 52.53, longitude: 13.41 },
      { latitude: 52.54, longitude: 13.42 },
    ]);

    const result = await r.enrichElevations(driveId);
    expect(result).toEqual({ filled: 3, requests: 1, skipped: 0 });

    const rows = await env.DB.prepare("SELECT elevation FROM positions WHERE drive_id = ? ORDER BY date_at")
      .bind(driveId)
      .all<{ elevation: number }>();
    expect(rows.results.map((row) => row.elevation)).toEqual([105, 105, 105]);

    const cached = await env.DB.prepare("SELECT COUNT(*) AS n FROM terrain").first<{ n: number }>();
    expect(cached?.n).toBe(3);
  });

  it("asks about a coordinate once, however many positions sit on it", async () => {
    const terrain = stubTerrain();
    const r = repo();
    // Twenty positions on ten distinct 11 m squares — a car in traffic.
    const driveId = await openDriveAlong(
      r,
      Array.from({ length: 20 }, (_, i) => ({ latitude: 52.52 + Math.floor(i / 2) / 1000, longitude: 13.4 })),
    );

    expect(await r.enrichElevations(driveId)).toEqual({ filled: 20, requests: 1, skipped: 0 });
    expect(terrain.coordinates()).toBe(10);
  });

  it("makes no request at all for a road it has already seen", async () => {
    const terrain = stubTerrain();
    const track = [
      { latitude: 52.52, longitude: 13.4 },
      { latitude: 52.53, longitude: 13.41 },
    ];

    const first = repo();
    await first.enrichElevations(await openDriveAlong(first, track));
    expect(terrain.urls).toHaveLength(1);

    // The commute home over the same road.
    const second = repo();
    const back = await openDriveAlong(second, track);
    expect(await second.enrichElevations(back)).toEqual({ filled: 2, requests: 0, skipped: 0 });
    expect(terrain.urls).toHaveLength(1);
  });

  it("remembers a coordinate with no answer, so it is not asked about forever", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, json: () => Promise.resolve({ elevation: [null] }) } as Response));
    const r = repo();
    const driveId = await openDriveAlong(r, [{ latitude: 0, longitude: 0 }]);

    // Nothing to write onto the position, but the coordinate is now known-unknown.
    expect(await r.enrichElevations(driveId)).toEqual({ filled: 0, requests: 1, skipped: 0 });
    const cached = await env.DB.prepare("SELECT elevation FROM terrain").first<{ elevation: number | null }>();
    expect(cached).toEqual({ elevation: null });

    const again = repo();
    expect(await again.enrichElevations(await openDriveAlong(again, [{ latitude: 0, longitude: 0 }]))).toEqual({ filled: 0, requests: 0, skipped: 0 });
  });

  it("caches nothing when the service fails, so the next drive tries again", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response));
    const r = repo();
    const driveId = await openDriveAlong(r, [{ latitude: 52.52, longitude: 13.4 }]);

    expect(await r.enrichElevations(driveId)).toEqual({ filled: 0, requests: 1, skipped: 0 });
    const cached = await env.DB.prepare("SELECT COUNT(*) AS n FROM terrain").first<{ n: number }>();
    expect(cached?.n).toBe(0);

    const position = await env.DB.prepare("SELECT elevation FROM positions WHERE drive_id = ?")
      .bind(driveId)
      .first<{ elevation: number | null }>();
    expect(position?.elevation).toBeNull();
  });

  it("splits a long drive into batches the service will accept", async () => {
    const terrain = stubTerrain();
    const r = repo();
    // 250 distinct coordinates -> three requests at 100 per batch.
    const driveId = await openDriveAlong(
      r,
      Array.from({ length: 250 }, (_, i) => ({ latitude: 52.5 + i / 1000, longitude: 13.4 })),
    );

    expect(await r.enrichElevations(driveId)).toEqual({ filled: 250, requests: 3, skipped: 0 });
    expect(terrain.coordinates()).toBe(250);
  });

  it("stops at the request budget rather than holding the drive close open", async () => {
    const terrain = stubTerrain();
    const r = repo();
    // 4,500 distinct coordinates — a day's driving at a 2.5 s poll. The budget is
    // 40 requests of 100, so 4,000 get asked about and the rest are reported as
    // skipped instead of silently coming back with no elevation.
    const driveId = await openDriveAlong(
      r,
      Array.from({ length: 4_500 }, (_, i) => ({ latitude: 52.0 + i / 10_000, longitude: 13.4 })),
    );

    const result = await r.enrichElevations(driveId);
    expect(result.requests).toBe(40);
    expect(result.filled).toBe(4_000);
    expect(result.skipped).toBe(500);
    expect(terrain.coordinates()).toBe(4_000);

    // What did resolve is cached, so driving the road again resumes rather than
    // starting over.
    const cached = await env.DB.prepare("SELECT COUNT(*) AS n FROM terrain").first<{ n: number }>();
    expect(cached?.n).toBe(4_000);
  });

  it("runs as part of closing a drive", async () => {
    stubTerrain();
    const r = repo();
    const driveId = await openDriveAlong(r, [
      { latitude: 52.52, longitude: 13.4 },
      { latitude: 52.55, longitude: 13.45 },
    ]);

    await r.closeDrive(driveId);
    const filled = await env.DB.prepare(
      "SELECT COUNT(elevation) AS n FROM positions WHERE drive_id = ?",
    )
      .bind(driveId)
      .first<{ n: number }>();
    expect(filled?.n).toBe(2);
  });

  it("is a no-op for an import, which replays history", async () => {
    const terrain = stubTerrain();
    const importRepo = new ImportRepo(env.DB, CAR_ID, { enabled: false });
    const driveId = await openDriveAlong(importRepo, [
      { latitude: 52.52, longitude: 13.4 },
      { latitude: 52.53, longitude: 13.41 },
    ]);

    await importRepo.closeDrive(driveId);
    expect(terrain.urls).toHaveLength(0);
    const filled = await env.DB.prepare("SELECT COUNT(elevation) AS n FROM positions WHERE drive_id = ?")
      .bind(driveId)
      .first<{ n: number }>();
    expect(filled?.n).toBe(0);
  });
});
