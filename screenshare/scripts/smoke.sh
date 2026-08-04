#!/usr/bin/env bash
# Black-box checks against a running stack (Docker or native — same checks).
set -euo pipefail

SIGNALING=${SIGNALING:-http://127.0.0.1:${SIGNALING_PORT:-8000}}
STATIC=${STATIC:-http://127.0.0.1:${STATIC_PORT:-5173}}

check() { printf '  %-52s' "$1"; }
pass()  { printf '\033[32mPASS\033[0m\n'; }

check "GET $SIGNALING/healthz"
curl -fsS "$SIGNALING/healthz" | grep -q '"status":"ok"'; pass

check "GET $STATIC/demo/index.html"
curl -fsS "$STATIC/demo/index.html" | grep -q '<screen-share\|createElement("screen-share")'; pass

check "GET $STATIC/dist/screenshare.js served"
curl -fsS "$STATIC/dist/screenshare.js" | grep -q 'screen-share'; pass

check "bundle is under the 25 KB budget"
size=$(curl -fsS "$STATIC/dist/screenshare.js" | wc -c)
[ "$size" -lt 25600 ] || { echo "FAIL ($size bytes)"; exit 1; }; pass

check "static server refuses path traversal"
code=$(curl -s -o /dev/null -w '%{http_code}' "$STATIC/../../../etc/passwd")
[ "$code" = "403" ] || [ "$code" = "404" ] || { echo "FAIL (got $code)"; exit 1; }; pass

check "WebSocket upgrade accepted on /ws/{room}"
WS_HOST=${SIGNALING#http://}; WS_HOST=${WS_HOST#https://}
out=$(curl -si --max-time 5 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "$SIGNALING/ws/smoke" 2>/dev/null | head -1 || true)
grep -q "101" <<<"$out" || { echo "FAIL ($out)"; exit 1; }; pass

echo "smoke: all checks passed"
