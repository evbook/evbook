#!/usr/bin/env bash
# Puts evbook.app, www.evbook.app and demo.evbook.app behind Cloudflare. This is
# how the project hosts its own public demo, not an install path.
#
#   ORIGIN_IP=<origin-ip> deploy/cloudflare/cutover.sh            # do it
#   ORIGIN_IP=<origin-ip> deploy/cloudflare/cutover.sh --plan     # print what it would do, change nothing
#
# Idempotent: every step checks the live state first, so re-running after a
# partial failure (or after a record was hand-edited in the dashboard) converges
# instead of duplicating anything.
#
# What "behind Cloudflare" means here: the VPS keeps serving all three names
# exactly as it does today — Caddy, its own Let's Encrypt certificates, the PM2
# demo on 127.0.0.1:3100 — and Cloudflare is put in front as a proxy. The origin
# is not moved and nothing is rebuilt.
#
# Settings, none of which is committed. Put them in ./.env (gitignored) or
# export them; deploy/cloudflare/README.md describes each:
#
#   ORIGIN_IP              The VPS's public address the proxied records point at.
#   CLOUDFLARE_API_TOKEN   User-owned token: Zone » DNS:Edit, Zone » Zone
#                          Settings:Edit, plus Account » Zone:Edit only if the
#                          zone must be created from the API. Wrangler's own
#                          OAuth token is zone:read only and cannot do this.
#   PORKBUN_API_KEY        Optional, and only if the registrar is Porkbun: lets
#   PORKBUN_SECRET_API_KEY step 5 switch the nameservers automatically. Without
#                          them the script prints the nameservers to set by hand.
set -euo pipefail

ZONE="evbook.app"
# The three names Caddy actually has site blocks for. Anything else was only
# ever answered by the previous DNS provider's wildcard — see the note on step 3.
PROXIED_NAMES=("$ZONE" "www.$ZONE" "demo.$ZONE")

PLAN=false
DROP_WILDCARD=false
for arg in "$@"; do
  case "$arg" in
    --plan)          PLAN=true ;;
    --drop-wildcard) DROP_WILDCARD=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/../../.env" ]] && set -a && . "$HERE/../../.env" && set +a

: "${CLOUDFLARE_API_TOKEN:?is empty. Set it in ./.env or the environment — see deploy/cloudflare/README.md for how to make the token.}"
: "${ORIGIN_IP:?is empty. Set it to the public IP address of the VPS, in ./.env or the environment.}"
ORIGIN="$ORIGIN_IP"

API="https://api.cloudflare.com/client/v4"
cf() { # cf <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" --data "$body" "$API$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API$path"
  fi
}

# Every Cloudflare response has the same {success, errors, result} envelope, so
# one checker covers the lot. Failing loudly here is the point: a half-applied
# DNS change is worse than a stopped script.
# Passed with -c rather than a heredoc: a heredoc becomes python's stdin, which
# would swallow the piped response the script is supposed to read.
jq_check() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except json.JSONDecodeError:
    sys.exit("non-JSON response from Cloudflare: " + raw[:300])
if not d.get("success"):
    sys.exit("Cloudflare API error (" + sys.argv[1] + "): " + json.dumps(d.get("errors"))[:500])
print(json.dumps(d.get("result")))
' "$1"
}

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
did() { printf '    %s\n' "$*"; }

# --- 1. the token ------------------------------------------------------------
# The account id is needed for exactly one thing: creating the zone. A token
# scoped to Zone » DNS and Zone » Zone Settings — which is all the rest of this
# script needs — cannot list accounts at all, so a hard requirement here would
# lock out the narrowest token that can do the job. Look it up if possible,
# carry on without it if not, and only complain at the point it is actually
# needed.
say "checking the API token"
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(cf GET "/accounts" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
r = d.get("result") or []
print(r[0]["id"] if d.get("success") and r else "")
')}"
if [[ -n "$ACCOUNT_ID" ]]; then
  did "account $ACCOUNT_ID"
else
  did "no account visible to this token — fine unless the zone must be created"
fi

# --- 2. the zone -------------------------------------------------------------
say "zone $ZONE"
ZONE_JSON="$(cf GET "/zones?name=$ZONE" | jq_check zones)"
ZONE_ID="$(printf '%s' "$ZONE_JSON" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r[0]["id"] if r else "")')"

if [[ -z "$ZONE_ID" ]]; then
  if $PLAN; then
    did "would create the zone (type: full)"
    exit 0
  fi
  if [[ -z "$ACCOUNT_ID" ]]; then
    echo "    this token cannot see an account, so it cannot create the zone." >&2
    echo "    Either add the domain at dash.cloudflare.com and re-run, or set" >&2
    echo "    CLOUDFLARE_ACCOUNT_ID in .env and use a token with Account | Zone | Edit." >&2
    exit 1
  fi
  # "full" = Cloudflare becomes authoritative for the whole zone, which is what
  # a nameserver switch means. A "partial"/CNAME setup would keep the current
  # DNS provider authoritative and is an Enterprise feature anyway.
  # Captured in two steps rather than one long pipe: when jq_check exits on an
  # API error, a following stage in the same pipeline gets empty input and dies
  # with a traceback that buries the actual message.
  created="$(cf POST "/zones" \
    "{\"name\":\"$ZONE\",\"account\":{\"id\":\"$ACCOUNT_ID\"},\"type\":\"full\"}" \
    | jq_check zone)"
  ZONE_ID="$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  did "created — $ZONE_ID"
else
  did "already exists — $ZONE_ID"
fi

ZSTATE="$(cf GET "/zones/$ZONE_ID" | jq_check zone)"
printf '%s' "$ZSTATE" | python3 -c '
import json,sys
z=json.load(sys.stdin)
print("    status:", z["status"])
print("    assigned nameservers:", ", ".join(z.get("name_servers") or []))
'

# --- 3. the records ----------------------------------------------------------
# Proxied A records, one per name Caddy serves. The previous zone also had a
# wildcard `*` A record; it is deliberately NOT recreated here. Caddy has no
# site block for any other name, and a wildcard cannot be proxied on this plan,
# so carrying it over would publish the origin IP in public DNS and undo half
# the point of the exercise. Add it back explicitly if something turns out to
# depend on it.
say "DNS records"
EXISTING="$(cf GET "/zones/$ZONE_ID/dns_records?per_page=200" | jq_check records)"

for name in "${PROXIED_NAMES[@]}"; do
  read -r rec_id rec_content rec_proxied <<<"$(printf '%s' "$EXISTING" | python3 -c '
import json,sys
name=sys.argv[1]
for r in json.load(sys.stdin):
    if r["type"]=="A" and r["name"]==name:
        print(r["id"], r["content"], str(r["proxied"]).lower()); break
else:
    print("", "", "")
' "$name")"

  body="{\"type\":\"A\",\"name\":\"$name\",\"content\":\"$ORIGIN\",\"proxied\":true,\"ttl\":1}"

  if [[ -z "$rec_id" ]]; then
    $PLAN && { did "would create  A $name -> $ORIGIN (proxied)"; continue; }
    cf POST "/zones/$ZONE_ID/dns_records" "$body" | jq_check "create $name" >/dev/null
    did "created  A $name -> $ORIGIN (proxied)"
  elif [[ "$rec_content" == "$ORIGIN" && "$rec_proxied" == "true" ]]; then
    did "correct  A $name -> $ORIGIN (proxied)"
  else
    $PLAN && { did "would fix     A $name ($rec_content, proxied=$rec_proxied)"; continue; }
    cf PATCH "/zones/$ZONE_ID/dns_records/$rec_id" "$body" | jq_check "update $name" >/dev/null
    did "fixed    A $name -> $ORIGIN (proxied)"
  fi
done

# Cloudflare's "Add site" flow scans the old nameservers and imports what it
# finds, so a zone created in the dashboard arrives carrying the old
# wildcard (proxied, which does work). It is dropped anyway: Caddy serves three
# names and holds a certificate for each, no wildcard, so every other subdomain
# fails the origin handshake and surfaces as a Cloudflare 526. NXDOMAIN is the
# more honest answer. Flagged rather than deleted silently — removing DNS
# records nobody asked you to remove is its own kind of surprise.
WILDCARD_ID="$(printf '%s' "$EXISTING" | python3 -c '
import json, sys
zone = sys.argv[1]
for r in json.load(sys.stdin):
    if r["name"] == "*." + zone and r["type"] in ("A", "AAAA", "CNAME"):
        print(r["id"]); break
else:
    print("")
' "$ZONE")"

if [[ -n "$WILDCARD_ID" ]]; then
  if $DROP_WILDCARD && ! $PLAN; then
    cf DELETE "/zones/$ZONE_ID/dns_records/$WILDCARD_ID" | jq_check "delete wildcard" >/dev/null
    did "deleted  *.$ZONE (no certificate for it at the origin — would 526)"
  elif $DROP_WILDCARD; then
    did "would delete  *.$ZONE"
  else
    did ""
    did "WARNING: *.$ZONE exists. Caddy serves three names and holds a"
    did "         certificate for each, with no wildcard — so every other"
    did "         subdomain reaches the edge, fails the origin handshake and"
    did "         surfaces as a Cloudflare 526. NXDOMAIN is the better answer."
    did "         Re-run with --drop-wildcard to remove it, or keep it"
    did "         deliberately if something you have not told this script about"
    did "         depends on it."
    did ""
  fi
fi

# --- 4. zone settings --------------------------------------------------------
# ssl=strict (Full (strict)) is safe from the first second: Caddy already holds
# valid Let's Encrypt certificates for all three names, so the edge can verify
# the origin properly. Anything less would leave the Cloudflare-to-origin hop
# unauthenticated, which is the classic way a site looks encrypted and is not.
#
# Caddy keeps renewing over HTTP-01 through the proxy — Cloudflare exempts
# /.well-known/acme-challenge/ from the Always Use HTTPS redirect, and Let's
# Encrypt follows the redirect regardless.
say "zone settings"
SETTINGS_FAILED=0
apply_setting() { # apply_setting <name> <json-value> <human>
  local id="$1" value="$2" human="$3"
  # Compared as parsed JSON, not as text: security_header's value is an object
  # and the API is free to return its keys in a different order, which would
  # make a string compare claim a change on every single run.
  local current
  current="$(cf GET "/zones/$ZONE_ID/settings/$id" | python3 -c '
import json, sys
want = json.loads(sys.argv[1])
d = json.load(sys.stdin)
if not d.get("success"):
    print("unreadable"); raise SystemExit
got = d.get("result", {}).get("value")
print("same" if got == want else json.dumps(got))
' "$value")"
  if [[ "$current" == "same" ]]; then
    did "already  $human"
  elif $PLAN; then
    did "would set $human (now: $current)"
  else
    local response
    response="$(cf PATCH "/zones/$ZONE_ID/settings/$id" "{\"value\":$value}")"
    if printf '%s' "$response" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)'; then
      did "set      $human"
    else
      # Not fatal on the spot: the remaining settings should still be attempted
      # so one run surfaces every problem. Step 5 refuses to proceed instead.
      SETTINGS_FAILED=1
      did "FAILED   $human"
      printf '%s' "$response" | python3 -c 'import json,sys; print("             ", json.dumps(json.load(sys.stdin).get("errors"))[:300])'
    fi
  fi
}

apply_setting ssl '"strict"'          'SSL/TLS mode = Full (strict)'
apply_setting always_use_https '"on"' 'Always Use HTTPS'
apply_setting min_tls_version '"1.2"' 'Minimum TLS version 1.2'
apply_setting automatic_https_rewrites '"on"' 'Automatic HTTPS Rewrites'
apply_setting security_header \
  '{"strict_transport_security":{"enabled":true,"max_age":31536000,"include_subdomains":true,"preload":false,"nosniff":false}}' \
  'HSTS at the edge (origin already sends it)'

# --- 5. the registrar --------------------------------------------------------
# This is the step that actually moves traffic. Everything above is inert until
# the nameservers change. Automating it is optional and Porkbun-specific; with
# no Porkbun credentials the script prints what to set at your registrar.
say "nameservers at the registrar"
if (( SETTINGS_FAILED )); then
  # Moving traffic onto a zone whose SSL mode did not apply is how a cutover
  # ends up serving the site over a downgraded or unverified connection.
  echo "    refusing: a zone setting above did not apply. Fix it and re-run;" >&2
  echo "    nothing has been delegated yet, so the sites are untouched." >&2
  exit 1
fi
NS="$(printf '%s' "$ZSTATE" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin).get("name_servers") or []))')"

if [[ -z "${PORKBUN_API_KEY:-}" || -z "${PORKBUN_SECRET_API_KEY:-}" ]]; then
  did "no registrar credentials set — do this by hand:"
  did ""
  did "  at your registrar, replace $ZONE's nameservers with:"
  for n in $NS; do did "    $n"; done
  did ""
  did "then re-run with --plan to confirm, and deploy/cloudflare/verify.sh to check."
  exit 0
fi

if $PLAN; then
  did "would point evbook.app at: $NS"
  exit 0
fi

NS_JSON="$(printf '%s' "$NS" | python3 -c '
import json,sys
print(json.dumps({"ns": sys.stdin.read().split()}))
')"
PB_BODY="$(python3 -c '
import json,os,sys
body=json.loads(sys.argv[1])
body["apikey"]=os.environ["PORKBUN_API_KEY"]
body["secretapikey"]=os.environ["PORKBUN_SECRET_API_KEY"]
print(json.dumps(body))
' "$NS_JSON")"

curl -sS -X POST -H "Content-Type: application/json" --data "$PB_BODY" \
  "https://api.porkbun.com/api/json/v3/domain/updateNs/$ZONE" \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("status")!="SUCCESS":
    sys.exit("Porkbun refused the nameserver change: "+json.dumps(d)[:300])
print("    nameservers updated at Porkbun")
'

did "propagation is usually minutes; Cloudflare emails when the zone goes active."
did "run deploy/cloudflare/verify.sh until it passes."
