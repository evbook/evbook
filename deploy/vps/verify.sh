#!/usr/bin/env bash
# Smoke-tests the public demo and landing page over HTTPS, from outside.
#
#   ./deploy/vps/verify.sh [landing-url] [demo-url]
set -uo pipefail

LANDING="${1:-https://evbook.app}"
DEMO="${2:-https://demo.evbook.app}"
LANDING="${LANDING%/}"
DEMO="${DEMO%/}"

pass=0
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  ok    %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n        expected to contain: %s\n        got: %s\n' \
      "$label" "$expected" "${actual:0:200}"
    fail=$((fail + 1))
  fi
}

echo "Landing — $LANDING"
check "serves the page over TLS" "EVBook" \
  "$(curl -fsS --max-time 20 "$LANDING/" 2>&1 | head -c 4000)"
check "links to the demo" "demo.evbook.app" \
  "$(curl -fsS --max-time 20 "$LANDING/" 2>&1 | head -c 40000)"
check "http redirects to https" "https://evbook.app/" \
  "$(curl -fsS -o /dev/null -w '%{url_effective}' -L --max-time 20 "http://evbook.app/" 2>&1)"
check "www redirects to the apex" "https://evbook.app/" \
  "$(curl -fsS -o /dev/null -w '%{url_effective}' -L --max-time 20 "https://www.evbook.app/" 2>&1)"
check "robots allows indexing" "Allow: /" \
  "$(curl -fsS --max-time 20 "$LANDING/robots.txt" 2>&1)"

echo
echo "Demo — $DEMO"
check "health endpoint responds" '{"ok":true}' \
  "$(curl -fsS --max-time 20 "$DEMO/health_check" 2>&1)"

session="$(curl -fsS --max-time 20 "$DEMO/api/v1/session" 2>&1)"
check "runs in demo mode" '"demo":true' "$session"
check "needs no setup" '"setupRequired":false' "$session"

check "app shell is served" "<!doctype html" \
  "$(curl -fsS --max-time 20 "$DEMO/" 2>&1 | tr 'A-Z' 'a-z' | head -c 400)"
check "deep links reach the app" "200" \
  "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 "$DEMO/drives" 2>&1)"

cars="$(curl -fsS --max-time 20 "$DEMO/api/v1/cars" 2>&1)"
check "fixture cars are readable without a login" '"id":' "$cars"

# The whole point of demo mode: reads work, anything that would touch a real
# car does not.
# Plain `curl -s`, not `-f`: the refusal is a 403 and the body is the point.
check "car commands are refused" "demo_mode" \
  "$(curl -s -X POST --max-time 20 "$DEMO/api/v1/cars/1/wake" 2>&1)"

check "the demo is not indexed" "noindex" \
  "$(curl -fsS -o /dev/null -D - --max-time 20 "$DEMO/" 2>&1 | tr 'A-Z' 'a-z')"

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
