-- Failed sign-ins, so guessing the app password gets slower the longer it goes
-- on (src/core/loginThrottle.ts). One row per client: an address (an IPv6
-- address by its /64) when the runtime knows who is asking, or `*` for every
-- request it cannot tell apart, which is only ever slowed down and never locked.
-- `locked_until` is set only on an address's row. A row that was never locked
-- is forgotten once 15 minutes have passed without a failure; one that was
-- locked is kept for 24 hours after its lock ends, so the next lock doubles.
-- A successful sign-in deletes the row.
CREATE TABLE login_failures (
  client TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  locked_until INTEGER
);
