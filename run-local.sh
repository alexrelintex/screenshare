#!/usr/bin/env bash
#
# run-local.sh — start the screen-share demo on this machine. No Docker.
#
#   ./run-local.sh          start everything and print the two URLs
#   ./run-local.sh stop     stop it
#   ./run-local.sh status   what is running
#
# Finds its own free ports, installs what is missing, and cd's to the right
# place on its own. Safe to run repeatedly.

set -uo pipefail

# Always operate from the repo root, no matter where this is invoked from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

RUN=.run
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m    %s\n' "$*"; }
die()  { printf '    \033[31mx\033[0m    %s\n' "$*" >&2; exit 1; }

# bash 3.2 (macOS default) has no /dev/tcp caveats here, but does lack `wait -n`
# and safe empty-array deref — this script avoids both.
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pick_port() {
  local p=$1
  while ! port_free "$p"; do p=$((p + 1)); done
  echo "$p"
}

stop_all() {
  local stopped=0
  for name in signaling static; do
    if [ -f "$RUN/$name.pid" ]; then
      local pid; pid=$(cat "$RUN/$name.pid")
      if kill "$pid" 2>/dev/null; then ok "stopped $name (pid $pid)"; stopped=1; fi
    fi
  done
  rm -rf "$RUN"
  [ "$stopped" = 1 ] || ok "nothing was running"
}

case "${1:-start}" in
  stop)
    say "stopping"; stop_all; exit 0 ;;
  status)
    if [ -f "$RUN/urls" ]; then say "running"; cat "$RUN/urls"
    else say "not running"; fi
    exit 0 ;;
  start) ;;
  *) die "usage: $0 [start|stop|status]" ;;
esac

# ---------------------------------------------------------------- prerequisites
say "checking prerequisites"
command -v node >/dev/null || die "node not found. Run bootstrap.sh, then open a new terminal."
command -v npm  >/dev/null || die "npm not found. Run bootstrap.sh, then open a new terminal."
if command -v uv >/dev/null; then UV=uv
elif [ -x "$HOME/.local/bin/uv" ]; then UV="$HOME/.local/bin/uv"
else die "uv not found. Run bootstrap.sh, then open a new terminal."; fi
ok "node $(node --version), $(basename "$UV") $($UV --version | awk '{print $2}')"

# Anything already running from a previous invocation must go first, or the
# port scan below will happily pick fresh ports and leave orphans behind.
[ -d "$RUN" ] && { say "clearing previous run"; stop_all; }

# ---------------------------------------------------------------------- install
if [ ! -x server/.venv/bin/uvicorn ]; then
  say "installing python deps (first run only)"
  $UV venv server/.venv >/dev/null 2>&1 || die "uv venv failed"
  VIRTUAL_ENV=server/.venv $UV pip install -q -e "server[dev]" || die "pip install failed"
fi
ok "python deps ready"

if [ ! -d widget/node_modules ]; then
  say "installing node deps (first run only)"
  (cd widget && npm install --no-audit --no-fund >/dev/null 2>&1) || die "npm install failed"
fi
ok "node deps ready"

say "building the widget bundle"
(cd widget && node build.mjs) || die "bundle build failed"

# ------------------------------------------------------------------------ ports
say "choosing ports"
SIGNALING_PORT=$(pick_port 8000)
STATIC_PORT=$(pick_port 5173)
[ "$SIGNALING_PORT" = 8000 ] || warn "8000 was taken — using $SIGNALING_PORT"
[ "$STATIC_PORT" = 5173 ]   || warn "5173 was taken — using $STATIC_PORT"
ok "signaling :$SIGNALING_PORT   static :$STATIC_PORT"

# ------------------------------------------------------------------------ start
mkdir -p "$RUN"
say "starting"

server/.venv/bin/uvicorn signaling.main:app \
  --host 127.0.0.1 --port "$SIGNALING_PORT" \
  --app-dir server/src --log-level warning > "$RUN/signaling.log" 2>&1 &
echo $! > "$RUN/signaling.pid"

(cd widget && PORT="$STATIC_PORT" node serve.mjs) > "$RUN/static.log" 2>&1 &
echo $! > "$RUN/static.pid"

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$SIGNALING_PORT/healthz" >/dev/null 2>&1 &&
     curl -fsS "http://127.0.0.1:$STATIC_PORT/demo/index.html" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:$SIGNALING_PORT/healthz" >/dev/null 2>&1; then
  warn "signaling did not come up — last lines of $RUN/signaling.log:"
  tail -5 "$RUN/signaling.log" >&2
  stop_all; exit 1
fi
if ! curl -fsS "http://127.0.0.1:$STATIC_PORT/demo/index.html" >/dev/null 2>&1; then
  warn "static server did not come up — last lines of $RUN/static.log:"
  tail -5 "$RUN/static.log" >&2
  stop_all; exit 1
fi

BASE="http://127.0.0.1:$STATIC_PORT/demo/index.html?room=demo&signaling=http://127.0.0.1:$SIGNALING_PORT"
HOST_URL="$BASE&mode=host"
VIEW_URL="$BASE&mode=viewer"
{ echo "  host   $HOST_URL"; echo "  viewer $VIEW_URL"; } > "$RUN/urls"

echo
say "running"
cat "$RUN/urls"
echo
echo "  1. Both tabs should open automatically."
echo "  2. In the HOST tab click 'Share screen' and pick a window."
echo "  3. Move your mouse over the video in the VIEWER tab —"
echo "     a blue dot tracks it on the host."
echo
echo "  stop with:  ./run-local.sh stop"
echo

if [ "$(uname -s)" = Darwin ]; then
  # First screen share will prompt for macOS Screen Recording permission.
  warn "macOS: the first share needs Screen Recording permission for your browser"
  warn "System Settings > Privacy & Security > Screen & System Audio Recording"
  open "$HOST_URL" 2>/dev/null
  sleep 1
  open "$VIEW_URL" 2>/dev/null
fi
