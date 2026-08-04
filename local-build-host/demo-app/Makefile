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
