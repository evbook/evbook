import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TESSIE_VIN, tessieCsvFiles, tessieZip } from "../../test/tessie-export";
import { memoryBundle } from "../core/import/bundle";
import { runImport } from "../core/import/index";
import type { ImportJobDto } from "@shared/api-types";

/**
 * The import job itself: an uploaded zip in this object's storage, worked
 * through on alarms. Alarms are fired by hand here so a whole import runs
 * deterministically inside the spec.
 */

const SLICE_BYTES = 512 * 1024;

/**
 * Its own instance, not the "default" one the routes use: a Durable Object
 * touched by one spec file is invalidated for the next (see docs/testing.md), and
 * `src/api/imports.test.ts` drives "default" through the router.
 */
function stub() {
  return env.IMPORT_DO.getByName("import-do-spec");
}

async function uploadAndStart(days = 1, label = `${TESSIE_VIN}.zip`): Promise<ImportJobDto> {
  const zip = await tessieZip(days);
  await stub().begin(label);
  for (let offset = 0; offset < zip.length; offset += SLICE_BYTES) {
    await stub().append(zip.subarray(offset, offset + SLICE_BYTES));
  }
  return stub().start({ carName: "Bro" });
}

/** Runs alarms until the job settles, and reports how many it took. */
async function runToCompletion(limit = 40): Promise<{ job: ImportJobDto; ticks: number }> {
  let ticks = 0;
  for (let i = 0; i < limit; i++) {
    const ran = await runDurableObjectAlarm(stub());
    if (!ran) break;
    ticks++;
  }
  const job = await stub().status();
  return { job: job!, ticks };
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

/**
 * Row counts alone do not prove a sliced import matches a single-pass one — the
 * derived values are what slicing can quietly ruin, so compare those too.
 */
async function totals() {
  const drives = await env.DB.prepare(
    "SELECT COUNT(*) AS n, ROUND(SUM(distance), 2) AS km, SUM(duration_min) AS minutes FROM drives",
  ).first<Record<string, number>>();
  const charging = await env.DB.prepare(
    "SELECT COUNT(*) AS n, ROUND(SUM(charge_energy_added), 2) AS added, ROUND(SUM(charge_energy_used), 2) AS used," +
      " SUM(charge_energy_added IS NULL) AS unknown FROM charging_processes",
  ).first<Record<string, number>>();
  return {
    drives,
    charging,
    positions: await count("positions"),
    charges: await count("charges"),
    states: await count("states"),
  };
}

beforeEach(async () => {
  await stub().cancel();
  for (const table of ["charges", "charging_processes", "positions", "drives", "states", "cars"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("running an import as a job", () => {
  it("imports an uploaded export and reports the result", async () => {
    const started = await uploadAndStart();
    expect(started).toMatchObject({ phase: "importing", source: "tessie", vin: TESSIE_VIN });

    const { job } = await runToCompletion();
    expect(job.phase).toBe("done");
    expect(job.progress).toBe(1);
    expect(job.counts.drives).toBe(2);
    expect(job.counts.chargingProcesses).toBe(1);
    expect(job.counts.samples).toBeGreaterThan(50);
    expect(job.distanceKm).toBeCloseTo(40, 0);
    expect(job.error).toBeNull();
    expect(job.finishedAt).toBeGreaterThan(0);

    expect(await count("drives")).toBe(2);
    expect(await count("charging_processes")).toBe(1);
    const car = await env.DB.prepare("SELECT id, name FROM cars WHERE vin = ?").bind(TESSIE_VIN).first<{ id: number; name: string }>();
    expect(car).toMatchObject({ name: "Bro" });
    expect(job.carId).toBe(car!.id);
  });

  it("carries a long export across several alarms, with the same result", async () => {
    // Three weeks of the same day: more D1 calls than one invocation may spend.
    await uploadAndStart(21);
    const { job, ticks } = await runToCompletion();

    expect(ticks).toBeGreaterThan(1);
    expect(job.phase).toBe("done");
    expect(job.counts.drives).toBe(42);

    const sliced = await totals();

    // The same export in one pass, with no budget interrupting it, has to land
    // exactly the same rows — that is what makes stopping and resuming safe.
    for (const table of ["charges", "charging_processes", "positions", "drives", "states", "cars"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    const inOnePass = await runImport({
      db: env.DB,
      bundle: memoryBundle(`${TESSIE_VIN}.zip`, tessieCsvFiles(21)),
      carName: "Bro",
    });

    expect(sliced).toEqual(await totals());
    expect(job.counts.samples).toBe(inOnePass.snapshots);
    expect(job.distanceKm).toBeCloseTo(inOnePass.distanceKm, 1);
    expect(job.energyAddedKwh).toBeCloseTo(inOnePass.energyAddedKwh, 1);
  });

  it("reports progress while it runs", async () => {
    await uploadAndStart(21);
    await runDurableObjectAlarm(stub());
    const midway = await stub().status();

    expect(midway!.phase).toBe("importing");
    expect(midway!.progress).toBeGreaterThan(0);
    expect(midway!.progress).toBeLessThan(1);
    expect(midway!.at).toBeGreaterThan(midway!.firstAt!);
    expect(midway!.counts.samples).toBeGreaterThan(0);
  });

  it("replaces what the car already had for the same period", async () => {
    await uploadAndStart();
    await runToCompletion();
    const first = await totals();

    await uploadAndStart();
    const { job } = await runToCompletion();

    expect(job.replacedRows).toBeGreaterThan(0);
    // Importing the same export twice leaves the database exactly as it was:
    // no duplicated rows, and nothing of the first run left over.
    expect(await totals()).toEqual(first);
  });

  it("carries the geocoding cache between slices, and drops it at the end", async () => {
    const zip = await tessieZip(21);
    await stub().begin(`${TESSIE_VIN}.zip`);
    for (let offset = 0; offset < zip.length; offset += SLICE_BYTES) {
      await stub().append(zip.subarray(offset, offset + SLICE_BYTES));
    }
    // No geocoder is reachable, so every lookup fails — and a failure is exactly
    // what must be remembered, or each slice retries the same dead points.
    await stub().start({ geocode: true });

    await runDurableObjectAlarm(stub());
    await runInDurableObject(stub(), async (_instance, state) => {
      const cache = await state.storage.get<{ latitude: number }[]>("geocache");
      expect(cache?.length).toBeGreaterThan(0);
    });

    await runToCompletion();
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.get("geocache")).toBeUndefined();
    });
  });

  it("throws the upload away once it is done", async () => {
    await uploadAndStart();
    await runToCompletion();
    await runInDurableObject(stub(), async (_instance, state) => {
      const chunks = await state.storage.list({ prefix: "bytes:" });
      expect(chunks.size).toBe(0);
      expect(await state.storage.get("state")).toBeUndefined();
      // The report survives.
      expect(await state.storage.get("job")).toBeTruthy();
    });
  });

  it("stops on cancel and leaves the import cancelled", async () => {
    await uploadAndStart(21);
    await runDurableObjectAlarm(stub());
    await stub().cancel();

    const stopped = await stub().status();
    expect(stopped!.phase).toBe("cancelled");
    // The one alarm left is the upload's expiry, days away — not another slice.
    expect(stopped!.uploadExpiresAt).toBeGreaterThan(Date.now());
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(stopped!.uploadExpiresAt);
    });
    // Nothing carries on importing in the background.
    expect((await stub().status())!.counts.samples).toBe(stopped!.counts.samples);
  });

  it("resumes a cancelled import where it stopped, without redoing it", async () => {
    await uploadAndStart(21);
    await runDurableObjectAlarm(stub());
    await stub().cancel();

    const stopped = await stub().status();
    expect(stopped!.resumable).toBe(true);
    expect(stopped!.counts.samples).toBeGreaterThan(0);

    const resumed = await stub().resume();
    expect(resumed.phase).toBe("importing");
    const { job } = await runToCompletion();

    expect(job.phase).toBe("done");
    // Counters carry on rather than restarting.
    expect(job.counts.samples).toBeGreaterThan(stopped!.counts.samples);

    // And the result is the same as an import that was never interrupted.
    const interrupted = await totals();
    for (const table of ["charges", "charging_processes", "positions", "drives", "states", "cars"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await runImport({
      db: env.DB,
      bundle: memoryBundle(`${TESSIE_VIN}.zip`, tessieCsvFiles(21)),
      carName: "Bro",
    });
    expect(interrupted).toEqual(await totals());
  });

  it("resumes a failed import too, since the upload is kept", async () => {
    await uploadAndStart();
    await runInDurableObject(stub(), async (_instance, state) => {
      const job = await state.storage.get<Record<string, unknown>>("job");
      // Look like an import that ran out of attempts.
      await state.storage.put("job", { ...job, phase: "failed", error: "boom", attempts: 3 });
    });

    expect((await stub().status())!.resumable).toBe(true);
    await stub().resume();
    const { job } = await runToCompletion();
    expect(job.phase).toBe("done");
    expect(job.error).toBeNull();
  });

  it("will not resume what cannot be resumed", async () => {
    await uploadAndStart();
    await runToCompletion();
    // A finished import has thrown its upload away.
    expect((await stub().status())!.resumable).toBe(false);
    await expect(stub().resume()).rejects.toThrow(/cannot be resumed/);
  });

  it("picks up a job stored by an earlier version of the code", async () => {
    // A deploy can land mid-import: the alarm survives it and fires against the
    // new code, reading a record the old code wrote. Anything added since has to
    // be optional, or an import in flight would break on upgrade.
    await uploadAndStart(21);
    await runDurableObjectAlarm(stub());
    await runInDurableObject(stub(), async (_instance, state) => {
      const job = (await state.storage.get<Record<string, unknown>>("job"))!;
      delete job.geocodeRadiusMeters; // did not exist before the geocoding work
      await state.storage.put("job", job);
    });

    const midway = await stub().status();
    expect(midway!.phase).toBe("importing");

    const { job } = await runToCompletion();
    expect(job.phase).toBe("done");
    expect(job.counts.drives).toBe(42);
  });

  it("throws a stopped import's upload away once it expires", async () => {
    await uploadAndStart(21);
    await runDurableObjectAlarm(stub());
    await stub().cancel();

    const stopped = await stub().status();
    expect(stopped!.resumable).toBe(true);
    // Cancelling leaves exactly one alarm behind: come back and free the storage.
    expect(stopped!.uploadExpiresAt).toBeGreaterThan(Date.now());

    // Run the handler rather than waiting a week for the alarm to come due.
    await runInDurableObject(stub(), (instance) => instance.alarm());

    const expired = await stub().status();
    // The report survives; the megabytes do not, and it no longer offers to resume.
    expect(expired!.phase).toBe("cancelled");
    expect(expired!.counts.samples).toBe(stopped!.counts.samples);
    expect(expired!.resumable).toBe(false);
    expect(expired!.uploadExpiresAt).toBeNull();
    await runInDurableObject(stub(), async (_instance, state) => {
      expect((await state.storage.list({ prefix: "bytes:" })).size).toBe(0);
    });

    await expect(stub().resume()).rejects.toThrow(/no longer here/);
  });

  it("keeps the upload while a resume is still on the table", async () => {
    await uploadAndStart(21);
    await runDurableObjectAlarm(stub());
    await stub().cancel();

    // Resuming replaces the expiry alarm with the next slice, so the upload is
    // not pulled out from under a running import.
    await stub().resume();
    expect((await stub().status())!.uploadExpiresAt).toBeNull();
    const { job } = await runToCompletion();
    expect(job.phase).toBe("done");
  });

  it("discards the whole job on request", async () => {
    await uploadAndStart(21);
    await runDurableObjectAlarm(stub());
    await stub().discard();

    expect(await stub().status()).toBeNull();
    await runInDurableObject(stub(), async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
    });
  });

  it("fails clearly when the upload is not an export it knows", async () => {
    await stub().begin("notes.zip");
    await stub().append(new TextEncoder().encode("just some text"));
    const job = await stub().start({});

    expect(job.phase).toBe("failed");
    expect(job.error).toMatch(/not a zip file/);
    expect(await runDurableObjectAlarm(stub())).toBe(false);
  });

  it("passes the adapter's best-effort notes on to the report", async () => {
    await uploadAndStart();
    const { job } = await runToCompletion();
    expect(job.warnings.join("\n")).toMatch(/tpms_pressure_fl\.csv is not in the export/);
  });
});
