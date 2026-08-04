#!/usr/bin/env bash
# Black-box check against the running stack. Fails loudly.
set -euo pipefail

API_BASE=${API_BASE:-http://localhost:${API_PORT:-8000}}
WEB_BASE=${WEB_BASE:-http://localhost:${WEB_PORT:-3000}}

check() { printf '  %-46s' "$1"; }
pass()  { printf '\033[32mPASS\033[0m\n'; }

check "GET $API_BASE/health"
[ "$(curl -fsS "$API_BASE/health")" = '{"status":"ok"}' ]; pass

check "POST $API_BASE/sum"
[ "$(curl -fsS -X POST "$API_BASE/sum" -H 'content-type: application/json' \
     -d '{"values":[1,2,3.5]}' | tr -d ' ')" = '{"total":6.5,"count":3}' ]; pass

check "POST $API_BASE/sum (empty -> 422)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_BASE/sum" \
     -H 'content-type: application/json' -d '{"values":[]}')" = "422" ]; pass

check "GET $WEB_BASE/ (web -> api)"
[ "$(curl -fsS "$WEB_BASE/")" = "3 value(s) sum to 6.5" ]; pass

echo "smoke: all checks passed"
