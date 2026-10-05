#!/usr/bin/env bash
# Ships the current build to the VPS and cuts it over.
#
#   npm run build:app && npm run build:server
#   ./deploy/vps/release.sh root@<vps-host> [release-id]
#
# Nothing is built on the box: the server bundle is self-contained (esbuild
# leaves only node: builtins), the fixture seeder needs only node:sqlite, and
# the landing page is static — so a release is a tarball of files and a symlink
# flip. `current` staying a symlink is what makes a rollback one command.
set -euo pipefail

TARGET="${1:-}"
RELEASE="${2:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 <user@host> [release-id]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

for required in dist/server/main.js dist/client/index.html site/index.html; do
  if [[ ! -e "$required" ]]; then
    echo "missing $required — run 'npm run build:app && npm run build:server' first" >&2
    exit 1
  fi
done

TARBALL="$(mktemp -t evbook-release-XXXXXX).tar.gz"
trap 'rm -f "$TARBALL"' EXIT

echo "==> packing release $RELEASE"
# demo/ and e2e/mocks/ are the fixture generator, which the nightly reseed runs
# on the box; migrations/ is applied by the server at boot.
#
# COPYFILE_DISABLE and --no-xattrs keep macOS's bsdtar from writing AppleDouble
# and xattr headers that GNU tar on the far end then warns about for every
# single file.
TAR_FLAGS=()
if tar --no-xattrs --version >/dev/null 2>&1; then TAR_FLAGS+=(--no-xattrs); fi
COPYFILE_DISABLE=1 tar "${TAR_FLAGS[@]}" -czf "$TARBALL" \
  dist migrations demo e2e/mocks site \
  -C deploy/vps ecosystem.config.cjs
echo "    $(du -h "$TARBALL" | cut -f1)"

echo "==> uploading"
ssh "$TARGET" "mkdir -p /srv/evbook/releases/$RELEASE"
scp -q "$TARBALL" "$TARGET:/srv/evbook/releases/$RELEASE/release.tar.gz"

echo "==> installing"
ssh "$TARGET" "RELEASE=$RELEASE bash -s" <<'REMOTE_EOF'
set -euo pipefail

ROOT=/srv/evbook
DIR="$ROOT/releases/$RELEASE"
PREVIOUS="$(readlink -f "$ROOT/current" 2>/dev/null || true)"

tar -xzf "$DIR/release.tar.gz" -C "$DIR"
rm -f "$DIR/release.tar.gz"
# Caddy (as user `caddy`) serves site/ straight out of the release, and the
# evbook user reads dist/ — both need the path traversable.
chmod -R a+rX "$DIR"

ln -sfn "$DIR" "$ROOT/current.new"
mv -T "$ROOT/current.new" "$ROOT/current"
echo "    current -> $DIR"

# A first deploy has no fixture world yet; later ones keep the database the
# nightly timer owns. Migrations still run at boot, so a release that adds one
# is applied to the existing demo data rather than forcing a rebuild.
if [[ ! -f "$ROOT/data/evbook.sqlite" ]]; then
  echo "==> no fixture database yet — seeding"
  "$ROOT/reseed.sh"
fi

echo "==> starting under PM2"
# startOrRestart is the idempotent form: it starts the app if this is the first
# deploy and restarts it (picking up the new env) if it is already running.
pm2 startOrRestart "$ROOT/current/ecosystem.config.cjs" --update-env
# Persist the process list so the existing `pm2 startup` unit brings the demo
# back with everything else after a reboot.
pm2 save --force

echo "==> waiting for health"
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:3100/health_check >/dev/null 2>&1; then
    echo "    healthy after ${attempt}s"
    healthy=yes
    break
  fi
  sleep 1
done

if [[ "${healthy:-no}" != "yes" ]]; then
  echo "!! evbook-demo did not become healthy" >&2
  pm2 logs evbook-demo --lines 40 --nostream || true
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" && "$PREVIOUS" != "$DIR" ]]; then
    echo "!! rolling back to $PREVIOUS" >&2
    ln -sfn "$PREVIOUS" "$ROOT/current.new"
    mv -T "$ROOT/current.new" "$ROOT/current"
    pm2 startOrRestart "$ROOT/current/ecosystem.config.cjs" --update-env
    pm2 save --force
  fi
  exit 1
fi

# Keep the last five, so a rollback has somewhere to go without the disk
# filling up with builds nobody will ever return to.
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +6 | while read -r old; do
  [[ "$(readlink -f "$old")" == "$(readlink -f "$ROOT/current")" ]] && continue
  echo "    pruning $(basename "$old")"
  rm -rf "$old"
done

echo "==> deployed"
REMOTE_EOF

echo "==> release $RELEASE is live"
