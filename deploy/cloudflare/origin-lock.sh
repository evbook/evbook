#!/usr/bin/env bash
# Closes the VPS to everything except Cloudflare's edge — the step that turns
# "served through Cloudflare" into "reachable only through Cloudflare". Part of
# how the project hosts its own public demo, not an install path.
#
#   deploy/cloudflare/origin-lock.sh root@<origin-ip>
#   deploy/cloudflare/origin-lock.sh root@<origin-ip> --off   # undo
#
# The origin address (used to confirm the lock by connecting to it directly) is
# taken from ORIGIN_IP, or from the host part of <user@host> when that — or the
# HostName ssh resolves it to — is an IP address.
#
# Run it AFTER the DNS cutover. It refuses to run before, because locking the
# origin while the public records still point straight at it takes all three
# names offline.
#
# Only EVBook's three site blocks are affected. The box may host other sites,
# and they are not touched: the lock lives in
# /etc/caddy/sites/evbook-origin-lock.inc, which only evbook.caddyfile imports.
set -euo pipefail

TARGET="${1:-}"
MODE="${2:-on}"
ZONE="evbook.app"

if [[ -z "$TARGET" ]]; then
  echo "usage: [ORIGIN_IP=<origin-ip>] $0 <user@host> [--off]" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/../../.env" ]] && set -a && . "$HERE/../../.env" && set +a

# ORIGIN_IP wins; otherwise the target's host, as ssh would resolve it (so an
# ssh config alias works too), provided that is an IP literal. A hostname is not
# guessed at: after the cutover it resolves to the edge, not the origin.
ORIGIN="${ORIGIN_IP:-}"
if [[ -z "$ORIGIN" ]]; then
  candidate="$(ssh -G "$TARGET" 2>/dev/null | awk '$1=="hostname"{print $2; exit}')"
  if [[ "$candidate" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$candidate" == *:* ]]; then
    ORIGIN="$candidate"
  fi
fi
if [[ -z "$ORIGIN" ]]; then
  echo "cannot tell the origin address from '$TARGET'. Set ORIGIN_IP to the VPS's" >&2
  echo "public IP (in ./.env or the environment), or pass the target as user@<ip>." >&2
  exit 2
fi

INC=/etc/caddy/sites/evbook-origin-lock.inc

if [[ "$MODE" == "--off" ]]; then
  echo "==> unlocking the origin"
  BODY=""
else
  # The guard, in two parts, because there are two different ways this step can
  # cause an outage.
  #
  # First: is the delegation actually done? Asked of the .app registry rather
  # than any resolver — a local or recursive cache can hold the pre-cutover
  # answer for the length of the old TTL and would report a false negative.
  echo "==> checking the delegation at the registry"
  tld_ns="$(dig +short NS app. | head -1)"
  parent_ns="$(dig +norecurse @"$tld_ns" "$ZONE" NS +noall +authority 2>/dev/null \
    | awk '$4=="NS"{print $5}' | sort | tr '\n' ' ')"
  if [[ "$parent_ns" != *cloudflare.com* ]]; then
    echo "    refusing: the registry still delegates $ZONE to ${parent_ns:-nothing}" >&2
    echo "    run deploy/cloudflare/cutover.sh first." >&2
    exit 1
  fi
  echo "    registry delegates to: $parent_ns"

  # Second, and the subtle one: a resolver that still holds the OLD A record is
  # handing clients the origin IP directly. Those clients bypass the edge, so
  # the moment this lock goes on they get a 403 instead of the site — a real
  # partial outage lasting as long as that cache. Delegation being live is not
  # enough; the old answers have to be gone too.
  echo "==> checking no resolver still hands out the origin"
  stale=""
  for r in 1.1.1.1 8.8.8.8 9.9.9.9 208.67.222.222; do
    for name in "$ZONE" "www.$ZONE" "demo.$ZONE"; do
      if dig +short "$name" A @"$r" 2>/dev/null | grep -qx "$ORIGIN"; then
        stale="$stale $r($name)"
      fi
    done
  done
  if [[ -n "$stale" ]]; then
    echo "    refusing: these resolvers still return the origin address:$stale" >&2
    echo "    Locking now would 403 everyone using them. Wait for the old TTL to" >&2
    echo "    expire — minutes, usually — and re-run. Nothing needs to be undone." >&2
    exit 1
  fi
  echo "    every checked resolver returns the edge"

  # Fetched live rather than pasted in: Cloudflare adds ranges, and a stale
  # hand-copied list turns into a partial outage that looks like a random 403.
  echo "==> fetching Cloudflare's published ranges"
  V4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
  V6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
  RANGES="$(printf '%s\n%s\n' "$V4" "$V6" | grep -E '^[0-9a-fA-F.:]+/[0-9]+$' | tr '\n' ' ')"
  count="$(printf '%s' "$RANGES" | wc -w | tr -d ' ')"
  # The published list is 22 prefixes today. The floor only has to catch a
  # truncated response or an error page, not track the real number.
  if (( count < 15 )); then
    echo "    refusing: only $count ranges came back, that does not look like the real list" >&2
    exit 1
  fi
  echo "    $count ranges"

  # A named matcher is scoped to the site block that imports it, so the same
  # name in all three blocks is fine.
  #
  # The ACME exemption is belt and braces: Caddy answers HTTP-01 challenges from
  # a handler that already runs ahead of these routes, but an origin that cannot
  # renew its certificate fails Full (strict) two months later, and that is not
  # a failure anyone connects back to this file.
  # Built with printf rather than a heredoc inside $( ): bash 3.2, still the
  # default on macOS, mis-parses that combination.
  BODY="$(printf '%s\n' \
    "# Generated by deploy/cloudflare/origin-lock.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)." \
    "# Do not hand-edit: re-run the script to refresh Cloudflare's ranges." \
    "@not_cloudflare {" \
    "$(printf '\tnot remote_ip %s' "$RANGES")" \
    "$(printf '\tnot path /.well-known/acme-challenge/*')" \
    "}" \
    "respond @not_cloudflare \"This host is served through Cloudflare.\" 403 {" \
    "$(printf '\tclose')" \
    "}")"
fi

# Writing the include achieves nothing unless the installed site config imports
# it, and an older evbook.caddyfile does not. Checked explicitly, because the
# symptom otherwise is this script reporting success over an origin that is
# still wide open.
echo "==> checking the installed Caddy config imports the lock"
if ! ssh "$TARGET" "grep -q 'evbook-origin-lock.inc' /etc/caddy/sites/evbook.caddyfile" 2>/dev/null; then
  echo "    refusing: /etc/caddy/sites/evbook.caddyfile has no import for the lock." >&2
  echo "    It predates this feature. Ship the current one first:" >&2
  echo "      ./deploy/vps/bootstrap.sh $TARGET" >&2
  exit 1
fi
echo "    import present"

echo "==> installing on $TARGET"
printf '%s\n' "$BODY" | ssh "$TARGET" "cat > /tmp/evbook-origin-lock.inc"

ssh "$TARGET" "INC='$INC' bash -euo pipefail -s" <<'REMOTE'
install -m 644 /tmp/evbook-origin-lock.inc "$INC"
rm -f /tmp/evbook-origin-lock.inc

# Validate before reloading. The box may serve other sites from the same Caddy;
# a bad include must not be able to take them down. Caddy keeps the
# running config if validation fails.
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# `caddy validate` as root opens every configured log writer, which can leave an
# access log owned by root — and the caddy user then cannot write it, failing a
# reload on a config that just validated.
chown caddy:caddy /var/log/caddy/evbook.access.log /var/log/caddy/evbook-demo.access.log 2>/dev/null || true

systemctl reload caddy
echo "    caddy reloaded"
REMOTE

# Prove it. A reload that succeeds says only that the config parsed — not that
# the lock is in the request path. Ask the origin directly, with SNI, exactly
# the way a bypass attempt would.
echo "==> confirming the effect at the origin"
BAD=0
for name in "$ZONE" "www.$ZONE" "demo.$ZONE"; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    --resolve "$name:443:$ORIGIN" "https://$name/" 2>/dev/null || echo 000)"
  if [[ "$MODE" == "--off" ]]; then
    if [[ "$code" == "403" ]]; then
      echo "    $name: still 403 — expected it to be open again" >&2; BAD=1
    else
      echo "    $name: $code (open, as intended)"
    fi
  else
    if [[ "$code" == "403" ]]; then
      echo "    $name: 403 (locked)"
    else
      echo "    $name: $code — NOT locked, the origin still answers directly" >&2; BAD=1
    fi
  fi
done

if (( BAD )); then
  echo "==> the lock is not doing what it claims. Investigate before trusting it." >&2
  exit 1
fi

if [[ "$MODE" == "--off" ]]; then
  echo "==> origin is open again"
else
  echo "==> origin locked; only Cloudflare's edge can reach it."
  echo "    deploy/cloudflare/verify.sh should still pass."
fi
