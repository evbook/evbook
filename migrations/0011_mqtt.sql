-- The MQTT publisher (src/platform/node/mqtt/, docs/mqtt.md): off until it is
-- turned on in Settings. Only the Node server publishes; on Cloudflare the
-- columns stay at their defaults. The password is encrypted with
-- ENCRYPTION_KEY, like the Volvo client secret and the provider tokens.
ALTER TABLE settings ADD COLUMN mqtt_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN mqtt_url TEXT;
ALTER TABLE settings ADD COLUMN mqtt_username TEXT;
ALTER TABLE settings ADD COLUMN mqtt_password_enc TEXT;
ALTER TABLE settings ADD COLUMN mqtt_prefix TEXT;
