#!/usr/bin/env bash
# scaffold-lab.sh — create a self-contained local integration lab.
#
# Creates:
#   $LAB_ROOT/git-remotes/demo.git   a BARE repo that acts as your local "GitHub"
#   $LAB_ROOT/demo-app/              a two-service repo you can build, test, run
#
# Idempotent: re-running wipes and recreates demo-app, leaves the bare remote alone.
set -euo pipefail

LAB_ROOT="${LAB_ROOT:-$HOME/lab}"
APP="$LAB_ROOT/demo-app"
REMOTES="$LAB_ROOT/git-remotes"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

say "lab root: $LAB_ROOT"
mkdir -p "$REMOTES"
rm -rf "$APP"
mkdir -p "$APP"/{services/api/src/api,services/api/tests,services/web/src,.github/workflows,scripts}

# ---------------------------------------------------------------- bare remote
if [ ! -d "$REMOTES/demo.git" ]; then
  say "creating bare remote $REMOTES/demo.git"
  git init --bare --initial-branch=main "$REMOTES/demo.git" >/dev/null
fi

# ------------------------------------------------------------- python service
cat > "$APP/services/api/pyproject.toml" <<'EOF'
[project]
name = "api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["fastapi>=0.115", "uvicorn[standard]>=0.32"]

[project.optional-dependencies]
dev = ["pytest>=8", "httpx>=0.27", "ruff>=0.7"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/api"]

[tool.ruff]
line-length = 100
src = ["src", "tests"]

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
EOF

cat > "$APP/services/api/src/api/__init__.py" <<'EOF'
__all__ = ["main"]
EOF

cat > "$APP/services/api/src/api/main.py" <<'EOF'
"""Minimal API. Deliberately boring: the point is the build/test loop around it."""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="demo-api", version="0.1.0")


class SumRequest(BaseModel):
    values: list[float]


class SumResponse(BaseModel):
    total: float
    count: int


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sum", response_model=SumResponse)
def sum_values(req: SumRequest) -> SumResponse:
    if not req.values:
        raise HTTPException(status_code=422, detail="values must not be empty")
    return SumResponse(total=float(sum(req.values)), count=len(req.values))
EOF

cat > "$APP/services/api/tests/test_main.py" <<'EOF'
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_sum_ok():
    r = client.post("/sum", json={"values": [1, 2, 3.5]})
    assert r.status_code == 200
    assert r.json() == {"total": 6.5, "count": 3}


def test_sum_rejects_empty():
    r = client.post("/sum", json={"values": []})
    assert r.status_code == 422
EOF

cat > "$APP/services/api/Dockerfile" <<'EOF'
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# Dependency layer first so code edits don't invalidate the pip cache.
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
EOF

# --------------------------------------------------------- typescript service
cat > "$APP/services/web/package.json" <<'EOF'
{
  "name": "web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc --noEmit",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
EOF

cat > "$APP/services/web/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "node"]
  },
  "include": ["src"]
}
EOF

cat > "$APP/services/web/src/format.ts" <<'EOF'
export function formatTotal(total: number, count: number): string {
  if (!Number.isFinite(total)) throw new TypeError("total must be finite");
  return `${count} value(s) sum to ${total}`;
}
EOF

cat > "$APP/services/web/src/format.test.ts" <<'EOF'
import { describe, expect, it } from "vitest";
import { formatTotal } from "./format.js";

describe("formatTotal", () => {
  it("formats", () => {
    expect(formatTotal(6.5, 3)).toBe("3 value(s) sum to 6.5");
  });
  it("rejects NaN", () => {
    expect(() => formatTotal(NaN, 1)).toThrow(TypeError);
  });
});
EOF

cat > "$APP/services/web/src/index.ts" <<'EOF'
import { createServer } from "node:http";
import { formatTotal } from "./format.js";

// API_URL is injected by docker compose; falls back to localhost for bare-metal runs.
const API_URL = process.env.API_URL ?? "http://localhost:8000";
const PORT = Number(process.env.PORT ?? 3000);

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  try {
    const upstream = await fetch(`${API_URL}/sum`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [1, 2, 3.5] }),
    });
    const data = (await upstream.json()) as { total: number; count: number };
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(formatTotal(data.total, data.count) + "\n");
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream failed: ${(err as Error).message}\n`);
  }
});

server.listen(PORT, () => console.log(`web listening on ${PORT}, api at ${API_URL}`));
EOF

cat > "$APP/services/web/Dockerfile" <<'EOF'
FROM node:22-slim
WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
EOF

# --------------------------------------------------------------- orchestration
cat > "$APP/docker-compose.yml" <<'EOF'
services:
  api:
    # Host port is overridable; the CONTAINER port never changes, so nothing
    # inside the compose network has to care. Set API_PORT in .env to dodge a
    # collision with whatever else is already listening on your machine.
    build: ./services/api
    ports: ["${API_PORT:-8000}:8000"]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')"]
      interval: 5s
      timeout: 3s
      retries: 10

  web:
    build: ./services/web
    environment:
      API_URL: http://api:8000
    ports: ["${WEB_PORT:-3000}:3000"]
    depends_on:
      api:
        condition: service_healthy
EOF

cat > "$APP/Makefile" <<'EOF'
# One entrypoint. Everything below is what CI runs, so local == CI.
SHELL := /bin/bash

# docker compose reads .env automatically; make does not. Without this, `make
# smoke` would probe :3000 while compose published :3100. `-` = ok if absent.
-include .env

# Defaults MUST precede the export: `export FOO` marks FOO defined-but-empty,
# after which `FOO ?= 8000` no longer fires and you get an empty port.
API_PORT ?= 8000
WEB_PORT ?= 3000

# Export ONLY the ports. A blanket `export` would also push API/WEB (which are
# directory paths here) into child scripts that use those names for URLs.
export API_PORT WEB_PORT
API := services/api
WEB := services/web
VENV := $(API)/.venv
PY := $(VENV)/bin/python

.DEFAULT_GOAL := help
.PHONY: help setup lint test build up down smoke ci clean up-native down-native ports act

# awk, not `sed 's/.../\t/'` — BSD sed (macOS) emits a literal 't' for \t in the
# replacement, so the GNU-idiomatic one-liner mangles this output on a Mac.
help: ## show targets
	@awk 'BEGIN{FS=":.*## "} /^[a-z-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## create venv + install both services' deps
	uv venv $(VENV)
	VIRTUAL_ENV=$(VENV) uv pip install -e "$(API)[dev]"
	cd $(WEB) && npm install --no-audit --no-fund

lint: ## static checks
	$(VENV)/bin/ruff check $(API)
	$(VENV)/bin/ruff format --check $(API)
	cd $(WEB) && npm run lint

test: ## unit tests
	cd $(API) && .venv/bin/pytest -q
	cd $(WEB) && npm test

build: ## build container images
	docker compose build

up: ## run the stack in the background
	docker compose up -d --wait

down: ## stop the stack
	docker compose down -v

up-native: ## run both services as host processes (no Docker needed)
	@mkdir -p .run
	@$(VENV)/bin/uvicorn api.main:app --host 127.0.0.1 --port $(API_PORT) \
	    --app-dir $(API)/src > .run/api.log 2>&1 & echo $$! > .run/api.pid
	@cd $(WEB) && API_URL=http://127.0.0.1:$(API_PORT) PORT=$(WEB_PORT) \
	    npx tsx src/index.ts > ../../.run/web.log 2>&1 & echo $$! > .run/web.pid
	@for i in $$(seq 1 60); do \
	   curl -fsS http://127.0.0.1:$(API_PORT)/health >/dev/null 2>&1 && \
	   curl -fsS http://127.0.0.1:$(WEB_PORT)/health >/dev/null 2>&1 && \
	   { echo "stack up (api :$(API_PORT), web :$(WEB_PORT))"; exit 0; }; sleep 0.5; done; \
	 echo "stack failed to come up; see .run/*.log"; exit 1

down-native: ## stop host processes
	@-[ -f .run/api.pid ] && kill $$(cat .run/api.pid) 2>/dev/null || true
	@-[ -f .run/web.pid ] && kill $$(cat .run/web.pid) 2>/dev/null || true
	@rm -rf .run; echo "stack down"

ports: ## show what is holding the ports this project wants
	@for p in $(API_PORT) $(WEB_PORT); do \
	   printf "port %-6s " "$$p"; \
	   holder=$$(lsof -nP -iTCP:$$p -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1); \
	   if [ -n "$$holder" ]; then echo "$$holder"; else echo "free"; fi; \
	 done

smoke: ## hit the running stack
	./scripts/smoke.sh

ci: lint test build ## exactly what .github/workflows/ci.yml runs

act: ## run the real GitHub Actions workflow locally (Docker required)
	@command -v act >/dev/null || { echo "act not installed — see nektosact.com"; exit 1; }
	act push

clean:
	rm -rf $(VENV) $(WEB)/node_modules .run
	find . \( -name __pycache__ -o -name .ruff_cache -o -name .pytest_cache \) \
	  -type d -prune -exec rm -rf {} +
EOF

cat > "$APP/scripts/smoke.sh" <<'EOF'
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
EOF
chmod +x "$APP/scripts/smoke.sh"

# ------------------------------------------------------------------ repo meta
cat > "$APP/.gitignore" <<'EOF'
.venv/
node_modules/
.run/
__pycache__/
*.py[cod]
.pytest_cache/
.ruff_cache/
dist/
.env
.env.*
!.env.example

# NOTE: lockfiles are deliberately NOT ignored. package-lock.json / uv.lock pin
# exact transitive versions and are what make a build reproducible. Commit them.
EOF

cat > "$APP/.env.example" <<'EOF'
# Copy to .env and edit. .env is gitignored on purpose.
# Both docker compose AND the Makefile read this file.

# HOST ports. Change these if something else already owns the default —
# check with:  lsof -nP -iTCP:3000 -sTCP:LISTEN   (macOS/Linux)
API_PORT=8000
WEB_PORT=3000
EOF

cat > "$APP/.pre-commit-config.yaml" <<'EOF'
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-added-large-files
      - id: detect-private-key
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.8.4
    hooks:
      - id: ruff
        args: [--fix]
      - id: ruff-format
EOF

cat > "$APP/.actrc" <<'EOF'
# Read automatically by `act` from the repo root — commit it.
#
# GitHub-hosted runners are amd64. On Apple Silicon act defaults to arm64, and
# many actions ship amd64-only binaries, so pin the platform to match real CI.
# Cost: the runner executes under emulation and is noticeably slower. Delete
# this line if you only care about speed and your actions are arch-agnostic.
--container-architecture=linux/amd64
EOF

cat > "$APP/.github/workflows/ci.yml" <<'EOF'
name: ci
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: make setup
      - run: make lint
      - run: make test
      - run: make build
EOF

cat > "$APP/README.md" <<'EOF'
# demo-app

Two services, one build loop.

    make setup   # deps
    make ci      # lint + test + image build  (identical to GitHub Actions)
    make up      # run the stack in Docker
    make smoke   # black-box check against the running stack
    make down

No Docker? Same loop without it:

    make up-native && make smoke && make down-native

`services/api`  FastAPI (Python)  -> :8000
`services/web`  Node/TypeScript   -> :3000, calls api over the compose network

## After your first `make setup`

`npm install` writes `services/web/package-lock.json`. Commit it — lockfiles pin
exact transitive versions and are the difference between a reproducible build and
a build that works today:

    git add services/web/package-lock.json && git commit -m "chore: lock npm deps"
EOF

say "scaffold complete: $APP"
