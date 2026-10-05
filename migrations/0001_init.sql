-- EVBook schema. Timestamps are Unix epoch milliseconds (UTC), suffix _at.
-- Money is INTEGER minor units (cents), suffix _cents. Telemetry stored in SI units
-- (km, °C, bar, kW, kWh) — display conversion happens in the client.
--
-- Before the first public release this schema was built by eighteen separate
-- migrations. Databases from then already record `0001_init.sql` in
-- d1_migrations and skip this file; src/db/mergedMigrations.ts refuses one that
-- stopped part-way through that series. New changes are new files.

CREATE TABLE cars (
  id INTEGER PRIMARY KEY,
  eid INTEGER UNIQUE,
  vid INTEGER UNIQUE,
  vin TEXT NOT NULL UNIQUE,
  name TEXT,
  model TEXT,
  trim_badging TEXT,
  marketing_name TEXT,
  exterior_color TEXT,
  wheel_type TEXT,
  spoiler_type TEXT,
  efficiency REAL,
  inserted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- When the car is next due a poll, so the cron can find it without waking its
  -- actor. Cadences at or beyond the cron's minute don't keep an alarm armed — an
  -- armed alarm keeps a Durable Object resident, and residency is what is billed —
  -- so the actor writes its deadline here and lets itself be evicted. A fast alarm
  -- loop (driving, charging) still carries one, a period behind, so a lost alarm
  -- heals within the minute. NULL: not scheduled (logging off, or never run).
  next_due_at INTEGER
);

CREATE TABLE car_settings (
  car_id INTEGER PRIMARY KEY REFERENCES cars(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  suspend_min INTEGER NOT NULL DEFAULT 21,
  suspend_after_idle_min INTEGER NOT NULL DEFAULT 15,
  req_not_unlocked INTEGER NOT NULL DEFAULT 0,
  free_supercharging INTEGER NOT NULL DEFAULT 0,
  lfp_battery INTEGER NOT NULL DEFAULT 0,
  -- The owner's answer to a pack the VIN cannot pin down: the usable capacity the
  -- car left the factory with, kWh. NULL means follow the VIN's estimate.
  usable_when_new_kwh REAL
);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  unit_of_length TEXT NOT NULL DEFAULT 'km' CHECK (unit_of_length IN ('km','mi')),
  unit_of_temperature TEXT NOT NULL DEFAULT 'C' CHECK (unit_of_temperature IN ('C','F')),
  unit_of_pressure TEXT NOT NULL DEFAULT 'bar' CHECK (unit_of_pressure IN ('bar','psi')),
  preferred_range TEXT NOT NULL DEFAULT 'rated' CHECK (preferred_range IN ('ideal','rated')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  geocode_language TEXT NOT NULL DEFAULT 'en',
  base_url TEXT,
  -- One currency for the whole account; costs are bare minor units, so this only
  -- says what those units are. No CHECK (databases that gained the column by
  -- ALTER TABLE cannot have one, and both kinds must match): the settings route
  -- validates against shared/currency.ts and the reader falls back on anything else.
  currency TEXT NOT NULL DEFAULT 'EUR',
  -- Cursor for the drive-origin sweep (db/repair.ts), which reconstructs where
  -- drives recorded before openDrive did so actually began: the id below which
  -- drives still await examination. NULL: not started (it begins at the newest);
  -- 0: finished. An import resets it, because imported drives arrive with new ids.
  drive_origin_swept_before INTEGER,
  -- What the once-a-day update check (core/update.ts) remembers between runs.
  -- Stamped whether the check succeeded or not — a notice is never urgent, and
  -- retrying a rate-limited API every minute is the worse failure. The tag is kept
  -- exactly as git has it, because that is what a release URL is built from.
  update_checked_at INTEGER,
  update_latest_tag TEXT,
  -- Opt-in telemetry (core/telemetry.ts, docs/telemetry.md). The level is 'off'
  -- (default: nothing recorded, let alone sent), 'minimal' or 'extended'; with no
  -- CHECK, for the same reason as currency, the reader treats anything unknown as
  -- 'off'. The instance id is a random UUID minted on first use and the only
  -- identity ever exported. last_version tells an install (NULL) from an update
  -- and only moves while telemetry is on, so opting in late still reports the
  -- install. stats_at is the daily-stats clock.
  telemetry_level TEXT NOT NULL DEFAULT 'off',
  telemetry_instance_id TEXT,
  telemetry_last_version TEXT,
  telemetry_stats_at INTEGER
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  osm_id INTEGER,
  osm_type TEXT,
  display_name TEXT,
  name TEXT,
  house_number TEXT,
  road TEXT,
  neighbourhood TEXT,
  city TEXT,
  county TEXT,
  postcode TEXT,
  state TEXT,
  state_district TEXT,
  country TEXT,
  latitude REAL,
  longitude REAL,
  raw TEXT,
  inserted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- What stands at the coordinate when OSM knows it by a name rather than a
  -- street ("amenity/fuel", "shop/supermarket"); it marks the row as POI-derived
  -- so the display prefers its name over the road it sits on. A POI is a full OSM
  -- object with its own id, so it is a row of its own: addresses are deduplicated
  -- on (osm_id, osm_type), and hanging it off a shared road row would put the
  -- name on every other stop along that road.
  poi_category TEXT,
  -- Bookmark for the POI repair sweep: that the row was asked about, not that
  -- anything was found — most coordinates have no POI, and they would otherwise
  -- be asked about again forever.
  poi_checked_at INTEGER,
  UNIQUE (osm_id, osm_type)
);
-- Rows that name nothing finer than their town and have not been asked about yet.
CREATE INDEX addresses_poi_unchecked ON addresses (id)
  WHERE poi_checked_at IS NULL AND poi_category IS NULL;

CREATE TABLE geofences (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  radius INTEGER NOT NULL CHECK (radius > 0 AND radius < 5000),
  billing_type TEXT NOT NULL DEFAULT 'per_kwh' CHECK (billing_type IN ('per_kwh','per_minute')),
  cost_per_unit REAL,
  session_fee_cents INTEGER,
  inserted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE drives (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  start_date_at INTEGER NOT NULL,
  end_date_at INTEGER,
  distance REAL,
  duration_min INTEGER,
  speed_max INTEGER,
  power_max INTEGER,
  power_min INTEGER,
  start_km REAL,
  end_km REAL,
  outside_temp_avg REAL,
  inside_temp_avg REAL,
  start_ideal_range_km REAL,
  end_ideal_range_km REAL,
  start_rated_range_km REAL,
  end_rated_range_km REAL,
  start_position_id INTEGER,
  end_position_id INTEGER,
  start_address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
  end_address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
  start_geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL,
  end_geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL
);
CREATE INDEX drives_car_id_start_date_at ON drives (car_id, start_date_at);
-- The statistics page's per-period rollups with "all cars" selected (its
-- default) join on the timestamp alone; without this, one table scan per bucket.
CREATE INDEX drives_start_date_at ON drives (start_date_at);
-- Partial indexes on rows opened and never closed: near-empty on a healthy
-- database, they turn the data-health card's and the live logger's open-row
-- lookups into seeks.
CREATE INDEX drives_open ON drives (car_id, start_date_at) WHERE end_date_at IS NULL;
-- The cron repair pass's "still missing an address" lookup. db/repair.ts names
-- this predicate verbatim, because SQLite will not derive it from the real one.
CREATE INDEX drives_missing_address ON drives (start_date_at)
  WHERE end_date_at IS NOT NULL AND (start_address_id IS NULL OR end_address_id IS NULL);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  drive_id INTEGER REFERENCES drives(id) ON DELETE SET NULL,
  date_at INTEGER NOT NULL,
  latitude REAL,
  longitude REAL,
  speed INTEGER,
  power INTEGER,
  odometer REAL,
  elevation INTEGER,
  ideal_battery_range_km REAL,
  rated_battery_range_km REAL,
  est_battery_range_km REAL,
  battery_level INTEGER,
  usable_battery_level INTEGER,
  outside_temp REAL,
  inside_temp REAL,
  fan_status INTEGER,
  driver_temp_setting REAL,
  passenger_temp_setting REAL,
  is_climate_on INTEGER,
  is_rear_defroster_on INTEGER,
  is_front_defroster_on INTEGER,
  battery_heater INTEGER,
  battery_heater_on INTEGER,
  battery_heater_no_power INTEGER,
  tpms_pressure_fl REAL,
  tpms_pressure_fr REAL,
  tpms_pressure_rl REAL,
  tpms_pressure_rr REAL
);
CREATE INDEX positions_drive_id_date_at ON positions (drive_id, date_at);
CREATE INDEX positions_car_id_date_at ON positions (car_id, date_at);
-- The statistics page's speed histogram across all cars: only driving samples,
-- covering every column the query reads, so it never touches the table.
CREATE INDEX positions_driving ON positions (date_at, speed, car_id) WHERE speed > 0;

CREATE TABLE charging_processes (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  start_date_at INTEGER NOT NULL,
  end_date_at INTEGER,
  charge_energy_added REAL,
  charge_energy_used REAL,
  duration_min INTEGER,
  start_battery_level INTEGER,
  end_battery_level INTEGER,
  start_ideal_range_km REAL,
  end_ideal_range_km REAL,
  start_rated_range_km REAL,
  end_rated_range_km REAL,
  outside_temp_avg REAL,
  cost_cents INTEGER,
  position_id INTEGER REFERENCES positions(id) ON DELETE SET NULL,
  address_id INTEGER REFERENCES addresses(id) ON DELETE SET NULL,
  geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL
);
CREATE INDEX charging_processes_car_id_start_date_at ON charging_processes (car_id, start_date_at);
CREATE INDEX charging_processes_start_date_at ON charging_processes (start_date_at);
CREATE INDEX charging_processes_open ON charging_processes (car_id, start_date_at) WHERE end_date_at IS NULL;
CREATE INDEX charging_processes_missing_address ON charging_processes (start_date_at)
  WHERE address_id IS NULL;

CREATE TABLE charges (
  id INTEGER PRIMARY KEY,
  charging_process_id INTEGER NOT NULL REFERENCES charging_processes(id) ON DELETE CASCADE,
  date_at INTEGER NOT NULL,
  battery_level INTEGER,
  usable_battery_level INTEGER,
  charge_energy_added REAL NOT NULL,
  charger_power INTEGER NOT NULL,
  charger_voltage INTEGER,
  charger_actual_current INTEGER,
  charger_phases INTEGER,
  charger_pilot_current INTEGER,
  conn_charge_cable TEXT,
  fast_charger_present INTEGER,
  fast_charger_brand TEXT,
  fast_charger_type TEXT,
  ideal_battery_range_km REAL NOT NULL,
  rated_battery_range_km REAL,
  not_enough_power_to_heat INTEGER,
  battery_heater INTEGER,
  battery_heater_on INTEGER,
  battery_heater_no_power INTEGER,
  outside_temp REAL,
  -- Pack temperature while charging, °C. No Tesla endpoint reports it, so logged
  -- sessions leave these NULL; an import whose source measures the modules fills
  -- them. Min and max, because the spread is what says whether the pack is evenly
  -- conditioned, and an average would hide it.
  battery_temp_min REAL,
  battery_temp_max REAL
);
CREATE INDEX charges_charging_process_id_date_at ON charges (charging_process_id, date_at);

CREATE TABLE states (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('online','asleep','offline')),
  start_date_at INTEGER NOT NULL,
  end_date_at INTEGER,
  CHECK (end_date_at IS NULL OR end_date_at >= start_date_at)
);
CREATE UNIQUE INDEX states_one_open_per_car ON states (car_id) WHERE end_date_at IS NULL;
CREATE INDEX states_car_id_start_date_at ON states (car_id, start_date_at);

CREATE TABLE updates (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  start_date_at INTEGER NOT NULL,
  end_date_at INTEGER,
  version TEXT,
  CHECK (end_date_at IS NULL OR end_date_at >= start_date_at)
);
CREATE INDEX updates_open ON updates (car_id, start_date_at) WHERE end_date_at IS NULL;
CREATE INDEX updates_car_id_start_date_at ON updates (car_id, start_date_at);

-- Backup mirror of the encrypted Tesla token pair (source of truth lives in the
-- auth actor's storage).
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_enc TEXT,
  refresh_enc TEXT,
  updated_at INTEGER NOT NULL
);

-- Ground height per coordinate, so the same road is only ever asked about once:
-- neither Tesla nor any import carries altitude, and a car drives the same roads
-- over and over. Keyed on the coordinate ×1e4 rounded (~11 m, finer than any
-- public DEM), integer so equality is exact. elevation is nullable on purpose: a
-- coordinate with no answer (at sea, a gap in the model) is remembered as such.
CREATE TABLE terrain (
  lat_e4 INTEGER NOT NULL,
  lon_e4 INTEGER NOT NULL,
  elevation INTEGER,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (lat_e4, lon_e4)
) WITHOUT ROWID;

-- The glovebox: a car's paperwork (src/api/documents.ts). Only the catalogue
-- lives here; the bytes go to the blob store (R2 on Cloudflare, a directory on a
-- VPS). blob_key and thumb_key are app-generated — nothing the user named ever
-- becomes a path or object key — and id is a UUID so download URLs are not
-- enumerable. The thumbnail is made in the browser (app/lib/image.ts); both
-- thumb columns are NULL when there is none (PDFs, undecodable images).
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  category TEXT NOT NULL,      -- 'title' | 'inspection' | 'tax' | 'insurance'
  name TEXT NOT NULL,          -- display name, from the uploaded file
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  blob_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, -- epoch ms
  thumb_key TEXT,
  thumb_type TEXT
);
CREATE INDEX documents_car_category_created ON documents (car_id, category, created_at DESC);

-- The telemetry outbox. Events are written when they happen and exported by the
-- cron in batches, so an endpoint that is down (or not configured) loses nothing
-- and no browser request waits on an export. Rows that keep failing are dropped
-- after a few attempts, and the table is capped on insert.
CREATE TABLE telemetry_queue (
  id INTEGER PRIMARY KEY,
  event_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  -- One JSON object of flat attribute key/values, mapped to OTLP on export.
  attributes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- One row per survey the instance has settled, whatever the outcome. The row's
-- existence is what "no longer prompted" means, so a sampling roll happens once.
CREATE TABLE survey_responses (
  survey_id TEXT PRIMARY KEY,
  -- 'offered' (rolled in, not yet answered), 'answered', 'dismissed', 'sampled_out'.
  status TEXT NOT NULL,
  -- JSON object of question id -> answer, for 'answered' rows.
  answers TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
