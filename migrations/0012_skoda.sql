-- A third vendor (Škoda), and an accounts table that no longer needs a
-- migration per vendor.
--
-- `accounts.provider` had CHECK (provider IN ('tesla', 'volvo')). SQLite cannot
-- alter a CHECK, so the table is rebuilt once without it; which providers exist
-- is the application's to say (shared/api-types.ts `PROVIDERS`), not the
-- schema's. Nothing references `accounts` by foreign key, so the rebuild is a
-- plain copy.
CREATE TABLE accounts_new (
  name TEXT PRIMARY KEY CHECK (name <> 'default'),
  provider TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO accounts_new (name, provider, label, created_at) SELECT name, provider, label, created_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- A Škoda is read through the MySkoda Public API with a key the owner creates
-- in the MySkoda app. Škoda issues one key per car, so each key is an account
-- of its own with exactly one car. The key is encrypted with ENCRYPTION_KEY,
-- as the Tesla tokens are; only its last four characters are kept in the
-- clear, to tell keys apart. `expires_at` is what Škoda says
-- (X-API-Key-Expires-At); `refused_at` is set when Škoda stops accepting the
-- key, until the owner pastes a new one.
CREATE TABLE skoda_keys (
  account TEXT PRIMARY KEY,
  vin TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  expires_at INTEGER,
  refused_at INTEGER,
  refused_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX skoda_keys_vin ON skoda_keys (vin);

-- Škoda's answers as they arrived (src/core/skoda/), kept for the same reason
-- as volvo_snapshots: drives and charges are derived from readings, and the raw
-- payload is what lets a corrected mapping be run again over history that
-- cannot be collected twice. One row per distinct answer; a repeat only moves
-- `checked_at`.
CREATE TABLE skoda_snapshots (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  fetched_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX skoda_snapshots_car ON skoda_snapshots (car_id, fetched_at);
