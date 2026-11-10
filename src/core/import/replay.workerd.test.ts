import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { replay } from "./replay";
import { ImportRepo } from "./repo";
import { vehicleData } from "../../../test/fixtures";
import type { ImportSnapshot } from "./types";

/**
 * Drives the replay engine against a real (local) D1, so what a history import
 * writes is checked against the same schema and the same aggregation SQL the
 * live logger uses.
 */

const CAR_ID = 90;
const T0 = Date.UTC(2024, 4, 1, 10, 0, 0);
const MINUTE = 60_000;
const SETTINGS = { suspend_min: 21, suspend_after_idle_min: 15, req_not_unlocked: false };

async function reset() {
  for (const table of ["charges", "charging_processes", "positions", "drives", "states", "updates", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO cars (id, vin, name, inserted_at, updated_at) VALUES (?, 'IMPORTVIN1', 'Imported', ?, ?)",
  )
    .bind(CAR_ID, T0, T0)
    .run();
  await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (?)").bind(CAR_ID).run();
}

function repo() {
  return new ImportRepo(env.DB, CAR_ID, { enabled: false });
}

function stream(snapshots: ImportSnapshot[]): AsyncIterable<ImportSnapshot> {
  return (async function* () {
    yield* snapshots;
  })();
}

/** A snapshot the way an adapter would hand one over. */
function snapshot(minutes: number, overrides: Parameters<typeof vehicleData>[0] = {}): ImportSnapshot {
  const at = T0 + minutes * MINUTE;
  return { at, data: vehicleData({ ...overrides, at }) };
}

async function run(snapshots: ImportSnapshot[]) {
  const { state } = await replay(stream(snapshots), repo(), { settings: SETTINGS });
  return state.counters;
}

describe("replaying a drive", () => {
  beforeEach(reset);

  it("reconstructs a drive from shift states and aggregates it", async () => {
    const counters = await run([
      snapshot(0, { shiftState: "P", odometer: 1000 }),
      snapshot(1, { shiftState: "D", odometer: 1000, speed: 0, ratedRange: 200 }),
      snapshot(2, { shiftState: "D", odometer: 1006.2137, speed: 60 }),
      snapshot(3, { shiftState: "D", odometer: 1012.4274, speed: 50 }),
      snapshot(4, { shiftState: "P", odometer: 1012.4274, ratedRange: 195 }),
    ]);

    expect(counters.drives).toBe(1);
    const drive = await env.DB.prepare("SELECT * FROM drives").first<Record<string, number | null>>();
    expect(drive).toMatchObject({ car_id: CAR_ID, duration_min: 3 });
    expect(drive!.distance).toBeCloseTo(20, 1); // 12.4274 miles
    expect(drive!.speed_max).toBe(97); // 60 mph
    expect(drive!.start_date_at).toBe(T0 + MINUTE);
    expect(drive!.end_date_at).toBe(T0 + 4 * MINUTE);

    const positions = await env.DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?")
      .bind(drive!.id)
      .first<{ n: number }>();
    expect(positions!.n).toBe(4);
  });

  it("applies the close rule to a drive that went nowhere", async () => {
    const counters = await run([
      snapshot(0, { shiftState: "P", odometer: 1000 }),
      snapshot(1, { shiftState: "D", odometer: 1000 }),
      snapshot(2, { shiftState: "P", odometer: 1000 }),
    ]);
    expect(counters.drives).toBe(0);
    expect(counters.drivesDiscarded).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM drives").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("ends a drive the export stops in the middle of", async () => {
    const counters = await run([
      snapshot(0, { shiftState: "D", odometer: 1000 }),
      snapshot(1, { shiftState: "D", odometer: 1006.2137 }),
      snapshot(2, { shiftState: "D", odometer: 1012.4274 }),
    ]);
    expect(counters.drives).toBe(1);
    const drive = await env.DB.prepare("SELECT end_date_at FROM drives").first<{ end_date_at: number }>();
    expect(drive!.end_date_at).toBe(T0 + 2 * MINUTE);
  });
});

describe("replaying a charge", () => {
  beforeEach(reset);

  it("reconstructs a session, its samples and its derived energy", async () => {
    const counters = await run([
      snapshot(0, { shiftState: "P", odometer: 1000 }),
      ...[1, 2, 3, 4].map((minute) =>
        snapshot(minute, {
          chargingState: "Charging",
          chargerPower: 11,
          chargerVoltage: 230,
          chargerActualCurrent: 16,
          chargerPhases: 3,
          chargeEnergyAdded: (minute - 1) * 0.18,
          batteryLevel: 50 + minute,
          ratedRange: 180 + minute,
        }),
      ),
      snapshot(5, { chargingState: "Complete", chargeEnergyAdded: 0.72, batteryLevel: 55, ratedRange: 185 }),
    ]);

    expect(counters.chargingProcesses).toBe(1);
    const session = await env.DB.prepare("SELECT * FROM charging_processes").first<Record<string, number | null>>();
    expect(session).toMatchObject({ car_id: CAR_ID, duration_min: 4, start_battery_level: 51, end_battery_level: 55 });
    expect(session!.charge_energy_added).toBeCloseTo(0.72, 2);
    expect(session!.charge_energy_used).toBeGreaterThan(0);
    const charges = await env.DB.prepare("SELECT COUNT(*) AS n FROM charges").first<{ n: number }>();
    expect(charges!.n).toBe(5); // four charging samples plus the one that ended it
  });

  it("ends the session when the export goes quiet mid-charge", async () => {
    await run([
      snapshot(0, { chargingState: "Charging", chargerPower: 11, chargeEnergyAdded: 0 }),
      snapshot(1, { chargingState: "Charging", chargerPower: 11, chargeEnergyAdded: 0.18 }),
      // A two-hour gap: the car went to sleep, so the session has to close.
      snapshot(121, { chargingState: "Disconnected", batteryLevel: 55 }),
    ]);
    const session = await env.DB.prepare("SELECT end_date_at FROM charging_processes").first<{ end_date_at: number }>();
    expect(session!.end_date_at).toBe(T0 + MINUTE);
  });
});

describe("replaying the state timeline", () => {
  beforeEach(reset);

  it("turns a data gap into a sleep, with the periods either side online", async () => {
    await run([
      snapshot(0, { shiftState: "P", odometer: 1000 }),
      snapshot(5, { shiftState: "P", odometer: 1000 }),
      // Eight hours of nothing — overnight.
      snapshot(485, { shiftState: "P", odometer: 1000 }),
      snapshot(490, { shiftState: "P", odometer: 1000 }),
    ]);

    const states = await env.DB.prepare("SELECT state, start_date_at, end_date_at FROM states ORDER BY start_date_at").all<{
      state: string;
      start_date_at: number;
      end_date_at: number | null;
    }>();
    // The export ending is itself treated as the car going quiet, so the
    // timeline does not claim the car has been online ever since.
    expect(states.results.map((row) => row.state)).toEqual(["online", "asleep", "online", "asleep"]);
    expect(states.results[0]).toMatchObject({ start_date_at: T0, end_date_at: T0 + 5 * MINUTE + 1_000 });
    expect(states.results[1]).toMatchObject({ end_date_at: T0 + 485 * MINUTE });
    expect(states.results[3]).toMatchObject({ start_date_at: T0 + 490 * MINUTE + 1_000, end_date_at: null });
  });

  it("keeps a location trail while parked and awake", async () => {
    // Half an hour of samples one minute apart, parked and locked.
    const snapshots = Array.from({ length: 31 }, (_, minute) =>
      snapshot(minute, { shiftState: "P", odometer: 1000, locked: true }),
    );
    const counters = await run(snapshots);
    // Every sample would be 31 rows; the five-minute heartbeat plus the sleep
    // position keeps it to a handful.
    expect(counters.positions).toBeGreaterThan(2);
    expect(counters.positions).toBeLessThan(10);
  });

  it("writes nothing at all for an empty export", async () => {
    const counters = await run([]);
    expect(counters).toMatchObject({ snapshots: 0, positions: 0, drives: 0, firstAt: null, lastAt: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM states").first<{ n: number }>()).toMatchObject({ n: 0 });
  });

  it("reports progress as it goes", async () => {
    const seen: number[] = [];
    await replay(
      stream(Array.from({ length: 10 }, (_, minute) => snapshot(minute, { shiftState: "P", odometer: 1000 }))),
      repo(),
      { settings: SETTINGS, progressEvery: 4, onProgress: (progress) => seen.push(progress.snapshots) },
    );
    expect(seen).toEqual([4, 8, 10]);
  });

  it("picks up where a previous slice stopped", async () => {
    const snapshots = [
      snapshot(0, { shiftState: "P", odometer: 1000 }),
      snapshot(1, { shiftState: "D", odometer: 1000, ratedRange: 200 }),
      snapshot(2, { shiftState: "D", odometer: 1006.2137 }),
      snapshot(3, { shiftState: "D", odometer: 1012.4274 }),
      snapshot(4, { shiftState: "P", odometer: 1012.4274, ratedRange: 195 }),
    ];

    // Stop after the second snapshot, mid-drive, and persist the state.
    let seen = 0;
    const first = await replay(stream(snapshots.slice(0, 2)), repo(), {
      settings: SETTINGS,
      stopAfter: () => ++seen >= 2,
    });
    expect(first.done).toBe(false);
    expect(first.state.counters.snapshots).toBe(2);
    expect(first.state.fsm.state.name).toBe("driving");

    // A round trip through storage: the state has to survive being serialised.
    const carried = JSON.parse(JSON.stringify(first.state));
    const second = await replay(stream(snapshots.slice(2)), repo(), {
      settings: SETTINGS,
      resume: carried,
    });

    expect(second.done).toBe(true);
    // Counters accumulate across slices, and the drive spans the boundary.
    expect(second.state.counters.snapshots).toBe(5);
    expect(second.state.counters.drives).toBe(1);
    const drives = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(start_date_at) AS s, MAX(end_date_at) AS e FROM drives").first<{
      n: number;
      s: number;
      e: number;
    }>();
    expect(drives).toMatchObject({ n: 1, s: T0 + MINUTE, e: T0 + 4 * MINUTE });
  });

  it("keeps the period covered contiguous across slices", async () => {
    const snapshots = Array.from({ length: 12 }, (_, minute) =>
      snapshot(minute, { shiftState: minute % 4 === 0 ? "P" : "D", odometer: 1000 + minute * 1.2427 }),
    );

    // Three slices of four snapshots each.
    let state = undefined;
    let done = false;
    let slices = 0;
    let offset = 0;
    while (!done) {
      let seen = 0;
      const result = await replay(stream(snapshots.slice(offset)), repo(), {
        settings: SETTINGS,
        resume: state,
        stopAfter: () => ++seen >= 4,
      });
      state = result.state;
      done = result.done;
      offset += seen;
      slices++;
      expect(slices).toBeLessThan(10); // no infinite loop
    }

    expect(state!.counters.snapshots).toBe(12);
    expect(state!.counters.firstAt).toBe(T0);
    expect(state!.counters.lastAt).toBe(T0 + 11 * MINUTE);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const snapshots = Array.from({ length: 100 }, (_, minute) => snapshot(minute, { shiftState: "P", odometer: 1000 }));
    const promise = replay(stream(snapshots), repo(), {
      settings: SETTINGS,
      progressEvery: 5,
      onProgress: () => controller.abort(),
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow();
  });
});
