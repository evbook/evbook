-- What polling cannot know, recorded as such.
--
-- A poller never sees a transition, only readings either side of it: the car
-- was asleep at one probe and driving at the next. So each end of a drive or a
-- charge is a span, not an instant — it happened no earlier than *_after_at and
-- no later than *_before_at. NULL means that bound is the row's own
-- start_date_at / end_date_at, which stay the best point estimate (what lists
-- sort by and durations are measured between). The UI collapses a span of two
-- minutes or less into one time; anything wider is shown as a range.
--
-- `reconstructed` marks an event nobody saw at all: the car was asleep, offline,
-- its token had expired or the Worker was down, and the odometer (a drive) or
-- the state of charge (a charge) moved in between. Such a row has no samples,
-- no duration (NULL, never 0), and both ends span the whole gap. It counts in
-- every total its known figures count in.
--
-- `origin_reconstructed` marks a drive whose first position is the car's last
-- parked point rather than a sample (core/driveOrigin.ts).
--
-- `cost_max_cents` is the top of a cost range, `cost_cents` its bottom: a
-- per-minute tariff over a bounded duration, or a per-kWh one over energy known
-- only from the state of charge. NULL: the cost is exactly cost_cents.
ALTER TABLE drives ADD COLUMN start_after_at INTEGER;
ALTER TABLE drives ADD COLUMN start_before_at INTEGER;
ALTER TABLE drives ADD COLUMN end_after_at INTEGER;
ALTER TABLE drives ADD COLUMN end_before_at INTEGER;
ALTER TABLE drives ADD COLUMN reconstructed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drives ADD COLUMN origin_reconstructed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE charging_processes ADD COLUMN start_after_at INTEGER;
ALTER TABLE charging_processes ADD COLUMN start_before_at INTEGER;
ALTER TABLE charging_processes ADD COLUMN end_after_at INTEGER;
ALTER TABLE charging_processes ADD COLUMN end_before_at INTEGER;
ALTER TABLE charging_processes ADD COLUMN reconstructed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE charging_processes ADD COLUMN cost_max_cents INTEGER;

-- Cursor of the hidden-event sweep (db/repair.ts): the instant up to which every
-- gap between readings has been examined. NULL: not started.
ALTER TABLE settings ADD COLUMN gaps_swept_until INTEGER;

-- Drives the origin sweep already gave a parked-point origin. That row is
-- recognisable: a position with coordinates and nothing else, which is how
-- estimateDriveOrigin writes it and no sample ever arrives.
UPDATE drives SET origin_reconstructed = 1
WHERE EXISTS (
  SELECT 1 FROM positions p
  WHERE p.id = drives.start_position_id
    AND p.latitude IS NOT NULL AND p.speed IS NULL AND p.power IS NULL
    AND p.battery_level IS NULL AND p.rated_battery_range_km IS NULL
    AND p.ideal_battery_range_km IS NULL AND p.outside_temp IS NULL
);

-- The origin sweep runs once more to give those drives their start bounds —
-- and every other drive the check of whether its unseen start is plausible.
UPDATE settings SET drive_origin_swept_before = NULL WHERE id = 1;
