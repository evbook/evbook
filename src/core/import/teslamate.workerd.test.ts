import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryBundle } from "./bundle";
import { runImport } from "./index";
import { purgeImport } from "./teslamate";
import { NEW_DUMP, NEW_VIN_1, OLD_DUMP, at } from "../../../test/teslamate-dump";
import { clearTables } from "../../../test/db";
import { reconstructHiddenEvents } from "../../db/hiddenEvents";
import { repairDriveOrigins } from "../../db/repair";

/**
 * The TeslaMate import against D1 — numbered parameters, RETURNING in a batch
 * and multi-row literal INSERTs all have to hold there, not only on
 * `node:sqlite` (`teslamate.test.ts`).
 */

const backup = (text = NEW_DUMP) => memoryBundle("teslamate.bck", { "teslamate.bck": text });

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

/**
 * Runs both sweeps over all of history in the cron's order: the origin sweep
 * first (a missed drive start is the drive's own), then the hidden-event sweep.
 */
async function sweepGaps(): Promise<number> {
  await env.DB.prepare(
    "UPDATE settings SET drive_origin_swept_before = NULL, gaps_swept_until = NULL WHERE id = 1",
  ).run();
  for (let i = 0; i < 50; i++) await repairDriveOrigins(env.DB, env.NOMINATIM_HOST);
  let recorded = 0;
  for (let i = 0; i < 400; i++) recorded += (await reconstructHiddenEvents(env.DB)).recorded;
  return recorded;
}

beforeEach(async () => {
  await clearTables("charges", "charging_processes", "positions", "drives", "states", "updates", "imports", "cars");
});

describe("TeslaMate import on D1", () => {
  it("writes every car's history, and replaces it when imported again", async () => {
    const report = await runImport({ db: env.DB, bundle: backup() });
    expect(report).toMatchObject({ drives: 3, chargingProcesses: 2, charges: 3, positions: 10 });
    expect(report.skipped).toEqual({ overlapping: 0, unfinished: 2 });

    await runImport({ db: env.DB, bundle: backup() });
    expect([await count("drives"), await count("positions"), await count("charges"), await count("imports")]).toEqual([
      3, 10, 3, 2,
    ]);
    const session = await env.DB.prepare("SELECT cost_cents FROM charging_processes WHERE start_date_at = ?")
      .bind(at("2023-01-01 18:00:00"))
      .first<{ cost_cents: number }>();
    expect(session!.cost_cents).toBe(420);
  });

  it("leaves the hidden-event sweep nothing to reconstruct", async () => {
    await runImport({ db: env.DB, bundle: backup() });
    expect(await sweepGaps()).toBe(0);
  });

  it("stops at EVBook's first reading of the car", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO cars (id, vin, name, inserted_at, updated_at) VALUES (9, ?, 'Mine', ?, ?)")
      .bind(NEW_VIN_1, now, now)
      .run();
    await env.DB.prepare("INSERT INTO states (car_id, state, start_date_at, end_date_at) VALUES (9, 'online', ?, ?)")
      .bind(at("2023-01-03 00:00:00"), at("2023-01-03 01:00:00"))
      .run();

    const report = await runImport({ db: env.DB, bundle: backup(), vin: NEW_VIN_1 });
    expect(report.skipped).toEqual({ overlapping: 1, unfinished: 2 });
    expect(report.drives).toBe(1);
  });

  it("reads an older layout, and deletes cleanly", async () => {
    const report = await runImport({ db: env.DB, bundle: backup(OLD_DUMP) });
    expect(report).toMatchObject({ drives: 1, charges: 2, positions: 3, states: 2 });
    const record = await env.DB.prepare("SELECT id FROM imports").first<{ id: number }>();

    expect((await purgeImport(env.DB, record!.id)).done).toBe(true);
    expect([await count("drives"), await count("positions"), await count("charges"), await count("states")]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});
