-- A third vendor (Škoda), and a schema that no longer needs a migration per
-- vendor: no provider CHECK on `accounts`, and one snapshots table for all.
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

-- One table for every provider's raw answers, in place of one per vendor.
-- `volvo_snapshots` becomes `provider_snapshots` with the provider beside the
-- endpoint; its rows stay where they are (a rename and a column, not a copy).
-- A provider with a single read names it with one constant endpoint (a Škoda's
-- is 'vehicle'). The reason for keeping them is unchanged: drives and charges
-- are derived from readings, and the raw payload is what lets a corrected
-- mapping be run again over history that cannot be collected twice. One row
-- per distinct answer; a repeat only moves `checked_at`.
ALTER TABLE volvo_snapshots RENAME TO provider_snapshots;
ALTER TABLE provider_snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT 'volvo';
DROP INDEX volvo_snapshots_car_endpoint;
CREATE INDEX provider_snapshots_car_endpoint ON provider_snapshots (car_id, provider, endpoint, fetched_at);
