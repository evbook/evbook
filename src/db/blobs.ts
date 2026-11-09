import type { BlobStore, SqlDatabase } from "../platform/ports";

/**
 * The blob port over the app's own database — the default home of glovebox
 * documents, so an install needs nothing beyond D1 (or the VPS's SQLite).
 *
 * D1 caps a row at 2 MB, so a blob is split into parts of 1 MiB, each stored as
 * base64 (1.4 MB of text). Text, not a BLOB column: D1 returns a BLOB as a JSON
 * array of numbers, several times the size of the bytes themselves.
 *
 * Parts are written one statement at a time rather than in one batch, which
 * keeps every request to the database small. A put that dies part-way leaves a
 * short blob behind, but documents.ts writes the bytes before the row that
 * points at them, so nothing ever reads one.
 */
export const PART_BYTES = 1024 * 1024;

export function sqlBlobs(db: SqlDatabase): BlobStore {
  return {
    async put(key, data) {
      await db.prepare("DELETE FROM document_blobs WHERE blob_key = ?").bind(key).run();
      const parts = Math.max(1, Math.ceil(data.byteLength / PART_BYTES));
      for (let part = 0; part < parts; part++) {
        const slice = data.subarray(part * PART_BYTES, (part + 1) * PART_BYTES);
        await db
          .prepare("INSERT INTO document_blobs (blob_key, part, data) VALUES (?, ?, ?)")
          .bind(key, part, toBase64(slice))
          .run();
      }
    },
    async get(key) {
      const rows = await db
        .prepare("SELECT data FROM document_blobs WHERE blob_key = ? ORDER BY part")
        .bind(key)
        .all<{ data: string }>();
      if (rows.results.length === 0) return null;
      const parts = rows.results.map((row) => fromBase64(row.data));
      const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out;
    },
    async delete(key) {
      await db.prepare("DELETE FROM document_blobs WHERE blob_key = ?").bind(key).run();
    },
  };
}

/** btoa over a binary string, built in slices so no call spreads a megabyte of arguments. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
