-- Time-of-use tariffs (core/tariff.ts, core/derive/cost.ts, db/pricing.ts).
--
-- A place's price becomes a list of dated prices, each a base rate plus time
-- windows with their own rate. It is stored as one JSON column rather than
-- tariff/price/window tables: it is only ever read and written whole — the form
-- edits it whole, pricing reads it whole per place — never queried by its parts;
-- places number in the tens; and a single-row UPDATE is atomic on D1, where three
-- tables would need a delete-and-reinsert batch on every save. The API validates
-- its shape (src/api/geofences.ts) before it is stored.
--
-- `tariff` NULL means "not converted yet": the flat price in billing_type /
-- cost_per_unit / session_fee_cents becomes the tariff's single dated price the
-- first time anything reads the place (db/pricing.ts `placePricing`). That step is
-- in TypeScript because the price's first day is a *local* day — the day of the
-- place's first priced session, else of its last edit, in the account's time zone
-- — and SQLite has no zone database to compute one with. '[]' is "no tariff".
-- The flat columns are kept, unread from then on, so nothing that wrote them
-- breaks and the conversion can always be redone from them.
ALTER TABLE geofences ADD COLUMN tariff TEXT;
-- IANA zone the tariff's days and hours are in; NULL: settings.timezone.
ALTER TABLE geofences ADD COLUMN timezone TEXT;
-- The charger's power in kW, which caps how much energy any hour can take.
ALTER TABLE geofences ADD COLUMN charger_power_kw REAL;
-- Battery energy / grid energy, 0–1; NULL: 0.88 AC, 0.95 DC.
ALTER TABLE geofences ADD COLUMN ac_efficiency REAL;
ALTER TABLE geofences ADD COLUMN dc_efficiency REAL;

-- Where a session's cost came from:
--   'tariff'  the place's price; recomputed whenever that price changes
--   'manual'  the owner's own figure; never touched by any recomputation
--   'legacy'  recorded before tariffs; kept as it was unless the tariff
--             reproduces it exactly, in which case it becomes 'tariff'
--   NULL      no cost
ALTER TABLE charging_processes ADD COLUMN cost_source TEXT CHECK (cost_source IN ('tariff', 'manual', 'legacy'));
-- 1: the cost has to be worked out again (a price changed, the session moved
-- place, or it predates tariffs). The cron sweep and every edit work these off in
-- small batches, newest first, so no request carries a whole history.
ALTER TABLE charging_processes ADD COLUMN cost_stale INTEGER NOT NULL DEFAULT 0;
-- JSON CostDetailDto: how a tariff cost was arrived at, for the charge page.
ALTER TABLE charging_processes ADD COLUMN cost_detail TEXT;
-- With a manual cost: the kWh on the bill, and the owner's note.
ALTER TABLE charging_processes ADD COLUMN cost_billed_kwh REAL;
ALTER TABLE charging_processes ADD COLUMN cost_note TEXT;

-- Repricing a place's sessions in a range of days, and its first session.
CREATE INDEX charging_processes_geofence ON charging_processes (geofence_id, start_date_at);
-- The sweep's queue: near-empty once it has caught up.
CREATE INDEX charging_processes_cost_stale ON charging_processes (start_date_at) WHERE cost_stale = 1;

-- Every cost so far was either derived from a flat price or typed in, and
-- nothing recorded which. Both are kept: the sweep reprices each one and only a
-- cost the tariff reproduces to the cent becomes 'tariff'; the rest stay as they
-- are. Sessions at a place with no cost yet are queued too, so a priced place's
-- sessions get their breakdown.
UPDATE charging_processes SET cost_source = 'legacy' WHERE cost_cents IS NOT NULL;
UPDATE charging_processes SET cost_stale = 1
WHERE end_date_at IS NOT NULL AND (cost_cents IS NOT NULL OR geofence_id IS NOT NULL);
