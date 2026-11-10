import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { captureBaseline, clearOverlap, resolveCar, runImport } from "./index";
import { memoryBundle } from "./bundle";
import { TESSIE_DAY, TESSIE_VIN, tessieCsvFiles } from "../../../test/tessie-export";
import type { ImportBundle } from "./types";

/**
 * End to end: a Tessie-shaped export in, rows out of the real D1 — car
 * resolution, the dry run, and re-importing over an earlier run.
 */

const VIN = TESSIE_VIN;
const DAY = TESSIE_DAY;

function tessieExport(): ImportBundle {
  return memoryBundle(`${VIN}.zip`, tessieCsvFiles());
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

beforeEach(async () => {
  for (const table of ["charges", "charging_processes", "positions", "drives", "states", "updates", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("running an import", () => {
  it("creates the car from the VIN and writes its history", async () => {
    const report = await runImport({ db: env.DB, bundle: tessieExport() });

    expect(report.source).toBe("tessie");
    expect(report.vin).toBe(VIN);
    expect(report.snapshots).toBeGreaterThan(50);
    expect(report.drives).toBe(2);
    expect(report.distanceKm).toBeCloseTo(40, 0);
    expect(report.chargingProcesses).toBe(1);
    expect(report.energyAddedKwh).toBeCloseTo(9, 0); // pack went 40 -> 49 kWh

    const car = await env.DB.prepare("SELECT * FROM cars WHERE vin = ?").bind(VIN).first<{
      id: number;
      model: string | null;
      name: string | null;
      eid: number | null;
    }>();
    expect(car).toMatchObject({ model: "3", name: VIN, eid: null });
    expect(report.carId).toBe(car!.id);

    // Polling stays off: an imported car has no Tesla id to poll with. The pack
    // chemistry is read off the VIN — this one's position 7 is `E`, not LFP.
    const settings = await env.DB.prepare("SELECT enabled, lfp_battery FROM car_settings WHERE car_id = ?")
      .bind(car!.id)
      .first<{ enabled: number; lfp_battery: number }>();
    expect(settings).toMatchObject({ enabled: 0, lfp_battery: 0 });

    expect(await count("drives")).toBe(2);
    expect(await count("charging_processes")).toBe(1);
    expect(await count("positions")).toBeGreaterThan(20);
  });

  it("sets the LFP flag on a car whose VIN says the pack is lithium iron phosphate", async () => {
    const lfpVin = "LRW3E7FA8MC123456"; // position 7 is `F`
    const report = await runImport({ db: env.DB, bundle: memoryBundle(`${lfpVin}.zip`, tessieCsvFiles()) });

    const settings = await env.DB.prepare("SELECT lfp_battery FROM car_settings WHERE car_id = ?")
      .bind(report.carId)
      .first<{ lfp_battery: number }>();
    expect(settings!.lfp_battery).toBe(1);
  });

  it("names the car when asked", async () => {
    const report = await runImport({ db: env.DB, bundle: tessieExport(), carName: "Bro" });
    const car = await env.DB.prepare("SELECT name FROM cars WHERE id = ?").bind(report.carId).first<{ name: string }>();
    expect(car!.name).toBe("Bro");
  });

  it("imports into an existing car rather than making a second one", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (7, 1, 2, ?, 'Mine', ?, ?)")
      .bind(VIN, now, now)
      .run();
    await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (7)").run();

    const report = await runImport({ db: env.DB, bundle: tessieExport() });
    expect(report.carId).toBe(7);
    expect(await count("cars")).toBe(1);
    // The existing car's own settings are left alone.
    const settings = await env.DB.prepare("SELECT enabled FROM car_settings WHERE car_id = 7").first<{ enabled: number }>();
    expect(settings!.enabled).toBe(1);
  });

  it("honours a window", async () => {
    const report = await runImport({
      db: env.DB,
      bundle: tessieExport(),
      since: Date.parse(`${DAY}T08:35:00Z`),
    });
    expect(report.drives).toBe(1);
    expect(report.chargingProcesses).toBe(0);
  });

  it("writes nothing on a dry run", async () => {
    const report = await runImport({ bundle: tessieExport(), dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.snapshots).toBeGreaterThan(50);
    expect(report.drives).toBe(2); // shift transitions seen
    expect(await count("cars")).toBe(0);
    expect(await count("positions")).toBe(0);
  });

  it("is idempotent: re-importing the same export replaces, not duplicates", async () => {
    const first = await runImport({ db: env.DB, bundle: tessieExport() });
    const again = await runImport({ db: env.DB, bundle: tessieExport() });

    expect(again.carId).toBe(first.carId);
    expect(await count("drives")).toBe(2);
    expect(await count("charging_processes")).toBe(1);
    expect(again.replacedRows).toBeGreaterThan(0);
    expect(again.warnings.join(" ")).toMatch(/replaced \d+ row/);
  });

  it("merges a period the car has never seen, leaving the rest alone", async () => {
    // Morning only, then afternoon only: nothing overlaps, so both survive.
    const morning = await runImport({ db: env.DB, bundle: tessieExport(), until: Date.parse(`${DAY}T08:20:00Z`) });
    const afternoon = await runImport({ db: env.DB, bundle: tessieExport(), since: Date.parse(`${DAY}T08:35:00Z`) });

    expect(afternoon.carId).toBe(morning.carId);
    expect(afternoon.replacedRows).toBe(0);
    expect(await count("drives")).toBe(2);
  });

  it("replaces only the overlapping part of an existing history", async () => {
    await runImport({ db: env.DB, bundle: tessieExport() });
    const morningDrive = await env.DB.prepare("SELECT id FROM drives ORDER BY start_date_at LIMIT 1").first<{ id: number }>();

    // Re-import the afternoon only: the morning drive keeps its original row.
    const redo = await runImport({ db: env.DB, bundle: tessieExport(), since: Date.parse(`${DAY}T08:35:00Z`) });

    expect(redo.replacedRows).toBeGreaterThan(0);
    expect(await count("drives")).toBe(2);
    const surviving = await env.DB.prepare("SELECT id FROM drives ORDER BY start_date_at LIMIT 1").first<{ id: number }>();
    expect(surviving!.id).toBe(morningDrive!.id);
  });

  it("leaves another car's history untouched", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO cars (id, vin, name, inserted_at, updated_at) VALUES (9, 'OTHERVIN', 'Other', ?, ?)")
      .bind(now, now)
      .run();
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at, end_date_at, distance) VALUES (9, ?, ?, 10)")
      .bind(Date.parse(`${DAY}T08:05:00Z`), Date.parse(`${DAY}T08:09:00Z`))
      .run();

    await runImport({ db: env.DB, bundle: tessieExport() });
    await runImport({ db: env.DB, bundle: tessieExport() });

    const other = await env.DB.prepare("SELECT COUNT(*) AS n FROM drives WHERE car_id = 9").first<{ n: number }>();
    expect(other!.n).toBe(1);
  });

  it("refuses an export it cannot place", async () => {
    const bundle = memoryBundle("mystery.zip", { "data.csv": "a,b\n1,2\n" });
    await expect(runImport({ db: env.DB, bundle })).rejects.toThrow(/could not tell which service/);
  });

  it("rejects an unknown --source", async () => {
    await expect(runImport({ db: env.DB, bundle: tessieExport(), sourceId: "teslafi" })).rejects.toThrow(
      /unknown import source/,
    );
  });

  it("reports the best-effort notes the adapter raised", async () => {
    const report = await runImport({ db: env.DB, bundle: tessieExport() });
    expect(report.warnings.join("\n")).toMatch(/tpms_pressure_fl\.csv is not in the export/);
  });
});

describe("car resolution", () => {
  it("needs something to go on when the database is empty", async () => {
    await expect(resolveCar(env.DB, { vin: null })).rejects.toThrow(/no car to import into/);
    await expect(resolveCar(env.DB, { carId: 404, vin: null })).rejects.toThrow(/does not exist/);
  });

  it("falls back to the only car when the export carries no VIN", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (4, 'ONLYCAR', ?, ?)")
      .bind(now, now)
      .run();
    expect(await resolveCar(env.DB, { vin: null })).toEqual({ carId: 4, how: "only-car" });

    // With two cars there is nothing to guess from.
    await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (5, 'SECONDCAR', ?, ?)")
      .bind(now, now)
      .run();
    await expect(resolveCar(env.DB, { vin: null })).rejects.toThrow(/ONLYCAR, SECONDCAR/);
  });

  it("says so in the report when it fell back to the only car", async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (6, 'ONLYCAR', ?, ?)")
      .bind(now, now)
      .run();
    await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (6)").run();

    // A bundle whose name carries no VIN.
    const report = await runImport({ db: env.DB, bundle: memoryBundle("export.zip", tessieCsvFiles()) });
    expect(report.carId).toBe(6);
    expect(report.warnings.join(" ")).toMatch(/no VIN — importing into the only car/);
  });
});

describe("clearing an overlap", () => {
  it("removes rows inside the period, but only ones older than the baseline", async () => {
    const report = await runImport({ db: env.DB, bundle: tessieExport() });
    const baseline = await captureBaseline(env.DB);

    // Everything is at or below the baseline now, so the afternoon goes.
    const removed = await clearOverlap(env.DB, report.carId, Date.parse(`${DAY}T08:35:00Z`), Date.now(), baseline);
    expect(removed).toBeGreaterThan(0);
    expect(await count("drives")).toBe(1); // the morning drive survives

    // With a baseline taken before anything existed, nothing is old enough.
    const untouched = await clearOverlap(env.DB, report.carId, 0, Date.now(), {
      drives: 0,
      positions: 0,
      chargingProcesses: 0,
      charges: 0,
      states: 0,
      updates: 0,
    });
    expect(untouched).toBe(0);
    expect(await count("drives")).toBe(1);
  });
});
