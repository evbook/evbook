-- Tyre pressures over time, with what the car recommends and what it warns of.
--
-- Pressures are only read while the car is already awake for some other
-- reason — the logger never polls, let alone wakes, the car for them. A row is
-- written at most every 15 minutes while readings arrive, and straight away
-- when a warning or a recommended pressure changes, so a warning is never
-- missing from the history for a quarter of an hour.
--
-- Every column but the key is nullable, and NULL means the car did not say:
-- never 0 for a pressure, never 0 for "no warning". A 0/1 in a warning column
-- is the car's own word.
--
-- Pressures and recommended cold pressures (Tesla's `tpms_rcp_*`) are in bar,
-- as the car reports them. At ~80 bytes a row and one row per 15 minutes of
-- awake time, a car that is awake four hours a day writes ~6 000 rows (~0.5 MB)
-- a year — little enough to keep every row rather than thin older ones out.
CREATE TABLE tyre_readings (
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  date_at INTEGER NOT NULL,
  pressure_fl REAL,
  pressure_fr REAL,
  pressure_rl REAL,
  pressure_rr REAL,
  recommended_front REAL,
  recommended_rear REAL,
  soft_warning_fl INTEGER,
  soft_warning_fr INTEGER,
  soft_warning_rl INTEGER,
  soft_warning_rr INTEGER,
  hard_warning_fl INTEGER,
  hard_warning_fr INTEGER,
  hard_warning_rl INTEGER,
  hard_warning_rr INTEGER,
  PRIMARY KEY (car_id, date_at)
) WITHOUT ROWID;
