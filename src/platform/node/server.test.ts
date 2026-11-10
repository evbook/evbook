import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { buildZip } from "../../../test/zipfile";
import { tessieCsvFiles, TESSIE_VIN } from "../../../test/tessie-export";
import type { ImportJobDto } from "@shared/api-types";
import { startServer, type RunningServer } from "./server";

/**
 * The whole Node runtime, end to end: boot against a temp SQLite file, then
 * drive the same HTTP surface the SPA uses — sessions, geofence writes, a
 * chunked import replayed on alarms, a restart in the middle of one. What the
 * workers suite proves about the app on Cloudflare, this proves about the
 * assembly on Node.
 */

const SECRETS = { APP_PASSWORD: "smoke-password", ENCRYPTION_KEY: "smoke-encryption-key" };

function scratch(): { dir: string; assets: string } {
  const dir = mkdtempSync(join(tmpdir(), "evbook-smoke-"));
  const assets = join(dir, "client");
  mkdirSync(join(assets, "assets"), { recursive: true });
  writeFileSync(join(assets, "index.html"), "<!doctype html><title>shell</title>");
  writeFileSync(join(assets, "assets", "app-abc123.js"), "console.log('bundle');");
  return { dir, assets };
}

let servers: RunningServer[] = [];

async function boot(dir: string, assets: string, overrides: Record<string, string> = {}): Promise<RunningServer> {
  const server = await startServer({
    cron: false,
    config: {
      PORT: 0,
      DATABASE_PATH: join(dir, "evbook.sqlite"),
      ASSETS_DIR: assets,
      MIGRATIONS_DIR: "./migrations",
      IMPORT_TICK_DELAY_MS: "1",
      ...SECRETS,
      ...overrides,
    },
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
});

async function login(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: SECRETS.APP_PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const authed = (port: number, cookie: string, path: string, init: RequestInit = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });

async function currentImport(port: number, cookie: string): Promise<ImportJobDto> {
  const res = await authed(port, cookie, "/api/v1/imports/current");
  return (await res.json()) as ImportJobDto;
}

async function untilPhase(port: number, cookie: string, wanted: ImportJobDto["phase"], ms = 25_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const job = await currentImport(port, cookie);
    if (job.phase === wanted) return job;
    if (job.phase === "failed") throw new Error(`import failed: ${job.error}`);
    if (Date.now() > deadline) throw new Error(`import stuck in ${job.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Big enough to need several 128 KiB storage chunks; stored, not deflated. */
async function tessieZip(days: number): Promise<Uint8Array> {
  const files = Object.entries(tessieCsvFiles(days)).map(([name, content]) => ({ name, content }));
  return buildZip(files);
}

describe("the Node runtime", () => {
  it("boots, migrates, serves the shell and enforces the session", async () => {
    const { dir, assets } = scratch();
    const server = await boot(dir, assets);
    const base = `http://localhost:${server.port}`;

    expect(await (await fetch(`${base}/health_check`)).json()).toEqual({ ok: true });

    // The database really was migrated with wrangler-compatible bookkeeping.
    const sqlite = new DatabaseSync(join(dir, "evbook.sqlite"));
    const migrated = sqlite.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get() as { n: number };
    expect(migrated.n).toBe(readdirSync("./migrations").filter((name) => name.endsWith(".sql")).length);
    sqlite.close();

    // Assets: exact file, fingerprinted caching, SPA fallback, API stays JSON.
    const bundle = await fetch(`${base}/assets/app-abc123.js`);
    expect(bundle.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/`)).headers.get("content-type")).toContain("text/html");
    expect(await (await fetch(`${base}/drives/42`)).text()).toContain("shell");
    expect(((await (await fetch(`${base}/api/nope`)).json()) as { error: string }).error).toBe("not_found");

    // Session: locked until login, open afterwards.
    expect((await fetch(`${base}/api/v1/cars`)).status).toBe(401);
    const wrong = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(wrong.status).toBe(401);
    const cookie = await login(server.port);
    expect((await authed(server.port, cookie, "/api/v1/cars")).status).toBe(200);
  });

  it("reports setupRequired when the secrets are absent", async () => {
    const { dir, assets } = scratch();
    const server = await boot(dir, assets, { APP_PASSWORD: "", ENCRYPTION_KEY: "" });
    const session = (await (await fetch(`http://localhost:${server.port}/api/v1/session`)).json()) as {
      setupRequired: boolean;
      authenticated: boolean;
    };
    expect(session).toMatchObject({ setupRequired: true, authenticated: false });
  });

  it("writes geofences through the port: create, update, 404 on a miss, delete", async () => {
    const { dir, assets } = scratch();
    const server = await boot(dir, assets);
    const cookie = await login(server.port);
    const body = { name: "Home", latitude: 52.52, longitude: 13.4, radius: 50 };

    const created = await authed(server.port, cookie, "/api/v1/geofences", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };

    // meta.changes drives these two answers — the shim must count rows.
    const updated = await authed(server.port, cookie, `/api/v1/geofences/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...body, name: "Home base" }),
    });
    expect(updated.status).toBe(200);
    const missed = await authed(server.port, cookie, "/api/v1/geofences/9999", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(missed.status).toBe(404);

    const listed = await authed(server.port, cookie, "/api/v1/geofences");
    expect(((await listed.json()) as { name: string }[]).map((g) => g.name)).toEqual(["Home base"]);
    expect((await authed(server.port, cookie, `/api/v1/geofences/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await authed(server.port, cookie, `/api/v1/geofences/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("replays a chunked import on alarms to completion", async () => {
    const { dir, assets } = scratch();
    const server = await boot(dir, assets);
    const cookie = await login(server.port);

    const zip = await tessieZip(60);
    expect(zip.byteLength).toBeGreaterThan(256 * 1024); // several storage chunks

    const accepted = await authed(
      server.port,
      cookie,
      `/api/v1/imports?filename=export.zip&vin=${TESSIE_VIN}&name=Smoke%20Car`,
      { method: "POST", headers: { cookie, "content-type": "application/zip" }, body: zip },
    );
    expect(accepted.status).toBe(202);

    const done = await untilPhase(server.port, cookie, "done");
    expect(done.counts.drives).toBe(120); // two a day
    expect(done.counts.chargingProcesses).toBe(60);
    expect(done.counts.positions).toBeGreaterThan(1_000);

    // The upload chunks are gone once the import is done; the report stays.
    const sqlite = new DatabaseSync(join(dir, "evbook.sqlite"));
    const held = sqlite
      .prepare("SELECT COUNT(*) AS n FROM actor_kv WHERE actor = 'import:default' AND substr(key,1,6) = 'bytes:'")
      .get() as { n: number };
    expect(held.n).toBe(0);
    const positions = sqlite.prepare("SELECT COUNT(*) AS n FROM positions").get() as { n: number };
    expect(positions.n).toBe(done.counts.positions);
    sqlite.close();
  });

  it("resumes an interrupted import after a restart, from the persisted alarm", async () => {
    const { dir, assets } = scratch();
    // An hour between slices: the import cannot advance on its own, which
    // pins it "mid-import" however fast the machine is.
    const first = await boot(dir, assets, { IMPORT_TICK_DELAY_MS: "3600000" });
    const cookie = await login(first.port);

    const accepted = await authed(first.port, cookie, `/api/v1/imports?filename=export.zip&vin=${TESSIE_VIN}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/zip" },
      body: await tessieZip(20),
    });
    expect(accepted.status).toBe(202);
    expect((await currentImport(first.port, cookie)).phase).toBe("importing");
    await first.close(); // the process dies mid-import; the alarm row stays

    // Impatience stands in for the hour: pull the persisted alarm forward, as
    // if the deadline had arrived while the process was down.
    const sqlite = new DatabaseSync(join(dir, "evbook.sqlite"));
    const pending = sqlite.prepare("SELECT COUNT(*) AS n FROM actor_alarms WHERE actor = 'import:default'").get() as {
      n: number;
    };
    expect(pending.n).toBe(1);
    sqlite.prepare("UPDATE actor_alarms SET scheduled_at = ? WHERE actor = 'import:default'").run(Date.now());
    sqlite.close();

    const second = await boot(dir, assets); // fast ticks again
    const done = await untilPhase(second.port, cookie, "done");
    expect(done.counts.drives).toBe(40);
  });
});
