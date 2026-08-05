# CLAUDE.md

Guidance for working in this repo. Read `README.md` for what the widget *is*; this file covers
how to build, test, and not break it.

## Layout

| Path | What |
|---|---|
| `server/` | FastAPI WebSocket signaling relay (`src/signaling/`). Python, `uv`-managed. |
| `widget/` | The `<screen-share>` custom element (`src/`), demo page, unit + e2e tests. TypeScript, esbuild. |
| `scripts/smoke.sh` | Black-box checks against a running stack. |
| `run-local.sh` | One-command local demo: installs, builds, picks ports, opens two tabs. |

Media is peer-to-peer. The server relays signaling only and never sees a frame — keep it that way.

## Make targets, and the gate

`make` is the executable definition of the build. CI calls the same targets, so local and CI are
identical rather than merely similar.

| Target | Does |
|---|---|
| `setup` | Install from the **lockfiles** — `uv sync --extra dev`, `npm ci`. |
| `lint` | `ruff check`, `ruff format --check`, `tsc --noEmit`. |
| `test` | `pytest` + `vitest`. No browser, no network. |
| `bundle` | Build `widget/dist/` and enforce the size budget. |
| `e2e` | Real two-browser Playwright run against a live peer connection. |
| `up` / `down` / `build` | The Docker stack. |
| `up-native` / `down-native` | Same stack as bare processes, no Docker. |
| `smoke` | Black-box checks against whatever is already running. |
| `ports` | Show what currently holds the ports this project wants. |
| `ci` | **`lint test bundle` — the gate.** |
| `clean` | Remove venv, `node_modules`, `dist`, caches, `.run`. |

**`make ci` is the gate.** Nothing is "done" until it passes. Run it before every commit; run
`make clean && make setup && make ci` when you have touched dependency wiring, so you prove the
install path from scratch and not just an already-warm tree.

`uv.lock` and `package-lock.json` are committed and are the source of truth for installs. Never
swap `uv sync` back to `uv pip install` or `npm ci` back to `npm install` — that reintroduces
resolution and lets local drift from CI. If an install rewrites a lockfile, that is a real change:
commit it deliberately, don't discard it.

## Ports

Host ports come from `.env`, which is git-ignored; `.env.example` is the committed template.
Both `docker compose` and the `Makefile` read it. Defaults are `SIGNALING_PORT=8000` and
`STATIC_PORT=5173`.

When something else already owns a port, `make ports` names the holder. Copy `.env.example` to
`.env` and change the number rather than editing the `Makefile` or `docker-compose.yml`.

In the `Makefile`, defaults **must** precede `export`. `export FOO` marks `FOO` as
defined-but-empty, after which `FOO ?= 8000` no longer fires and you get an empty port.

`run-local.sh` is the exception: it scans for free ports itself starting at the defaults and
warns when it has to move.

## GitHub Actions must be pinned to full release tags

Every `uses:` in `.github/workflows/` is pinned to a complete release tag — `astral-sh/setup-uv@v9.0.0`,
`actions/checkout@v7.0.1` — never a bare major.

The reason is concrete: `astral-sh/setup-uv` publishes floating aliases only up to `v7`. There is
no `v8` or `v9` tag, so `@v9` does not resolve and the job dies during setup before any step runs.
That is what broke run `31039941373`, and the fix was commit `1203f63`.

Before writing any `uses:` reference, confirm the ref actually exists:

```sh
git ls-remote --tags https://github.com/astral-sh/setup-uv | grep -E 'refs/tags/v9'
```

Bumping an action means finding its current release tag and pinning to that exact tag. Don't
assume a floating major exists just because the publisher used to ship one.

Both `setup-uv` steps also carry `enable-cache: true` and `cache-dependency-glob: server/uv.lock`.
Keep the two jobs' steps in sync — they are duplicated by design, so a change to one usually
belongs in the other.

## This is a macOS dev machine: bash 3.2 and BSD userland

CI runs Ubuntu, but authoring happens on macOS. Scripts must work on both, and the macOS half is
the older, stricter one — `/bin/bash` is **3.2**, and `sed`/`mktemp`/`date` are BSD, not GNU.

**No empty-array dereference under `set -u`.** In bash 3.2, `"${arr[@]}"` on an empty array is an
unbound-variable error, not an empty expansion. Bash 4.4+ fixed this, so the bug is invisible on
Linux. Guard with `${#arr[@]}` first, or avoid arrays. Bash 3.2 also has no `wait -n`, no
associative arrays, and no `${var,,}` case conversion — `run-local.sh` deliberately avoids all of
these and says so in comments.

**No `\t` in `sed` replacements in the `Makefile`.** BSD `sed` emits a literal `t` for `\t`, so
`sed 's/.../\t/'` silently produces the wrong output on macOS and the right one in CI. The `help`
target uses `awk` with `printf` instead — follow that pattern.

**Give `mktemp` an explicit template.** Bare `mktemp` does run on both, but it lands in `$TMPDIR`,
which is `/tmp` on Linux and a long per-user `/var/folders/...` path on macOS — a difference that
bites anything assuming a short or shared path. `-t` is worse: BSD reads the argument as a prefix
and appends its own `X`s, while GNU wants the `X`s already in the template and errors without
them. Write the template out: `mktemp "${TMPDIR:-/tmp}/ss.XXXXXX"`.

The same caution applies to other GNU-only reflexes — `sed -i` without a backup suffix, `date -d`,
`readlink -f`, `grep -P`. Reach for `awk`, or a small node/python helper, before a GNU-specific flag.

## What the E2E suite does and does not cover

`widget/e2e/share.spec.ts` drives two real Chromium pages through one signaling server and a live
peer connection. Real in that run: the custom element upgrading, WebSocket signaling, SDP
offer/answer, ICE, a MediaStream actually crossing the peer connection with frames decoding, and
cursor messages travelling the data channel back the other way. The tests assert frames *grow*,
not merely that a track exists.

**`getDisplayMedia` itself is never exercised.** A headless browser has no desktop to capture, so
with `?fakeCapture=1` the demo page assigns a canvas-backed 640×360 `MediaStream` to the element's
`captureSource` seam (`widget/src/element.ts`). The element falls back to
`navigator.mediaDevices.getDisplayMedia` only when `captureSource` is undefined, which is the path
every real user takes and the one no automated test touches.

Consequences to keep in mind:

- Anything that can only break inside real desktop capture — the picker, per-OS permission
  prompts, `getDisplayMedia` constraints, the browser's own "Stop sharing" bar, display surface
  quirks — is covered by **manual testing only**. Run `./run-local.sh` and share a real window.
  On macOS the first share needs Screen Recording permission for the browser
  (System Settings → Privacy & Security → Screen & System Audio Recording).
- Keep `captureSource` a narrow seam: one optional function returning a `MediaStream`. Don't grow
  it into a general test-mode branch, and don't let production behavior depend on it.
- If you change `startShare`, check both paths — the seam and the real `getDisplayMedia` fallback
  live in the same function, and only one of them has a test.
