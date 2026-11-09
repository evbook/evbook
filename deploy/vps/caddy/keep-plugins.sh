#!/bin/sh
# Installed on the VPS as /usr/local/sbin/caddy-keep-plugins by
# deploy/vps/caddy-guard.sh, and run by apt after every dpkg run
# (DPkg::Post-Invoke in /etc/apt/apt.conf.d/99caddy-keep-plugins).
#
# The caddy .deb ships the stock binary. If the box's Caddyfile needs a
# non-standard module (a DNS provider, say), upgrading the package silently
# drops it. The old process keeps serving from memory, so nothing looks wrong
# until the next restart or reboot, when Caddy can no longer parse its config
# and every site on the box goes down. That happened on 2026-10-29.
#
# This puts back every package listed in /etc/caddy/extra-packages and, if
# the package's own restart left Caddy dead, starts it again once the config
# validates. It must never fail an apt run, so it always exits 0.
set -u

LIST=/etc/caddy/extra-packages
CADDY=/usr/bin/caddy

[ -x "$CADDY" ] && [ -s "$LIST" ] || exit 0

have="$("$CADDY" list-modules --packages --skip-standard 2>/dev/null | awk 'NF == 2 { print $2 }')"
missing=""
for pkg in $(grep -v '^[[:space:]]*#' "$LIST"); do
  printf '%s\n' "$have" | grep -qxF "$pkg" || missing="$missing $pkg"
done
[ -z "$missing" ] && exit 0

logger -t caddy-keep-plugins "caddy binary lacks:$missing; re-adding"
# `add-package` downloads a build of the latest release from caddyserver.com
# with these packages added, not of the version apt just installed.
for pkg in $missing; do
  if ! "$CADDY" add-package "$pkg" >/dev/null 2>&1; then
    logger -t caddy-keep-plugins "add-package $pkg failed; Caddy will not survive a restart"
    exit 0
  fi
done
logger -t caddy-keep-plugins "re-added:$missing ($("$CADDY" version | cut -d' ' -f1))"

# Validate as the caddy user: run as root, validate creates any missing access
# logs owned by root, and the service then cannot open them.
if systemctl is-enabled -q caddy && ! systemctl is-active -q caddy; then
  if runuser -u caddy -- "$CADDY" validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    systemctl start caddy && logger -t caddy-keep-plugins "caddy was down after the upgrade; started it"
  else
    logger -t caddy-keep-plugins "caddy is down and the Caddyfile does not validate; not starting it"
  fi
fi
exit 0
