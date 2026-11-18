-- Hyundai, Kia and Genesis cars in Europe are read through the Pleos Vehicle
-- Data API with a personal key the owner issues in Pleos Playground ("My
-- Vehicle Data API"): a client ID and a client secret, one key per make and
-- owner, covering every car on the owner's account when the key was issued.
-- Each key is an account of its own (`pleos-…`) with one car or several.
--
-- The secret is encrypted with ENCRYPTION_KEY, as the Tesla tokens are; the
-- client ID is not a secret on its own and is kept in the clear, with the
-- secret's last four characters, to tell keys apart. `refused_at` is set when
-- Pleos will no longer issue a token for the key (revoked, reissued, expired),
-- until the owner pastes a new one. The access token itself is not here: it
-- lives with the key's token holder (src/actors/pleosAuth.ts).
CREATE TABLE pleos_keys (
  account TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  client_id TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  secret_last4 TEXT NOT NULL,
  refused_at INTEGER,
  refused_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX pleos_keys_brand_client ON pleos_keys (brand, client_id);
