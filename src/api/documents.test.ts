import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { DocumentDto } from "@shared/api-types";
import { authed, getJson, login } from "../../test/http";
import { clearTables } from "../../test/db";

/** HTTP tests for the glovebox: upload, list, download, delete — in D1 by default, and in R2. */

const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

/** This file's own car (see test/db.ts on why every spec file gets its own). */
const CAR_ID = 950;

function upload(cookie: string, params: Record<string, string>, bytes: Uint8Array, contentType: string) {
  return SELF.fetch(`https://x/api/v1/documents?${new URLSearchParams(params)}`, {
    method: "POST",
    headers: { "content-type": contentType, cookie },
    body: bytes,
  });
}

/** How many database parts hold the blob under this key. */
async function blobParts(key: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM document_blobs WHERE blob_key = ?")
    .bind(key)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("documents API", () => {
  beforeEach(async () => {
    await clearTables("documents", "document_blobs");
    await env.DB.prepare("UPDATE settings SET document_storage = 'database' WHERE id = 1").run();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, 95, 96, 'VINDOC', 'Docs', ?, ?)",
    )
      .bind(CAR_ID, now, now)
      .run();
  });

  it("uploads, lists, serves and deletes a document", async () => {
    const cookie = await login();

    const created = await upload(
      cookie,
      { car: String(CAR_ID), category: "title", filename: "logbook.webp" },
      WEBP_BYTES,
      "image/webp",
    );
    expect(created.status).toBe(201);
    const dto = (await created.json()) as DocumentDto;
    expect(dto).toMatchObject({
      carId: CAR_ID,
      category: "title",
      name: "logbook.webp",
      contentType: "image/webp",
      sizeBytes: WEBP_BYTES.byteLength,
      hasThumbnail: false,
    });

    // The client sends the preview straight after the document itself.
    const thumbed = await authed(cookie, `/api/v1/documents/${dto.id}/thumbnail`, {
      method: "POST",
      headers: { "content-type": "image/webp" },
      body: WEBP_BYTES,
    });
    expect(thumbed.status).toBe(204);

    const thumb = await authed(cookie, `/api/v1/documents/${dto.id}/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(WEBP_BYTES);

    const list = await getJson<DocumentDto[]>(cookie, "/api/v1/documents");
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ ...dto, hasThumbnail: true });

    const file = await authed(cookie, `/api/v1/documents/${dto.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/webp");
    expect(file.headers.get("content-disposition")).toBe('inline; filename="logbook.webp"');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(WEBP_BYTES);

    expect((await authed(cookie, `/api/v1/documents/${dto.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await getJson<DocumentDto[]>(cookie, "/api/v1/documents")).toHaveLength(0);
    expect((await authed(cookie, `/api/v1/documents/${dto.id}/file`)).status).toBe(404);
    // The bytes are gone from the database too, not just from the listing —
    // the preview included.
    expect(await blobParts(`documents/${dto.id}`)).toBe(0);
    expect(await blobParts(`documents/${dto.id}.thumb`)).toBe(0);
  });

  it("keeps documents in D1 by default, and nothing in R2", async () => {
    const cookie = await login();
    const res = await upload(cookie, { car: String(CAR_ID), category: "title" }, WEBP_BYTES, "image/webp");
    const dto = (await res.json()) as DocumentDto;
    expect(await blobParts(`documents/${dto.id}`)).toBe(1);
    expect(await env.BLOBS.get(`documents/${dto.id}`)).toBeNull();
  });

  it("splits a large document into parts and serves it back whole", async () => {
    const cookie = await login();
    const big = new Uint8Array(2.5 * 1024 * 1024).map((_, i) => (i * 7) % 251);
    const res = await upload(cookie, { car: String(CAR_ID), category: "insurance" }, big, "application/pdf");
    expect(res.status).toBe(201);
    const dto = (await res.json()) as DocumentDto;
    expect(await blobParts(`documents/${dto.id}`)).toBe(3);

    const file = await authed(cookie, `/api/v1/documents/${dto.id}/file`);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(big);
  });

  it("puts new uploads in R2 when switched on, and still serves the ones in D1", async () => {
    const cookie = await login();
    const upload1 = await upload(cookie, { car: String(CAR_ID), category: "title" }, WEBP_BYTES, "image/webp");
    const before = (await upload1.json()) as DocumentDto;

    const switched = await authed(cookie, "/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ documentStorage: "bucket" }),
    });
    expect(switched.status).toBe(200);

    const upload2 = await upload(cookie, { car: String(CAR_ID), category: "tax" }, WEBP_BYTES, "image/webp");
    const after = (await upload2.json()) as DocumentDto;
    const thumbed = await authed(cookie, `/api/v1/documents/${after.id}/thumbnail`, {
      method: "POST",
      headers: { "content-type": "image/webp" },
      body: WEBP_BYTES,
    });
    expect(thumbed.status).toBe(204);
    expect(await env.BLOBS.get(`documents/${after.id}`)).not.toBeNull();
    expect(await env.BLOBS.get(`documents/${after.id}.thumb`)).not.toBeNull();
    expect(await blobParts(`documents/${after.id}`)).toBe(0);

    for (const doc of [before, after]) {
      const file = await authed(cookie, `/api/v1/documents/${doc.id}/file`);
      expect(file.status, doc.category).toBe(200);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(WEBP_BYTES);
    }

    expect((await authed(cookie, `/api/v1/documents/${after.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await env.BLOBS.get(`documents/${after.id}`)).toBeNull();
    expect(await env.BLOBS.get(`documents/${after.id}.thumb`)).toBeNull();
  });

  it("stores the bytes under the generated id, never the uploaded name", async () => {
    const cookie = await login();
    const res = await upload(
      cookie,
      { car: String(CAR_ID), category: "insurance", filename: "../escape.webp" },
      WEBP_BYTES,
      "image/webp",
    );
    expect(res.status).toBe(201);
    const dto = (await res.json()) as DocumentDto;
    expect(await blobParts(`documents/${dto.id}`)).toBe(1);
  });

  it("files a document under any of the four categories", async () => {
    const cookie = await login();
    for (const category of ["title", "inspection", "tax", "insurance"]) {
      const res = await upload(cookie, { car: String(CAR_ID), category }, WEBP_BYTES, "image/webp");
      expect(res.status, category).toBe(201);
    }
    const list = await getJson<DocumentDto[]>(cookie, "/api/v1/documents");
    expect(list.map((doc) => doc.category).sort()).toEqual(["inspection", "insurance", "tax", "title"]);
  });

  it("refuses what it should", async () => {
    const cookie = await login();
    const car = String(CAR_ID);

    const noCar = await upload(cookie, { category: "title" }, WEBP_BYTES, "image/webp");
    expect(noCar.status).toBe(400);

    const strangeCar = await upload(cookie, { car: "999999", category: "title" }, WEBP_BYTES, "image/webp");
    expect(strangeCar.status).toBe(404);

    const badCategory = await upload(cookie, { car, category: "misc" }, WEBP_BYTES, "image/webp");
    expect(badCategory.status).toBe(400);

    const badType = await upload(cookie, { car, category: "title" }, WEBP_BYTES, "application/zip");
    expect(badType.status).toBe(415);

    const empty = await upload(cookie, { car, category: "title" }, new Uint8Array(0), "image/webp");
    expect(empty.status).toBe(400);

    const huge = await upload(cookie, { car, category: "title" }, new Uint8Array(15 * 1024 * 1024 + 1), "image/jpeg");
    expect(huge.status).toBe(413);

    expect(await getJson<DocumentDto[]>(cookie, "/api/v1/documents")).toHaveLength(0);
  });

  it("refuses a thumbnail for an unknown document, a PDF one, and an oversized one", async () => {
    const cookie = await login();
    const res = await upload(cookie, { car: String(CAR_ID), category: "title" }, WEBP_BYTES, "image/webp");
    const dto = (await res.json()) as DocumentDto;

    const thumb = (id: string, bytes: Uint8Array, contentType: string) =>
      authed(cookie, `/api/v1/documents/${id}/thumbnail`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: bytes,
      });

    expect((await thumb("nope", WEBP_BYTES, "image/webp")).status).toBe(404);
    expect((await thumb(dto.id, WEBP_BYTES, "application/pdf")).status).toBe(415);
    expect((await thumb(dto.id, new Uint8Array(512 * 1024 + 1), "image/webp")).status).toBe(413);
    expect((await authed(cookie, `/api/v1/documents/${dto.id}/thumbnail`)).status).toBe(404);
  });

  it("requires a session", async () => {
    const paths: [string, RequestInit][] = [
      ["/api/v1/documents", {}],
      ["/api/v1/documents", { method: "POST", body: WEBP_BYTES }],
      ["/api/v1/documents/x/file", {}],
      ["/api/v1/documents/x/thumbnail", {}],
      ["/api/v1/documents/x/thumbnail", { method: "POST", body: WEBP_BYTES }],
      ["/api/v1/documents/x", { method: "DELETE" }],
    ];
    for (const [path, init] of paths) {
      expect((await SELF.fetch(`https://x${path}`, init)).status, path).toBe(401);
    }
  });

  it("answers 404 for an unknown id", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/documents/nope/file")).status).toBe(404);
    expect((await authed(cookie, "/api/v1/documents/nope", { method: "DELETE" })).status).toBe(404);
  });
});
