import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authed, getJson, login } from "../../test/http";
import { tessieZip } from "../../test/tessie-export";
import { NEW_DUMP, gzip } from "../../test/teslamate-dump";
import type { ImportJobDto, ImportRecordDto, ImportSourceDto } from "@shared/api-types";

/** HTTP surface of an import: what this build reads, upload, progress, cancel. */

let cookie: string;

beforeEach(async () => {
  cookie = await login();
  await env.IMPORT_DO.getByName("default").cancel();
  for (const table of [
    "charges",
    "charging_processes",
    "positions",
    "drives",
    "states",
    "updates",
    "imports",
    "cars",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

/** Uploads the fixture export. Tessie names the download after the VIN. */
async function upload(query = "?filename=LRW3F7EB9MC123456.zip"): Promise<Response> {
  return authed(cookie, `/api/v1/imports${query}`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: (await tessieZip()) as unknown as BodyInit,
  });
}

describe("import routes", () => {
  it("lists the sources this build can read", async () => {
    const sources = await getJson<ImportSourceDto[]>(cookie, "/api/v1/imports/sources");
    expect(sources.map((source) => source.id)).toContain("tessie");
    expect(sources[0]!.howToExport).toBeTruthy();
  });

  it("requires a session", async () => {
    const res = await SELF.fetch("https://x/api/v1/imports/current");
    expect(res.status).toBe(401);
    const post = await SELF.fetch("https://x/api/v1/imports", { method: "POST", body: "x" });
    expect(post.status).toBe(401);
  });

  it("accepts an export and starts an import", async () => {
    const res = await upload("?filename=LRW3F7EB9MC123456.zip&name=Bro");
    expect(res.status).toBe(202);

    const job = (await res.json()) as ImportJobDto;
    expect(job).toMatchObject({ source: "tessie", vin: "LRW3F7EB9MC123456", phase: "importing" });
    expect(job.carId).toBeGreaterThan(0);
    // The period is known up front, so the UI can show a percentage.
    expect(job.firstAt).toBeGreaterThan(0);
    expect(job.lastAt).toBeGreaterThan(job.firstAt!);

    const current = await getJson<ImportJobDto>(cookie, "/api/v1/imports/current");
    expect(current.id).toBe(job.id);
  });

  it("refuses a second import while one is running", async () => {
    expect((await upload()).status).toBe(202);
    const second = await upload();
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("import_in_progress");
  });

  it("reports what it cannot identify instead of guessing", async () => {
    const res = await authed(cookie, "/api/v1/imports?filename=mystery.zip", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: "not a zip at all",
    });
    expect(res.status).toBe(422);
    const job = (await res.json()) as ImportJobDto;
    expect(job.phase).toBe("failed");
    expect(job.error).toMatch(/not a zip file/);
  });

  it("asks which car when the upload carries no VIN and there is none on record", async () => {
    const res = await upload("?filename=export.zip");
    expect(res.status).toBe(422);
    const job = (await res.json()) as ImportJobDto;
    expect(job.error).toMatch(/no car to import into/);
  });

  it("rejects an empty body", async () => {
    const res = await authed(cookie, "/api/v1/imports", { method: "POST", body: "" });
    expect(res.status).toBe(400);
  });

  it("cancels a running import", async () => {
    expect((await upload()).status).toBe(202);
    const cancelled = await authed(cookie, "/api/v1/imports/current", { method: "DELETE" });
    expect(cancelled.status).toBe(204);
    const current = await getJson<ImportJobDto>(cookie, "/api/v1/imports/current");
    expect(current.phase).toBe("cancelled");
    // A cancelled import does not block the next one.
    expect((await upload()).status).toBe(202);
  });

  it("resumes a stopped import", async () => {
    expect((await upload()).status).toBe(202);
    await authed(cookie, "/api/v1/imports/current", { method: "DELETE" });

    const resumed = await authed(cookie, "/api/v1/imports/current/resume", { method: "POST" });
    expect(resumed.status).toBe(202);
    expect(((await resumed.json()) as ImportJobDto).phase).toBe("importing");
  });

  it("refuses to resume when there is nothing to resume", async () => {
    await env.IMPORT_DO.getByName("default").discard();
    const res = await authed(cookie, "/api/v1/imports/current/resume", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_resumable");
  });

  it("discards a stopped import when asked", async () => {
    expect((await upload()).status).toBe(202);
    const discarded = await authed(cookie, "/api/v1/imports/current?discard=true", { method: "DELETE" });
    expect(discarded.status).toBe(204);
    expect(await getJson<ImportJobDto | null>(cookie, "/api/v1/imports/current")).toBeNull();
  });

  it("has nothing to report before the first import", async () => {
    await env.IMPORT_DO.getByName("default").cancel();
    const res = await authed(cookie, "/api/v1/imports/current", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("says so when a file of another kind is not one it knows", async () => {
    const res = await authed(cookie, "/api/v1/imports?filename=notes.txt", { method: "POST", body: "just text" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as ImportJobDto).error).toMatch(/could not tell which service/);
  });

  it("takes a big file in parts, and checks each part follows the last", async () => {
    const bytes = await gzip(NEW_DUMP);
    const half = Math.floor(bytes.length / 2);
    const first = await authed(cookie, "/api/v1/imports?filename=teslamate.bck.gz&more=true", {
      method: "POST",
      body: bytes.subarray(0, half) as unknown as BodyInit,
    });
    expect(first.status).toBe(202);
    expect(((await first.json()) as ImportJobDto).phase).toBe("uploading");

    const misplaced = await authed(cookie, "/api/v1/imports/current/parts?offset=1", {
      method: "POST",
      body: bytes.subarray(half) as unknown as BodyInit,
    });
    expect(misplaced.status).toBe(409);
    expect(((await misplaced.json()) as { error: string }).error).toBe("bad_offset");

    const last = await authed(cookie, `/api/v1/imports/current/parts?offset=${half}`, {
      method: "POST",
      body: bytes.subarray(half) as unknown as BodyInit,
    });
    expect(last.status).toBe(202);
    expect((await last.json()) as ImportJobDto).toMatchObject({ source: "teslamate", phase: "importing" });
  });
});

describe("TeslaMate imports on record", () => {
  async function importBackup(): Promise<ImportJobDto> {
    const res = await authed(cookie, "/api/v1/imports?filename=teslamate.bck.gz", {
      method: "POST",
      body: (await gzip(NEW_DUMP)) as unknown as BodyInit,
    });
    expect(res.status).toBe(202);
    const stub = env.IMPORT_DO.getByName("default");
    for (let i = 0; i < 20 && (await runDurableObjectAlarm(stub)); i++) {
      if ((await stub.status())?.phase !== "importing") break;
    }
    return (await stub.status())!;
  }

  it("runs a backup to the end and reports what it left out", async () => {
    const job = await importBackup();
    expect(job).toMatchObject({
      phase: "done",
      progress: 1,
      skipped: { overlapping: 0, unfinished: 2 },
      counts: { drives: 3, chargingProcesses: 2, positions: 10 },
    });
  });

  it("lists each car's import, and deletes one with everything it brought", async () => {
    await importBackup();
    const history = await getJson<ImportRecordDto[]>(cookie, "/api/v1/imports/history");
    expect(history).toHaveLength(2);
    const bolt = history.find((record) => record.carName === "Bolt")!;
    expect(bolt).toMatchObject({ status: "done", source: "teslamate", drives: 2, skippedUnfinished: 2 });

    const deleted = await authed(cookie, `/api/v1/imports/history/${bolt.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { done: boolean }).done).toBe(true);
    const drives = await env.DB.prepare("SELECT COUNT(*) AS n FROM drives WHERE car_id = ?")
      .bind(bolt.carId)
      .first<{ n: number }>();
    expect(drives!.n).toBe(0);
    expect(await getJson<ImportRecordDto[]>(cookie, "/api/v1/imports/history")).toHaveLength(1);

    const missing = await authed(cookie, `/api/v1/imports/history/${bolt.id}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});
