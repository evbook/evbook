-- What the update check knows about the newest release besides its name: the
-- commit the tag points at and when that commit was made. Settings shows the
-- date beside the version, and the revision on hover. Both are null until a
-- check has learned them, and stay null on an instance that never asks.
ALTER TABLE settings ADD COLUMN update_latest_sha TEXT;
ALTER TABLE settings ADD COLUMN update_latest_at INTEGER;
