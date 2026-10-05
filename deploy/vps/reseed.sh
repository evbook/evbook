#!/usr/bin/env bash
# Rebuilds the demo's fixture world and restarts the app. Installed at
# /srv/evbook/reseed.sh by bootstrap.sh; run nightly by
# evbook-demo-reseed.timer, and by release.sh on a first deploy.
#
# The world is generated relative to "now", so a database seeded months ago
# shows a car that stopped driving months ago. Rebuilding also drops whatever
# visitors changed — for a public demo that is the point, not a side effect.
set -euo pipefail

ROOT=/srv/evbook
CURRENT="$ROOT/current"
DATA="$ROOT/data"

if [[ ! -d "$CURRENT" ]]; then
  echo "no release at $CURRENT — nothing to seed against" >&2
  exit 1
fi

# Resolve the symlink before invoking node. seed.mjs guards its entry point with
# `import.meta.url === "file://" + process.argv[1]`, and Node resolves the main
# module to its realpath while leaving argv[1] as written — so calling it
# through `current` makes that comparison false and the script exits 0 having
# done nothing at all. Seeding through the real path is the whole fix.
RELEASE="$(readlink -f "$CURRENT")"

echo "==> seeding $DATA from $RELEASE"
# --fresh removes the state directory first, so this is a rebuild rather than a
# merge. seed.mjs needs only node builtins (node:sqlite) — no node_modules on
# this box, by design.
node "$RELEASE/demo/seed.mjs" --state-dir "$DATA" --fresh

# Assert the seed actually happened rather than trusting an exit code. A seeder
# that quietly does nothing (see the symlink note above) would otherwise leave
# the demo serving an empty database and look like a successful deploy.
CARS="$(node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  process.stdout.write(String(db.prepare("SELECT count(*) n FROM cars").get().n));
' "$DATA/evbook.sqlite" 2>/dev/null || echo 0)"

if [[ "$CARS" -lt 1 ]]; then
  echo "!! seeding produced no cars — refusing to restart onto an empty database" >&2
  exit 1
fi
echo "==> seeded $CARS cars"

# --fresh recreated the directory as root; the app runs as evbook and needs to
# write the WAL and shm files beside the database.
chown -R evbook:evbook "$DATA"
chmod 750 "$DATA"

if pm2 describe evbook-demo >/dev/null 2>&1; then
  echo "==> restarting evbook-demo"
  pm2 restart evbook-demo --update-env
else
  echo "==> evbook-demo is not registered with PM2 yet; skipping restart"
fi

echo "==> reseed complete"
