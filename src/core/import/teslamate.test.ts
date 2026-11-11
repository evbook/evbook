import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { memoryBundle } from "./bundle";
import { runImport } from "./index";
import { purgeImport, teslamateImporter } from "./teslamate";
import { openSqlite, type LocalSqlite } from "../../platform/node/sqlite";
import { runMigrations } from "../../platform/node/migrate";
import { NEW_DUMP, NEW_VIN_1, NEW_VIN_2, OLD_DUMP, OLD_VIN, at } from "../../../test/teslamate-dump";

/**
 * The TeslaMate import on the Node runtime's database (`node:sqlite`); the
 * same import against D1 is `teslamate.workerd.test.ts`.
 */

function freshDb(): LocalSqlite {
  const local = openSqlite(":memory:");
  runMigrations(local.sqlite, join(import.meta.dirname, "../../../migrations"));
  return local;
}

const backup = (text = NEW_DUMP) => memoryBundle("teslamate.bck", { "teslamate.bck": text });

function rows<T = Record<string, unknown>>(local: LocalSqlite, sql: string, ...params: (string | number)[]): T[] {
  return local.sqlite.prepare(sql).all(...params) as T[];
}

function count(local: LocalSqlite, table: string): number {
  return (local.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const HISTORY = ["drives", "positions", "charging_processes", "charges", "states", "updates"];

function snapshot(local: LocalSqlite) {
  return Object.fromEntries(HISTORY.map((table) => [table, count(local, table)]));
}

describe("importing a TeslaMate backup", () => {
  it("writes drives, positions, sessions, charges, states and updates for every car", async () => {
    const local = freshDb();
    const report = await runImport({ db: local.db, bundle: backup() });

    expect(report.source).toBe("teslamate");
    expect(report.drives).toBe(3);
    expect(report.chargingProcesses).toBe(2);
    expect(report.charges).toBe(3);
    expect(report.positions).toBe(10);
    // The open drive and the open session.
    expect(report.skipped).toEqual({ overlapping: 0, unfinished: 2 });
    expect(snapshot(local)).toEqual({
      drives: 3,
      positions: 10,
      charging_processes: 2,
      charges: 3,
      // The still-open asleep state of car 1 is unfinished, so left out.
      states: 4,
      updates: 2,
    });

    const cars = rows<{ vin: string; name: string; marketing_name: string | null; efficiency: number | null }>(
      local,
      "SELECT vin, name, marketing_name, efficiency FROM cars ORDER BY id",
    );
    expect(cars.map((car) => [car.vin, car.name, car.marketing_name])).toEqual([
      [NEW_VIN_1, "Bolt", "Long Range AWD"],
      [NEW_VIN_2, "Ypsilon", null],
    ]);
  });

  it("keeps TeslaMate's own figures, references and costs", async () => {
    const local = freshDb();
    await runImport({ db: local.db, bundle: backup() });

    const [drive] = rows<Record<string, number | null>>(
      local,
      "SELECT * FROM drives WHERE start_date_at = ?",
      at("2023-01-01 08:00:00"),
    );
    expect(drive).toMatchObject({
      end_date_at: at("2023-01-01 08:30:00"),
      distance: 25.5,
      duration_min: 30,
      speed_max: 120,
      power_min: -60,
      start_rated_range_km: 290,
    });
    // References land on EVBook's own ids.
    const [start] = rows<{ display_name: string; raw: string }>(
      local,
      "SELECT display_name, raw FROM addresses WHERE id = ?",
      drive!.start_address_id!,
    );
    expect(start!.display_name).toBe("Home\tSweet \\ Home, Hauptstraße 1, Berlin");
    expect(JSON.parse(start!.raw)).toEqual({ note: "line one\nline two" });
    const [end] = rows<{ display_name: string }>(
      local,
      "SELECT display_name FROM addresses WHERE id = ?",
      drive!.end_address_id!,
    );
    expect(end!.display_name).toBe("Café Central, Wien");
    const [fence] = rows<Record<string, unknown>>(
      local,
      "SELECT * FROM geofences WHERE id = ?",
      drive!.start_geofence_id!,
    );
    expect(fence).toMatchObject({ name: "Home", cost_per_unit: 0.32, session_fee_cents: 50, billing_type: "per_kwh" });

    // The drive's track, and its ends.
    const track = rows<{ id: number; date_at: number }>(
      local,
      "SELECT id, date_at FROM positions WHERE drive_id = ? ORDER BY date_at",
      drive!.id!,
    );
    expect(track.map((p) => p.date_at)).toEqual([
      at("2023-01-01 08:00:00"),
      at("2023-01-01 08:15:00"),
      at("2023-01-01 08:30:00"),
    ]);
    expect([drive!.start_position_id, drive!.end_position_id]).toEqual([track[0]!.id, track[2]!.id]);

    const [session] = rows<Record<string, number | null>>(
      local,
      "SELECT * FROM charging_processes WHERE start_date_at = ?",
      at("2023-01-01 18:00:00"),
    );
    expect(session).toMatchObject({ charge_energy_added: 45.2, charge_energy_used: 49.5, cost_cents: 420 });
    const [where] = rows<{ date_at: number; drive_id: number | null }>(
      local,
      "SELECT date_at, drive_id FROM positions WHERE id = ?",
      session!.position_id!,
    );
    expect(where).toEqual({ date_at: at("2023-01-01 18:00:00"), drive_id: null });
    const samples = rows<{ charge_energy_added: number; charger_phases: number }>(
      local,
      "SELECT charge_energy_added, charger_phases FROM charges WHERE charging_process_id = ? ORDER BY date_at",
      session!.id!,
    );
    expect(samples).toEqual([
      { charge_energy_added: 0.5, charger_phases: 3 },
      { charge_energy_added: 45.2, charger_phases: 3 },
    ]);

    // The Supercharger session of the second car keeps its charger's identity.
    const [fast] = rows<{ fast_charger_type: string; fast_charger_present: number; car: string }>(
      local,
      "SELECT ch.fast_charger_type, ch.fast_charger_present, c.vin AS car FROM charges ch " +
        "JOIN charging_processes cp ON cp.id = ch.charging_process_id JOIN cars c ON c.id = cp.car_id " +
        "WHERE ch.date_at = ?",
      at("2023-01-04 12:10:00"),
    );
    expect(fast).toEqual({ fast_charger_type: "Supercharger", fast_charger_present: 1, car: NEW_VIN_2 });
  });

  it("reads an older layout by column name, and says what it lacks", async () => {
    const local = freshDb();
    const report = await runImport({ db: local.db, bundle: backup(OLD_DUMP) });

    expect(report.vin).toBe(OLD_VIN);
    expect(report.warnings).toContain("the backup has no geofences table");
    expect(report.warnings).toContain("the backup has no updates table");
    expect(snapshot(local)).toEqual({
      drives: 1,
      positions: 3,
      charging_processes: 1,
      charges: 2,
      states: 2,
      updates: 0,
    });
    const [drive] = rows<Record<string, unknown>>(
      local,
      "SELECT distance, start_km, speed_max, start_rated_range_km FROM drives",
    );
    expect(drive).toEqual({ distance: 40.2, start_km: 50000, speed_max: 140, start_rated_range_km: null });
    const [car] = rows<{ name: string }>(local, "SELECT name FROM cars");
    expect(car!.name).toBe("Old \\ Faithful");
    const [address] = rows<{ display_name: string }>(local, "SELECT display_name FROM addresses");
    expect(address!.display_name).toBe("Bahnhofstrasse 1, Zürich");
  });

  it("imports one car of several when asked for it by VIN", async () => {
    const local = freshDb();
    const report = await runImport({ db: local.db, bundle: backup(), vin: NEW_VIN_2 });
    expect(report.drives).toBe(1);
    expect(rows<{ vin: string }>(local, "SELECT vin FROM cars")).toEqual([{ vin: NEW_VIN_2 }]);
  });
});

describe("what EVBook already has", () => {
  it("takes only history from before EVBook's first reading of the car", async () => {
    const local = freshDb();
    const now = Date.now();
    local.sqlite
      .prepare("INSERT INTO cars (id, vin, name, inserted_at, updated_at) VALUES (7, ?, 'Mine', ?, ?)")
      .run(NEW_VIN_1, now, now);
    // EVBook started logging on the 3rd at midnight.
    const cutoff = at("2023-01-03 00:00:00");
    local.sqlite
      .prepare("INSERT INTO positions (car_id, date_at, latitude, longitude) VALUES (7, ?, 52.5, 13.4)")
      .run(cutoff);

    const report = await runImport({ db: local.db, bundle: backup(), vin: NEW_VIN_1 });

    // Drive 3 (the 3rd, 10:00) is after the cutoff; drive 2 was never finished.
    expect(report.skipped).toEqual({ overlapping: 1, unfinished: 2 });
    expect(report.carId).toBe(7);
    const after = rows(
      local,
      "SELECT id FROM positions WHERE car_id = 7 AND date_at >= ? AND import_id IS NOT NULL",
      cutoff,
    );
    expect(after).toEqual([]);
    expect(count(local, "drives")).toBe(1);
    // The state running across the cutoff is cut short there; the later ones are left out.
    const states = rows<{ state: string; end_date_at: number }>(
      local,
      "SELECT state, end_date_at FROM states WHERE car_id = 7 ORDER BY start_date_at",
    );
    expect(states.map((state) => state.state)).toEqual(["online", "asleep", "online"]);
    expect(states[2]!.end_date_at).toBe(cutoff);
    const [record] = rows<{ cutoff_at: number; status: string }>(local, "SELECT cutoff_at, status FROM imports");
    expect(record).toEqual({ cutoff_at: cutoff, status: "done" });
  });

  it("replaces the previous TeslaMate import of the car rather than adding to it", async () => {
    const local = freshDb();
    await runImport({ db: local.db, bundle: backup() });
    const first = snapshot(local);
    const addresses = count(local, "addresses");
    const second = await runImport({ db: local.db, bundle: backup() });

    expect(snapshot(local)).toEqual(first);
    // Its own rows were replaced, not mistaken for EVBook's first reading.
    expect(second.skipped).toEqual({ overlapping: 0, unfinished: 2 });
    expect(second.replacedRows).toBeGreaterThan(0);
    expect(count(local, "imports")).toBe(2); // one per car
    expect(count(local, "geofences")).toBe(1);
    // Addresses with an OSM id are shared, not doubled; the one without is new.
    expect(count(local, "addresses")).toBe(addresses + 1);
  });

  it("deleting an import removes everything it brought, and nothing else", async () => {
    const local = freshDb();
    await runImport({ db: local.db, bundle: backup() });
    const car = rows<{ id: number }>(local, "SELECT id FROM cars WHERE vin = ?", NEW_VIN_1)[0]!.id;
    // Something the live logger wrote since.
    local.sqlite
      .prepare("INSERT INTO positions (car_id, date_at, latitude, longitude) VALUES (?, ?, 52.5, 13.4)")
      .run(car, Date.now());
    const [{ id }] = rows<{ id: number }>(local, "SELECT id FROM imports WHERE car_id = ?", car) as [{ id: number }];

    // In small steps, the way the API does it when there is a lot.
    let calls = 0;
    let result = await purgeImport(local.db, id, () => ++calls > 0);
    while (!result.done) result = await purgeImport(local.db, id);

    for (const table of HISTORY) {
      expect(rows(local, `SELECT id FROM ${table} WHERE import_id = ?`, id)).toEqual([]);
    }
    expect(rows(local, "SELECT id FROM imports WHERE id = ?", id)).toEqual([]);
    expect(rows(local, "SELECT id FROM positions WHERE car_id = ?", car)).toHaveLength(1);
    // The other car's import is untouched.
    expect(count(local, "drives")).toBe(1);
  });
});

describe("in slices", () => {
  it("lands the same rows when stopped after every batch and resumed from its state", async () => {
    const whole = freshDb();
    await runImport({ db: whole.db, bundle: backup() });

    const sliced = freshDb();
    const bundle = backup();
    let state = await teslamateImporter.prepare(sliced.db, bundle, { label: "teslamate.bck" });
    let slices = 0;
    for (;;) {
      slices++;
      // A copy through JSON, the way the actor's storage hands it back.
      const result = await teslamateImporter.slice(sliced.db, bundle, JSON.parse(JSON.stringify(state)), {
        stopAfter: () => true,
        batchRows: 2,
      });
      state = result.state;
      if (result.done) break;
      expect(slices).toBeLessThan(200);
    }

    expect(slices).toBeGreaterThan(10);
    expect(snapshot(sliced)).toEqual(snapshot(whole));
    const tracks = (local: LocalSqlite) =>
      rows(
        local,
        "SELECT d.start_date_at, p.date_at, p.latitude FROM positions p LEFT JOIN drives d ON d.id = p.drive_id ORDER BY p.date_at",
      );
    expect(tracks(sliced)).toEqual(tracks(whole));
    const sessions = (local: LocalSqlite) =>
      rows(
        local,
        "SELECT cp.start_date_at, ch.date_at, ch.charge_energy_added FROM charges ch " +
          "JOIN charging_processes cp ON cp.id = ch.charging_process_id ORDER BY ch.date_at",
      );
    expect(sessions(sliced)).toEqual(sessions(whole));
    expect(teslamateImporter.progress(state, null, null)).toMatchObject({ fraction: 1, drives: 3, positions: 10 });
  });
});
