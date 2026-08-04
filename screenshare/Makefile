# One entrypoint. CI calls these same targets, so local == CI.
SHELL := /bin/bash

-include .env
# Defaults MUST precede the export: `export FOO` marks FOO defined-but-empty,
# after which `FOO ?= 8000` no longer fires and you get an empty port.
SIGNALING_PORT ?= 8000
STATIC_PORT ?= 5173
export SIGNALING_PORT STATIC_PORT

SRV := server
WEB := widget
VENV := $(SRV)/.venv

.DEFAULT_GOAL := help
.PHONY: help setup lint test e2e build up down smoke ci clean up-native down-native act ports

# awk, not `sed 's/.../\t/'` — BSD sed (macOS) emits a literal 't' for \t.
help: ## show targets
	@awk 'BEGIN{FS=":.*## "} /^[a-z-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## install all dependencies
	uv venv $(VENV)
	VIRTUAL_ENV=$(VENV) uv pip install -e "$(SRV)[dev]"
	cd $(WEB) && npm install --no-audit --no-fund

lint: ## static checks
	$(VENV)/bin/ruff check $(SRV)
	$(VENV)/bin/ruff format --check $(SRV)
	cd $(WEB) && npm run lint

test: ## unit tests (no browser, no network)
	cd $(SRV) && .venv/bin/pytest -q
	cd $(WEB) && npm test

bundle: ## build the widget bundle (enforces the size budget)
	cd $(WEB) && npm run build

e2e: bundle ## real two-browser Playwright run against a live peer connection
	cd $(WEB) && npx playwright test

build: bundle ## build container images
	docker compose build

up: ## run the stack in Docker
	docker compose up -d --wait

down: ## stop the stack
	docker compose down -v

up-native: bundle ## run signaling + static host as processes (no Docker)
	@mkdir -p .run
	@$(VENV)/bin/uvicorn signaling.main:app --host 127.0.0.1 --port $(SIGNALING_PORT) \
	    --app-dir $(SRV)/src --log-level warning > .run/signaling.log 2>&1 & echo $$! > .run/signaling.pid
	@cd $(WEB) && PORT=$(STATIC_PORT) node serve.mjs > ../.run/static.log 2>&1 & echo $$! > .run/static.pid
	@for i in $$(seq 1 60); do \
	   curl -fsS http://127.0.0.1:$(SIGNALING_PORT)/healthz >/dev/null 2>&1 && \
	   curl -fsS http://127.0.0.1:$(STATIC_PORT)/demo/index.html >/dev/null 2>&1 && \
	   { echo "up — host http://127.0.0.1:$(STATIC_PORT)/demo/index.html?room=demo&mode=host"; exit 0; }; \
	   sleep 0.5; done; \
	 echo "failed to start; see .run/*.log"; exit 1

down-native: ## stop host processes
	@-[ -f .run/signaling.pid ] && kill $$(cat .run/signaling.pid) 2>/dev/null || true
	@-[ -f .run/static.pid ] && kill $$(cat .run/static.pid) 2>/dev/null || true
	@rm -rf .run; echo "down"

ports: ## show what is holding the ports this project wants
	@for p in $(SIGNALING_PORT) $(STATIC_PORT); do \
	   printf "port %-6s " "$$p"; \
	   holder=$$(lsof -nP -iTCP:$$p -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -1); \
	   if [ -n "$$holder" ]; then echo "$$holder"; else echo "free"; fi; \
	 done

smoke: ## black-box checks against whatever is running
	./scripts/smoke.sh

ci: lint test bundle ## what .github/workflows/ci.yml runs

act: ## run the GitHub Actions workflow locally
	@command -v act >/dev/null || { echo "act not installed — see nektosact.com"; exit 1; }
	act push

clean:
	rm -rf $(VENV) $(WEB)/node_modules $(WEB)/dist $(WEB)/test-results \
	       $(WEB)/playwright-report .run
	find . \( -name __pycache__ -o -name .ruff_cache -o -name .pytest_cache \) \
	  -type d -prune -exec rm -rf {} +
