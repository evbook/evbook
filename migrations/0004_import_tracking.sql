-- Which rows an import brought, so it can be replaced and deleted as a whole.
--
-- A TeslaMate import writes its rows directly (src/core/import/teslamate.ts)
-- rather than replaying samples, and a re-import of the same backup has to
-- supersede the previous one exactly — not by period, because the live logger
-- keeps writing beside it. So each history row an import writes carries the id
-- of its `imports` row, and deleting an import is "delete where import_id = ?".
-- One `imports` row per car per import job.
--
-- No foreign key from the history tables: deleting the bookkeeping row must not
-- cascade millions of positions in one statement — the rows are removed in
-- chunks first (purgeImport), and the bookkeeping row last. Rows the live
-- logger writes leave import_id NULL, which the partial indexes skip, so they
-- cost logging nothing.
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  car_id INTEGER NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  -- The uploaded file's name.
  label TEXT,
  -- EVBook's first reading of the car when the import started: only history
  -- from before it was taken. NULL when the car had no readings at all.
  cutoff_at INTEGER,
  -- 'importing' while rows are still arriving, 'done', or 'deleting' while
  -- purgeImport works through it.
  status TEXT NOT NULL DEFAULT 'importing',
  -- Imported and skipped counts, as JSON, for the import page's history list.
  counts TEXT,
  first_at INTEGER,
  last_at INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX imports_car_id ON imports (car_id);

ALTER TABLE drives ADD COLUMN import_id INTEGER;
ALTER TABLE positions ADD COLUMN import_id INTEGER;
ALTER TABLE charging_processes ADD COLUMN import_id INTEGER;
ALTER TABLE charges ADD COLUMN import_id INTEGER;
ALTER TABLE states ADD COLUMN import_id INTEGER;
ALTER TABLE updates ADD COLUMN import_id INTEGER;

CREATE INDEX drives_import_id ON drives (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX positions_import_id ON positions (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX charging_processes_import_id ON charging_processes (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX charges_import_id ON charges (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX states_import_id ON states (import_id) WHERE import_id IS NOT NULL;
CREATE INDEX updates_import_id ON updates (import_id) WHERE import_id IS NOT NULL;

-- charging_processes.position_id references positions, and SQLite checks a
-- child table on every parent delete. Without an index that is a scan of all
-- charging sessions per deleted position — fine for the live logger, which
-- never deletes positions, ruinous for removing an import of millions.
CREATE INDEX charging_processes_position_id ON charging_processes (position_id) WHERE position_id IS NOT NULL;
