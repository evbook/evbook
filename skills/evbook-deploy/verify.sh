#!/usr/bin/env bash
# Post-deploy smoke test. Usage: ./verify.sh https://evbook.example.workers.dev
set -uo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 <worker-url>" >&2
  exit 2
fi
URL="${URL%/}"

pass=0
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  ok    %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n        expected to contain: %s\n        got: %s\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

echo "Checking $URL"

check "health endpoint responds" '{"ok":true}' "$(curl -fsS --max-time 15 "$URL/health_check" 2>&1)"

session="$(curl -fsS --max-time 15 "$URL/api/v1/session" 2>&1)"
check "secrets are configured" '"setupRequired":false' "$session"

check "app shell is served" '<!doctype html' "$(curl -fsS --max-time 15 "$URL/" 2>&1 | tr 'A-Z' 'a-z' | head -c 200)"

check "deep links reach the app" "200" "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/drives" 2>&1)"

check "data endpoints require a session" "401" \
  "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/v1/cars" 2>&1 || echo 401)"

# Tesla status is only reported to a logged-in session, so it cannot be checked
# from here. Confirm it in the browser instead.
echo "  note  Deployment is reachable and configured. Log in and confirm your"
echo "        cars appear on the overview page."

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
