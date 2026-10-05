#!/usr/bin/env bash
# One-time preparation of a VPS to host demo.evbook.app and evbook.app.
# Everything here is idempotent — re-running it is the way to repair drift.
#
#   ./deploy/vps/bootstrap.sh root@<vps-host>
#
# It expects the box to already have Caddy, PM2 and Node 22+, and it is
# deliberately additive: the box may host other sites, so it never edits their
# Caddy site blocks or PM2 definitions, and adds exactly one `import` line to
# the main Caddyfile.
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "usage: $0 <user@host>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Preparing $TARGET"

# The Caddy snippet and the reseed script go up first; the remote script below
# only moves them into place, so a syntax error in either is caught locally.
ssh "$TARGET" 'mkdir -p /srv/evbook/.staging'
scp -q "$HERE/caddy/evbook.caddyfile" "$HERE/reseed.sh" "$TARGET:/srv/evbook/.staging/"

ssh "$TARGET" 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

echo "--> user and directories"
# --system: no login, no password, no home to leak. The app process drops to
# this user via the PM2 ecosystem file's uid/gid.
id -u evbook >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin evbook

mkdir -p /srv/evbook/releases /srv/evbook/data /var/log/evbook /etc/caddy/sites
# 755 throughout: caddy reads site/ out of the release, evbook reads dist/.
chmod 755 /srv/evbook /srv/evbook/releases
chown evbook:evbook /srv/evbook/data /var/log/evbook
chmod 750 /srv/evbook/data

echo "--> reseed script"
install -m 755 /srv/evbook/.staging/reseed.sh /srv/evbook/reseed.sh

echo "--> nightly reseed timer"
# The fixture world is generated relative to "now", so without this the demo's
# history slowly ends further and further in the past. Rebuilding also discards
# whatever visitors edited (geofences, charge costs), which a public demo wants.
cat > /etc/systemd/system/evbook-demo-reseed.service <<'UNIT'
[Unit]
Description=Rebuild the EVBook demo fixture world
After=network-online.target

[Service]
Type=oneshot
# pm2 restart at the end of the script has to reach root's PM2 daemon, the one
# that release.sh starts the app under.
Environment=PM2_HOME=/root/.pm2
ExecStart=/srv/evbook/reseed.sh
UNIT

cat > /etc/systemd/system/evbook-demo-reseed.timer <<'UNIT'
[Unit]
Description=Rebuild the EVBook demo fixture world nightly

[Timer]
# 04:17 rather than 04:00: nothing else on this box should be woken at the same
# instant, and the demo has no traffic to speak of at either time.
OnCalendar=*-*-* 04:17:00
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now evbook-demo-reseed.timer

echo "--> caddy site config"
install -m 644 /srv/evbook/.staging/evbook.caddyfile /etc/caddy/sites/evbook.caddyfile

# The origin lock every site block imports. Created empty and never overwritten:
# empty means "no restriction", which is the only correct default for a box
# whose names may not be proxied yet, and leaving an existing one alone is what
# stops a redeploy from quietly reopening the origin to the whole internet.
# deploy/cloudflare/origin-lock.sh is what writes the real contents.
if [[ ! -f /etc/caddy/sites/evbook-origin-lock.inc ]]; then
  install -m 644 /dev/null /etc/caddy/sites/evbook-origin-lock.inc
  echo "    created an empty origin lock (open to all — run origin-lock.sh after the DNS cutover)"
elif [[ -s /etc/caddy/sites/evbook-origin-lock.inc ]]; then
  echo "    origin lock in place, left untouched"
else
  echo "    origin lock present but empty (open to all)"
fi

# One line, added once, pulling in a directory this project owns — so no future
# deploy has to reopen the main Caddyfile, which other sites may live in.
if ! grep -q '^import /etc/caddy/sites/' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# Site blocks owned by individual projects (EVBook: evbook.app, demo.evbook.app).\nimport /etc/caddy/sites/*.caddyfile\n' >> /etc/caddy/Caddyfile
  echo "    appended the import line (previous Caddyfile backed up)"
else
  echo "    import line already present"
fi

# Validate before reloading: a bad snippet must not be able to take any other
# site on the box down. Caddy keeps the running config if this fails.
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# `caddy validate` opens every configured log writer, so running it as root
# creates the access logs owned by root — and the caddy user then cannot write
# them, which fails the reload with "permission denied" on a config that just
# validated. Hand them over before reloading.
touch /var/log/caddy/evbook.access.log /var/log/caddy/evbook-demo.access.log
chown caddy:caddy /var/log/caddy/evbook.access.log /var/log/caddy/evbook-demo.access.log

systemctl reload caddy
echo "    caddy reloaded"

rm -rf /srv/evbook/.staging
echo "--> done"
REMOTE_EOF

echo "==> $TARGET is ready. Deploy with: ./deploy/vps/release.sh $TARGET"
