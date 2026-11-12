-- A second vendor (Volvo) and more than one Tesla account.
--
-- Every car now says which vendor's API logs it and which signed-in account it
-- is read through. The account is the name of the auth actor holding that
-- account's tokens: 'default' is the Tesla account EVBook always had (the
-- singleton AuthDO), so every car logged so far keeps working unchanged.
ALTER TABLE cars ADD COLUMN provider TEXT NOT NULL DEFAULT 'tesla';
ALTER TABLE cars ADD COLUMN account TEXT NOT NULL DEFAULT 'default';

-- Accounts beyond the original Tesla one: further Tesla accounts and the Volvo
-- ID. The row is the catalogue Settings lists; the tokens themselves live in the
-- named auth actor, encrypted, as the default account's always have. 'default'
-- is never a row here: it predates the table and is always listed.
CREATE TABLE accounts (
  name TEXT PRIMARY KEY CHECK (name <> 'default'),
  provider TEXT NOT NULL CHECK (provider IN ('tesla', 'volvo')),
  label TEXT,
  created_at INTEGER NOT NULL
);

-- Volvo's responses as they arrived (src/core/volvo/). Volvo gives no trips or
-- charging sessions, only readings, so EVBook derives them — and a derivation
-- can be wrong. The raw payload is what lets a fixed mapping be run again over
-- history that can never be collected twice. One row per distinct answer: a
-- poll that returns the same thing again (timestamps aside, `fingerprint`)
-- only moves `checked_at`, so a value is known to have held from `fetched_at`
-- to `checked_at` and nothing is known in between.
CREATE TABLE volvo_snapshots (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX volvo_snapshots_car_endpoint ON volvo_snapshots (car_id, endpoint, fetched_at);
