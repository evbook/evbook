#!/usr/bin/env bash
# Proves the three names really are behind Cloudflare and still work. Part of
# how the project hosts its own public demo, not an install path.
#
#   ORIGIN_IP=<origin-ip> deploy/cloudflare/verify.sh
#   ORIGIN_IP=<origin-ip> RESOLVER=9.9.9.9 deploy/cloudflare/verify.sh
#
# ORIGIN_IP (also read from ./.env) is the VPS's public address: used to check
# no name still resolves to it, and to inspect the certificate the edge sees.
#
# Deliberately does not trust the machine it runs on. A laptop's resolver — and
# any recursive resolver — can hold the pre-cutover answers for as long as the
# old TTL, so "still on the old nameservers" from a local `dig` proves nothing about the
# state of the world. Delegation is therefore read from the .app registry
# itself, and the HTTP checks pin the edge address rather than resolving it.
#
# Exits non-zero on the first thing that is genuinely wrong, so it is usable as
# a gate after a cutover.
set -euo pipefail

ZONE="evbook.app"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/../../.env" ]] && set -a && . "$HERE/../../.env" && set +a
: "${ORIGIN_IP:?is empty. Set it to the public IP address of the VPS, in ./.env or the environment.}"
ORIGIN="$ORIGIN_IP"
RESOLVER="${RESOLVER:-8.8.8.8}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }
note() { printf '    %s\n' "$*"; }
FAILED=0

printf '\n\033[1mdelegation (asked of the .app registry, not a cache)\033[0m\n'
TLD_NS="$(dig +short NS app. | head -1)"
PARENT_NS="$(dig +norecurse @"$TLD_NS" "$ZONE" NS +noall +authority 2>/dev/null \
  | awk '$4=="NS"{print $5}' | sort | tr '\n' ' ')"

if [[ -z "$PARENT_NS" ]]; then
  fail "could not read the delegation from $TLD_NS"
  exit 1
elif [[ "$PARENT_NS" == *cloudflare.com* ]]; then
  pass "registry delegates to: $PARENT_NS"
else
  fail "registry still delegates to: $PARENT_NS"
  exit 1
fi

# Informational: how far the change has spread. Never a failure — a resolver
# holding the old answer is a clock, not a fault.
printf '\n\033[1mpropagation\033[0m\n'
for r in 1.1.1.1 8.8.8.8 9.9.9.9; do
  seen="$(dig +short "$ZONE" NS @"$r" 2>/dev/null | sort | tr '\n' ' ')"
  if [[ "$seen" == *cloudflare.com* ]]; then
    pass "$r updated"
  else
    note "· $r still cached (harmless, expires on its own)"
  fi
done
sys="$(dig +short "$ZONE" NS 2>/dev/null | sort | tr '\n' ' ')"
[[ "$sys" == *cloudflare.com* ]] && pass "this machine's resolver updated" \
  || note "· this machine's resolver still cached — the checks below route around it"

printf '\n\033[1mproxying (via %s)\033[0m\n' "$RESOLVER"
# A proxied record answers with Cloudflare anycast space, never the VPS. If the
# origin IP is still in public DNS, the name is on Cloudflare but not behind it.
declare -a EDGE_IP
for name in "$ZONE" "www.$ZONE" "demo.$ZONE"; do
  ips="$(dig +short "$name" A @"$RESOLVER" 2>/dev/null | tr '\n' ' ')"
  if [[ -z "$ips" ]]; then
    fail "$name does not resolve"
  elif [[ "$ips" == *"$ORIGIN"* ]]; then
    fail "$name still resolves to the origin ($ips) — record is not proxied"
  else
    pass "$name -> $ips"
    EDGE_IP+=("$name=$(printf '%s' "$ips" | awk '{print $1}')")
  fi
done
(( FAILED )) && { printf '\n\033[31mrecords are not right — stopping before the HTTP checks\033[0m\n\n'; exit 1; }

edge_for() { # edge_for <name>
  local n="$1" e
  for e in "${EDGE_IP[@]}"; do [[ "${e%%=*}" == "$n" ]] && { printf '%s' "${e#*=}"; return; }; done
}

printf '\n\033[1mserving (pinned to the edge address)\033[0m\n'
# cf-ray is only present on a response that came through Cloudflare, so it is
# the cheapest positive proof; the status code proves the origin behind it is
# healthy rather than the edge erroring on its own.
check_http() { # check_http <host> <path> <expected-status> <what>
  local host="$1" path="$2" want="$3" what="$4" out code ray
  out="$(curl -sS -o /dev/null -D - --max-time 20 \
    --resolve "$host:443:$(edge_for "$host")" "https://$host$path" 2>&1 || true)"
  code="$(printf '%s' "$out" | awk 'NR==1{print $2}')"
  ray="$(printf '%s' "$out" | tr -d '\r' | awk -F': ' 'tolower($1)=="cf-ray"{print $2}')"
  if [[ "$code" != "$want" ]]; then
    fail "$what: expected HTTP $want, got ${code:-no response}"
  elif [[ -z "$ray" ]]; then
    fail "$what: HTTP $code but no cf-ray — not served through Cloudflare"
  else
    pass "$what: HTTP $code, cf-ray $ray"
  fi
}

check_http "$ZONE"      "/"             200 "landing page"
check_http "demo.$ZONE" "/"             200 "demo app"
check_http "demo.$ZONE" "/health_check" 200 "demo health check"
check_http "www.$ZONE"  "/"             301 "www redirect"

# The demo's health check is the app itself answering, not Caddy and not the
# edge — if this is not the real JSON, something in the chain is substituting.
body="$(curl -sS --max-time 20 --resolve "demo.$ZONE:443:$(edge_for "demo.$ZONE")" \
  "https://demo.$ZONE/health_check" 2>/dev/null || true)"
if [[ "$body" == *'"ok":true'* ]]; then
  pass "health check body is the app's own JSON"
else
  fail "health check returned: ${body:0:120}"
fi

printf '\n\033[1mTLS to the origin\033[0m\n'
# Full (strict) means the edge verifies the origin certificate. Asking the
# origin directly, by IP with SNI, is the only way to see what the edge sees.
for name in "$ZONE" "demo.$ZONE"; do
  if echo | openssl s_client -connect "$ORIGIN:443" -servername "$name" 2>/dev/null \
    | openssl x509 -noout -checkend 604800 >/dev/null 2>&1; then
    pass "origin certificate for $name valid for at least 7 more days"
  else
    fail "origin certificate for $name missing or expiring — Full (strict) will fail"
  fi
done

printf '\n'
if (( FAILED )); then
  printf '\033[31mnot fully behind Cloudflare yet\033[0m\n\n'
  exit 1
fi
printf '\033[32mall three names are behind Cloudflare\033[0m\n\n'
