import { Hono } from "hono";
import { z } from "zod";
import type { DocumentCategory, DocumentDto } from "@shared/api-types";
import type { AppEnv } from "../platform/env";
import { isDemo } from "./demo";

/**
 * The glovebox: the paperwork that belongs with each car — the logbook/title,
 * the inspection certificate, road tax/vignette and the insurance documents.
 * Every document is filed under one car.
 *
 * The row is the catalogue, the bytes go to the blob store (R2 on Cloudflare,
 * files on a VPS). Uploads arrive as the raw request body with the metadata in
 * query parameters, the same shape as the history import. The client re-encodes
 * photos before uploading (app/lib/image.ts) — AVIF or WebP where the browser
 * can, JPEG/PNG otherwise — so the allowlist here is short and everything in
 * it is something a browser will render back inline.
 */

/** Roomy for a re-encoded photo or a scanned PDF; tight enough to buffer. */
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

/** A 256 px preview is a few KB; anything near this cap is not a thumbnail. */
const MAX_THUMB_BYTES = 512 * 1024;

/** What the client is able to produce; anything else is refused, not stored. */
const ACCEPTED_TYPES = new Set(["image/avif", "image/webp", "image/jpeg", "image/png", "application/pdf"]);

/** A thumbnail is always an image — there is no such thing as a PDF preview blob. */
const ACCEPTED_THUMB_TYPES = new Set(["image/avif", "image/webp", "image/jpeg", "image/png"]);

const Category = z.enum(["title", "inspection", "tax", "insurance"]);

interface Row {
  id: string;
  car_id: number;
  category: DocumentCategory;
  name: string;
  content_type: string;
  size_bytes: number;
  created_at: number;
  thumb_key: string | null;
}

function toDto(row: Row): DocumentDto {
  return {
    id: row.id,
    carId: row.car_id,
    category: row.category,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    hasThumbnail: row.thumb_key !== null,
  };
}

/** The demo is public — it must not double as free file hosting. */
const DEMO_UPLOAD_REFUSAL = {
  error: "demo_mode",
  message: "This is a demo with fixture data — it does not keep uploads.",
} as const;

export const documentRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/documents", async (c) => {
    const rows = await c.env.DB.prepare(
      "SELECT id, car_id, category, name, content_type, size_bytes, created_at, thumb_key FROM documents ORDER BY car_id, category, created_at DESC",
    ).all<Row>();
    return c.json(rows.results.map(toDto));
  })

  /** The file as the raw request body; car, category and filename as query params. */
  .post("/documents", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_UPLOAD_REFUSAL, 403);

    const category = Category.safeParse(c.req.query("category"));
    if (!category.success) {
      return c.json({ error: "invalid_category", message: "category must be title, inspection, tax or insurance" }, 400);
    }

    // A document is one car's paperwork; an upload with no car has no drawer
    // to land in, and one for a car this installation has never seen is a bug.
    const carId = Number(c.req.query("car"));
    if (!Number.isInteger(carId)) {
      return c.json({ error: "invalid_car", message: "car must be the id of one of your cars" }, 400);
    }
    const car = await c.env.DB.prepare("SELECT id FROM cars WHERE id = ?").bind(carId).first<{ id: number }>();
    if (!car) return c.json({ error: "unknown_car", message: "There is no car with that id." }, 404);

    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ACCEPTED_TYPES.has(contentType)) {
      return c.json(
        { error: "unsupported_type", message: "Send an AVIF, WebP, JPEG or PNG image, or a PDF." },
        415,
      );
    }

    // Refuse an oversized upload before buffering it where the browser said
    // how big it is; the buffered length is checked regardless.
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) {
      return c.json({ error: "too_large", message: `Documents over ${MAX_DOCUMENT_BYTES >> 20} MB are not accepted.` }, 413);
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: "empty_body", message: "Send the file as the request body." }, 400);
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      return c.json({ error: "too_large", message: `Documents over ${MAX_DOCUMENT_BYTES >> 20} MB are not accepted.` }, 413);
    }

    // The display name is whatever the picker said; the blob key never is.
    const name = (c.req.query("filename") ?? "document").slice(0, 200);
    const id = crypto.randomUUID();
    const key = `documents/${id}`;
    const createdAt = Date.now();

    // Blob first, row second: an orphaned blob is invisible, a row with no
    // bytes behind it is a broken download.
    await c.env.blobs.put(key, bytes, contentType);
    await c.env.DB.prepare(
      "INSERT INTO documents (id, car_id, category, name, content_type, size_bytes, blob_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, carId, category.data, name, contentType, bytes.byteLength, key, createdAt)
      .run();

    const dto: DocumentDto = {
      id,
      carId,
      category: category.data,
      name,
      contentType,
      sizeBytes: bytes.byteLength,
      createdAt,
      // The preview arrives in a second request, right after this one.
      hasThumbnail: false,
    };
    return c.json(dto, 201);
  })

  /**
   * The list preview, generated in the browser and sent straight after the
   * document itself. A document without one is fine — the list shows a
   * placeholder — so the client fires this and does not fret over failures.
   */
  .post("/documents/:id/thumbnail", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_UPLOAD_REFUSAL, 403);

    const id = c.req.param("id");
    const row = await c.env.DB.prepare("SELECT id FROM documents WHERE id = ?").bind(id).first<{ id: string }>();
    if (!row) return c.json({ error: "not_found" }, 404);

    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ACCEPTED_THUMB_TYPES.has(contentType)) {
      return c.json({ error: "unsupported_type", message: "Send an AVIF, WebP, JPEG or PNG image." }, 415);
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: "empty_body", message: "Send the image as the request body." }, 400);
    if (bytes.byteLength > MAX_THUMB_BYTES) {
      return c.json({ error: "too_large", message: `Thumbnails over ${MAX_THUMB_BYTES >> 10} KB are not accepted.` }, 413);
    }

    const key = `documents/${id}.thumb`;
    await c.env.blobs.put(key, bytes, contentType);
    await c.env.DB.prepare("UPDATE documents SET thumb_key = ?, thumb_type = ? WHERE id = ?")
      .bind(key, contentType, id)
      .run();
    return c.body(null, 204);
  })

  .get("/documents/:id/thumbnail", async (c) => {
    const row = await c.env.DB.prepare("SELECT thumb_key, thumb_type FROM documents WHERE id = ?")
      .bind(c.req.param("id"))
      .first<{ thumb_key: string | null; thumb_type: string | null }>();
    if (!row?.thumb_key || !row.thumb_type) return c.json({ error: "not_found" }, 404);

    const bytes = await c.env.blobs.get(row.thumb_key);
    if (!bytes) return c.json({ error: "not_found" }, 404);

    return c.body(bytes, 200, {
      "content-type": row.thumb_type,
      "content-length": String(bytes.byteLength),
      // Written once, straight after the upload, and only fetched after the
      // listing says it exists — so the browser may keep it like the file.
      "cache-control": "private, max-age=31536000, immutable",
    });
  })

  /** The bytes back, served inline so images and PDFs open in the browser. */
  .get("/documents/:id/file", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT id, car_id, category, name, content_type, size_bytes, created_at, thumb_key, blob_key FROM documents WHERE id = ?",
    )
      .bind(c.req.param("id"))
      .first<Row & { blob_key: string }>();
    if (!row) return c.json({ error: "not_found" }, 404);

    const bytes = await c.env.blobs.get(row.blob_key);
    if (!bytes) return c.json({ error: "not_found" }, 404);

    // The filename lands in a header, so anything a header cannot carry is
    // replaced; the row keeps the real name for display.
    const filename = row.name.replace(/["\\]/g, "'").replace(/[^\x20-\x7e]+/g, "_");
    return c.body(bytes, 200, {
      "content-type": row.content_type,
      "content-length": String(bytes.byteLength),
      "content-disposition": `inline; filename="${filename}"`,
      // A document never changes under its id — replacing one is a new id —
      // so the browser may keep it. Private: it sits behind the session cookie.
      "cache-control": "private, max-age=31536000, immutable",
    });
  })

  .delete("/documents/:id", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_UPLOAD_REFUSAL, 403);
    const id = c.req.param("id");
    const row = await c.env.DB.prepare("SELECT blob_key, thumb_key FROM documents WHERE id = ?")
      .bind(id)
      .first<{ blob_key: string; thumb_key: string | null }>();
    if (!row) return c.json({ error: "not_found" }, 404);

    // Row first, blobs second: if a blob delete fails the leftover bytes are
    // unreachable, whereas the other order leaves a listing that 404s.
    await c.env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
    await c.env.blobs.delete(row.blob_key);
    if (row.thumb_key) await c.env.blobs.delete(row.thumb_key);
    return c.body(null, 204);
  });
