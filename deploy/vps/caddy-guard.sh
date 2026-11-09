#!/usr/bin/env bash
# Stops a Caddy package upgrade from taking the box down.
#
#   ./deploy/vps/caddy-guard.sh root@<vps-host>
#
# The box's Caddy is a custom build: the shared Caddyfile needs modules the
# stock .deb does not have. This script, which is idempotent:
#   1. records the non-standard packages the running binary has in
#      /etc/caddy/extra-packages (merged with whatever is listed there already);
#   2. installs caddy/keep-plugins.sh as an apt post-invoke hook that re-adds
#      them whenever a dpkg run leaves them missing;
#   3. puts the caddy package on hold, so unattended-upgrades leaves it alone.
#
# To upgrade Caddy deliberately:
#   apt-mark unhold caddy && apt-get install caddy && apt-mark hold caddy
# The hook puts the modules back, and starts Caddy again if needed.
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "usage: $0 <user@host>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Guarding Caddy on $TARGET"
scp -q "$HERE/caddy/keep-plugins.sh" "$TARGET:/usr/local/sbin/caddy-keep-plugins.new"

ssh "$TARGET" 'bash -s' <<'REMOTE_EOF'
set -euo pipefail
install -m 755 /usr/local/sbin/caddy-keep-plugins.new /usr/local/sbin/caddy-keep-plugins
rm -f /usr/local/sbin/caddy-keep-plugins.new

list=/etc/caddy/extra-packages
touch "$list"
current="$(caddy list-modules --packages --skip-standard | awk 'NF == 2 { print $2 }')"
{
  echo "# Non-standard Caddy packages this box's config needs."
  echo "# Re-added after apt upgrades by /usr/local/sbin/caddy-keep-plugins."
  { grep -v '^[[:space:]]*#' "$list" || true; printf '%s\n' "$current"; } | sed '/^$/d' | sort -u
} > "$list.new"
mv "$list.new" "$list"
echo "--> extra packages:"
grep -v '^#' "$list" | sed 's/^/    /'

cat > /etc/apt/apt.conf.d/99caddy-keep-plugins <<'EOF'
// Installed by EVBook's deploy/vps/caddy-guard.sh. Re-adds the Caddy modules
// listed in /etc/caddy/extra-packages if a package upgrade dropped them.
DPkg::Post-Invoke { "/usr/local/sbin/caddy-keep-plugins || true"; };
EOF

apt-mark hold caddy >/dev/null
echo "--> held: $(apt-mark showhold | grep -x caddy || echo 'NOT HELD')"

# Missing modules would fail this before any reload or reboot does.
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
echo "--> caddy $(caddy version | cut -d' ' -f1), $(systemctl is-active caddy)"
REMOTE_EOF
