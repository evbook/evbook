#!/usr/bin/env bash
# Tells the IndexNow search engines (Bing, Yandex, Naver, Seznam, Yep) that the
# landing page changed, so they recrawl now instead of whenever they next pass.
#
#   ./deploy/vps/indexnow.sh [landing-url]
#
# Submits every <loc> in the live sitemap. The key is not a secret: IndexNow
# proves ownership by finding the same key at https://<host>/<key>.txt, which
# is the one .txt file in site/ besides robots.txt. Google does not take part
# in IndexNow — it reads the sitemap named in robots.txt, and is nudged by hand
# in Search Console.
set -euo pipefail

LANDING="${1:-https://evbook.app}"
LANDING="${LANDING%/}"
HOST="${LANDING#*://}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

KEY=""
for file in "$ROOT"/site/*.txt; do
  name="$(basename "$file" .txt)"
  if [[ "$name" != "robots" && "$(tr -d '[:space:]' < "$file")" == "$name" ]]; then
    KEY="$name"
    break
  fi
done
if [[ -z "$KEY" ]]; then
  echo "no IndexNow key file in site/ (expected site/<key>.txt containing <key>)" >&2
  exit 1
fi

# The key has to be live before the submission, or the engines reject it.
served="$(curl -fsS --max-time 20 "$LANDING/$KEY.txt" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$served" != "$KEY" ]]; then
  echo "$LANDING/$KEY.txt does not serve the key yet — deploy site/ first" >&2
  exit 1
fi

urls="$(curl -fsS --max-time 20 "$LANDING/sitemap.xml" |
  sed -n 's:.*<loc>\(.*\)</loc>.*:\1:p')"
if [[ -z "$urls" ]]; then
  echo "no <loc> entries in $LANDING/sitemap.xml" >&2
  exit 1
fi

list="$(printf '%s\n' "$urls" | sed 's/.*/"&"/' | paste -sd, -)"
body="{\"host\":\"$HOST\",\"key\":\"$KEY\",\"keyLocation\":\"$LANDING/$KEY.txt\",\"urlList\":[$list]}"

echo "IndexNow — $(printf '%s\n' "$urls" | wc -l | tr -d ' ') URL(s) from $LANDING/sitemap.xml"
status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
  -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data "$body")"

# 200 = accepted, 202 = accepted, key validation still pending.
case "$status" in
  200 | 202) echo "  ok    accepted ($status)" ;;
  *)
    echo "  FAIL  IndexNow answered $status" >&2
    exit 1
    ;;
esac
