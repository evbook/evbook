-- Glovebox documents can live in the database itself, so a Cloudflare install
-- needs no R2 (Cloudflare asks for a payment method before enabling R2, even
-- on its free tier). See src/api/documents.ts and src/db/blobs.ts.

-- Where new uploads go: 'database' (the default — D1 on Cloudflare, SQLite on
-- a VPS) or 'bucket' (the R2 bucket on Cloudflare, files under BLOBS_DIR on a
-- VPS). Switching only affects later uploads; every document remembers its own.
ALTER TABLE settings ADD COLUMN document_storage TEXT NOT NULL DEFAULT 'database';

-- Where this document's bytes (and its thumbnail's) are. Every document
-- uploaded before this migration went to the bucket, hence the default.
ALTER TABLE documents ADD COLUMN blob_store TEXT NOT NULL DEFAULT 'bucket';

-- The bytes of database-stored blobs, split into parts: D1 caps a row at 2 MB,
-- and a document may be up to 15 MB. Base64 text rather than a BLOB, because
-- D1 hands a BLOB column back as a JSON array of numbers — several times the
-- size of the data. Keyed like the bucket (`documents/<id>`, `….thumb`).
CREATE TABLE document_blobs (
  blob_key TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (blob_key, part)
) WITHOUT ROWID;
