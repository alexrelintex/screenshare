# Local Build Host Runbook

A step-by-step process for standing up a local machine that can hold a git repo, install
dependencies, run tests, build containers, and run a CI pipeline — so that code produced by
Claude (or anyone) can be assembled and proven to work before it goes anywhere else.

Everything in Phases 2–6 was executed and verified end to end while writing this document.
Where a step could not be verified in that sandbox, it says so explicitly.

---

## 0. The mental model

A "local host" is three separable layers. Conflating them is the usual source of pain.

| Layer | What it is | What it gives you |
|---|---|---|
| **Host OS** | Ubuntu / macOS / WSL2 / a VM | A stable filesystem and shell |
| **Toolchain** | git, uv, node, docker, make | Ability to build and test |
| **Isolation** | venv, node_modules, containers | Reproducibility — *this* build doesn't depend on *your* machine's state |

The goal of the whole exercise is one command that answers "does this work?" with a yes or a no.
In this setup that command is `make ci`. Everything else exists to make that command meaningful.

### Why a `Makefile` and not a README full of steps

The single most useful artifact is a **committed, executable definition of the build**. `make`
is the lowest-common-denominator choice: it is preinstalled almost everywhere, it is
language-agnostic, and CI can call the exact same targets you call locally. That last property
is what eliminates "works on my machine" — local and CI are not *similar*, they are *identical*,
because both run `make lint`, `make test`, `make build`.

Alternatives (`just`, `task`, `npm scripts`, `nox`) are fine; the property that matters is that
the build is one committed command, not prose.

---

## 1. Phase 0 — Choose the host

Pick one. In rough order of least-friction-to-most-control:

**A. Native Linux (Ubuntu 24.04 LTS or Debian 12).** Simplest. No translation layer, Docker runs
natively, filesystem performance is native. Best default if you have the choice.

**B. Windows 11 + WSL2.** Do all work *inside* the Linux filesystem (`~/lab`), **not** on
`/mnt/c/...`. Cross-filesystem I/O in WSL2 goes over a 9P/virtio-fs bridge and is roughly an
order of magnitude slower — `npm install` on `/mnt/c` is the classic symptom. Enable Docker
Desktop's WSL integration rather than installing Docker Engine twice.
See <https://learn.microsoft.com/windows/wsl/filesystems> and
<https://docs.docker.com/desktop/features/wsl/>.

**C. macOS (Apple Silicon).** Homebrew for the toolchain. Note the architecture trap: your host
is `arm64`, most production Linux hosts are `amd64`. Images built locally will be arm64 unless
you pass `--platform linux/amd64` (which runs under emulation and is slow). Decide early which
one your images target. See <https://docs.docker.com/build/building/multi-platform/>.

**D. A dedicated VM or mini-server** (Proxmox, Hyper-V, a spare box). Right answer when you want
the lab always-on and snapshottable — take a snapshot before each experiment and roll back
instead of cleaning up. Costs you an SSH hop.

**Disk and RAM.** Budget 20 GB for images and dependency caches, 8 GB RAM minimum if you will
run a multi-service compose stack.

---

## 2. Phase 1 — Install the toolchain

Run the provided script. It is idempotent, so re-running it is a no-op for anything already
present, and `--dry-run` prints every command without executing it.

```bash
chmod +x bootstrap.sh
./bootstrap.sh --dry-run      # read what it will do first
./bootstrap.sh
exec $SHELL -l                # pick up PATH and nvm changes
```

Flags: `--no-docker` (skip the container runtime), `--no-ci` (skip act/gh/pre-commit).

### Failure policy

The script separates **essential** from **optional**. Essential is `git make curl uv node npm` —
without these the build loop cannot run, and their absence exits non-zero. Everything else
(`jq shellcheck pre-commit gh act docker`) degrades to a warning.

This is not cosmetic. `apt-get update` exits non-zero if *any* configured source fails, even
when every source you actually need succeeded — so one proxied third-party repo will abort a
naive `set -e` bootstrap before it installs anything. The script catches that, prints which
sources were unreachable, and continues. At the end it prints a **degraded steps** list, so a
partial success is visible rather than silent:

```
==> degraded steps (3)
    - apt sources unreachable
    - nvm install 22
    - container registry unreachable
```

A degraded run still exits 0 if the essentials are present. Read the list and decide whether the
missing pieces matter for what you are doing.

### macOS specifics

Open a terminal with `⌘Space` → `terminal` → `Return`, or Applications → Utilities → Terminal.
Your login shell is **zsh** (the default since macOS 10.15 Catalina), so the script appends its
PATH/nvm block to `~/.zshrc` rather than `~/.bashrc`.

Two macOS traps the script now handles, both of which bite any shell script written on Linux:

- **macOS ships bash 3.2** (2007). Apple froze it at the last GPLv2 release and will not ship
  bash 4+. In bash < 4.4, dereferencing an *empty* array under `set -u` aborts with
  `unbound variable` — so the idiomatic `arr=()` … `${#arr[@]}` pattern fails on a clean run
  with nothing to report, which is the *success* case. The script tracks degraded steps in a
  newline-delimited string instead. Note `#!/usr/bin/env bash` picks up `/bin/bash` 3.2 unless
  you have Homebrew's bash earlier in PATH — so "it works in my bash" proves nothing here.
- **macOS has no `timeout`.** It is GNU coreutils, installed by Homebrew as `gtimeout`. The
  script probes for both and runs without a timeout if neither exists.

Same class of problem: BSD `sed -i`, `readlink -f`, `grep -P`, `date -d`, and bare `mktemp`
(BSD needs an explicit `XXXXXX` template) all differ from GNU. Worth knowing before you write
your own helper scripts on this host.

**BSD `sed` does not expand `\t` in the replacement.** `sed 's/:.*##/\t/'` — the standard
self-documenting-Makefile idiom, copied into thousands of repos — emits a literal `t` on macOS,
so `make help` prints `setupt create venv`. The `help` target uses `awk` instead, which behaves
identically on both platforms.

**Apple ships GNU Make 3.81** (2006), frozen at GPLv2 for the same licensing reason as bash.
The Makefile is written to stay inside 3.81: the newest feature it uses is `.DEFAULT_GOAL`,
which landed in exactly 3.81. Avoid `.ONESHELL` (3.82+), `!=` shell assignment and `$(file …)`
(4.0+), and grouped targets `&:` (4.3+) if you extend it. `brew install make` gives you 4.x as
`gmake` if you ever need it.

### What it installs and why each one

| Tool | Role | Why this one | Reference |
|---|---|---|---|
| `git` | version control | — | <https://git-scm.com/doc> |
| `build-essential` | C compiler + headers | many pip/npm packages compile native extensions; without this you get opaque `gcc: not found` failures deep in an install log | — |
| `uv` | Python versions, venvs, installs | single static binary; replaces pyenv + pip + virtualenv + pip-tools, and resolves ~10–100× faster than pip | <https://docs.astral.sh/uv/> |
| `nvm` + Node 22 LTS | JS runtime, per-user | avoids `sudo npm -g`; lets different repos pin different Node versions | <https://github.com/nvm-sh/nvm> |
| Docker Engine + Compose v2 | isolation and orchestration | installed from Docker's own apt repo, not distro packages, which lag badly | <https://docs.docker.com/engine/install/ubuntu/> |
| `pre-commit` | lint on staged files at commit time | catches formatting/lint before it reaches history | <https://pre-commit.com> |
| `act` | run GitHub Actions workflows locally in Docker | test CI changes without a push-and-pray loop | <https://nektosact.com/> |
| `gh` | GitHub CLI | scripted PR/repo operations | <https://cli.github.com/manual/> |
| `shellcheck` | shell static analysis | shell is where silent bugs live (see §7) | <https://www.shellcheck.net/> |

### Verify before continuing

```bash
git --version && uv --version && node --version && make --version
docker run --rm hello-world     # must print "Hello from Docker!"
```

If `docker run` fails with a permission error on Linux, your user is not yet in the `docker`
group in this shell. `newgrp docker`, or log out and back in.

---

## 3. Phase 2 — Git, and a local remote that behaves like GitHub

Two habits do most of the work:

**Global config, set once.**

```bash
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
git config --global init.defaultBranch main
git config --global pull.rebase true          # linear history, no accidental merge commits
git config --global core.autocrlf input       # Linux/macOS; use 'true' on native Windows
```

**A bare repo as your local origin.** A *bare* repository has no working tree, which is exactly
what a server-side repo is. Pushing to one exercises the real `push` / `fetch` / branch-tracking
machinery with zero network and zero account.

```bash
git init --bare --initial-branch=main ~/lab/git-remotes/demo.git

cd ~/lab/demo-app
git init -b main
git add -A && git commit -m "chore: initial scaffold"
git remote add origin ~/lab/git-remotes/demo.git
git push -u origin main
```

This is genuinely useful, not a toy: you can clone from it into a second directory to simulate a
second developer, practise conflict resolution, and test `git bisect` and force-push recovery
without any risk to a real remote. When you later point `origin` at GitHub, nothing about your
workflow changes.

> Verified: bare remote created, initial commit pushed, feature branch merged with `--no-ff`, and
> the merge pushed. `git ls-remote --heads origin` confirmed the ref landed.

**Branch protection you can enforce locally** — a pre-push hook that refuses to push a red build:

```bash
cat > .git/hooks/pre-push <<'EOF'
#!/usr/bin/env bash
set -e
echo "pre-push: running make ci"
make ci
EOF
chmod +x .git/hooks/pre-push
```

Note that `.git/hooks/` is **not** committed — that is what `pre-commit` (Phase 6) is for, since
its config file *is* committed and therefore shared.

---

## 4. Phase 3 — Repo layout: the contract that makes generated code assemblable

This is the part that actually answers "how do I bring Claude's code together into a working
model." The answer is that **the repository, not the conversation, defines the shape of the
code.** You establish the skeleton first; generated code then has exactly one correct place to go.

Run `scaffold-lab.sh` to materialise the reference layout:

```
~/lab/
├── git-remotes/demo.git          # your local origin (bare)
└── demo-app/
    ├── Makefile                  # THE build contract: setup, lint, test, build, up, smoke, ci
    ├── docker-compose.yml        # how the services wire together
    ├── .pre-commit-config.yaml   # committed hooks — shared, unlike .git/hooks
    ├── .github/workflows/ci.yml  # calls the same make targets
    ├── .gitignore                # .venv, node_modules, .env, .run
    ├── .env.example              # committed; .env itself is ignored
    ├── scripts/smoke.sh          # black-box checks against a RUNNING stack
    └── services/
        ├── api/                  # Python, FastAPI      -> :8000
        │   ├── pyproject.toml    # deps + ruff + pytest config, one file
        │   ├── src/api/main.py
        │   ├── tests/test_main.py
        │   └── Dockerfile
        └── web/                  # TypeScript, Node     -> :3000, calls api
            ├── package.json
            ├── tsconfig.json
            ├── src/format.ts  src/format.test.ts  src/index.ts
            └── Dockerfile
```

Five properties make this layout work, and they matter more than the specific technologies:

1. **`src/` layout for Python, not a flat package.** Tests import the *installed* package, so a
   missing `__init__.py` or a broken packaging config fails in tests instead of shipping. See
   <https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/>.
2. **One config file per service** (`pyproject.toml`, `package.json`) holding deps *and* tool
   config. Fewer files to keep in sync, and it is the file you hand to Claude as context.
3. **Tests live next to the code they test**, so a generated module and its generated test arrive
   as a pair.
4. **`.env.example` committed, `.env` ignored.** The example documents required variables; the
   real file never enters history. Secrets in git are effectively permanent.
5. **Lockfiles are committed, not ignored.** `package-lock.json` and `uv.lock` pin exact
   transitive versions. `.gitignore` excludes `node_modules/` and `.venv/` — the *installed
   trees* — but never the lockfiles. After your first `make setup`, commit
   `services/web/package-lock.json`. Without it, "reproducible" means "reproducible until an
   indirect dependency ships a patch release."
6. **Unit tests and smoke tests are separate.** `make test` needs nothing running. `make smoke`
   requires the stack up and talks to it over HTTP. They fail for different reasons, which is the
   whole point: a passing `make test` with a failing `make smoke` localises the bug to wiring
   (ports, env vars, service discovery) rather than logic.

### Run it

```bash
cd ~/lab/demo-app
make setup    # uv venv + editable install; npm install
make ci       # lint + test + image build
```

> Verified in this session: `make setup` (63 Python packages + 50 npm packages), `make lint`
> (ruff check, ruff format --check, tsc --noEmit) all clean, `make test` → 4 pytest passed,
> 2 vitest passed.

---

## 5. Phase 4 — The intake workflow for Claude-provided code

The loop below is the core process. It is deliberately mechanical: never paste generated code
onto `main`, and never trust it until `make ci` says so.

```bash
# 1. Branch. Cheap, and makes "throw it away" a one-liner.
git switch -c feat/mean-endpoint

# 2. Apply the generated files at the paths the repo dictates.
#    (Write them to disk; do not retype them.)

# 3. Gate. This is the only opinion that counts.
make lint && make test

# 4a. Green -> commit and merge.
git add -A && git commit -m "feat(api): add /mean endpoint"
git switch main && git merge --no-ff feat/mean-endpoint && git push origin main

# 4b. Red -> either fix, or discard completely and ask again with the error attached.
git switch main && git branch -D feat/mean-endpoint
```

> Verified three ways — a gate is only worth having if it *rejects*:
>
> - **Undefined name in generated code** → `make lint` rejected it (ruff F821). Correct.
> - **Correct-looking code with wrong arithmetic** → `make lint` passed, `make test` rejected it.
>   Correct, and the reason lint alone is not a gate.
> - **A genuine `/mean` endpoint plus its test** → gate passed, `pre-commit` hooks ran on commit
>   (7 hooks, all passed), merged `--no-ff`, pushed to the bare remote. `git log --graph` showed
>   the expected topology.

### How to ask for code that assembles cleanly

The failure mode is almost never bad logic — it is **missing structural information**. Ask for it
explicitly:

- **Request a file tree first, then the files.** "Give me the complete file tree, then each file
  in a separate block with its full path as the first line." Path-per-block is what makes
  writing files out mechanical instead of a judgement call.
- **Paste your actual `pyproject.toml` / `package.json` / `Makefile` as context.** Without them
  you get code written against invented dependency versions and invented conventions.
- **Demand the test in the same response as the code.** Code without a test cannot be gated, and
  ungated code is indistinguishable from a guess.
- **Give it the exact commands you will run** (`make lint && make test`). Naming the gate makes
  the generated code conform to the gate.
- **When it fails, return the verbatim error, not a paraphrase.** Full traceback, full stderr,
  full compiler output. A paraphrase discards the line numbers and type names that determine the
  fix.
- **One concern per branch.** A branch containing a new endpoint *and* a refactor *and* a
  dependency bump gives you a red `make ci` with three candidate causes.

### Two structural checks worth doing manually

Generated code is competent at logic and weak on the seams between files. Before trusting a
green build:

- **Imports and paths.** Does every import resolve to a file that exists at that path? A test
  can pass while an unreferenced module sits orphaned.
- **Dependencies actually declared.** If generated code imports `httpx`, it must appear in
  `pyproject.toml`. Working locally because something else pulled it in transitively is the
  standard way a container build fails after local tests pass.

---

## 6. Phase 5 — Containers, and why the smoke test matters

`make test` proves the logic. `make up && make smoke` proves the *system*: that ports are
published, environment variables reach the process, and one service can resolve and reach
another.

```bash
make up      # docker compose up -d --wait
make smoke
make down
```

Three details in the provided compose file that are load-bearing:

- **`--wait` plus a `healthcheck`.** Without a healthcheck, `docker compose up -d` returns as
  soon as containers *start*, not when they are *ready*, and your smoke test races the app's
  startup. `--wait` blocks until healthchecks pass. See
  <https://docs.docker.com/reference/cli/docker/compose/up/>.
- **`depends_on: condition: service_healthy`.** Plain `depends_on` only orders *start*, it does
  not wait for readiness. See <https://docs.docker.com/reference/compose-file/services/#depends_on>.
- **Service name as hostname.** `web` reaches the API at `http://api:8000` — Docker's embedded
  DNS resolves the service name on the user-defined network. `localhost` inside a container is
  that container, which is the single most common wiring mistake. See
  <https://docs.docker.com/engine/network/>.

Also note the Dockerfile layer ordering: dependency manifests are copied and installed *before*
source. Docker caches layers, so editing a source file does not re-run `pip install`. Getting
this backwards turns a 3-second rebuild into a 90-second one.
See <https://docs.docker.com/build/cache/>.

> Verified on macOS 26 / Apple Silicon (arm64): both images built (~14.5s each), both containers
> reported healthy under `up -d --wait` (api 6.4s, web 6.2s), and all four smoke checks passed
> including `web` → `api` over the compose network.
>
> The authoring sandbox could not do this — it blocks egress to Docker Hub, `public.ecr.aws`,
> `mirror.gcr.io`, and `ghcr.io` (403 on manifest HEAD), so no base image would pull. There the
> **identical smoke test was verified against both services running as host processes**
> (`make up-native`), which is why those targets exist. Keep them: they are the fallback on a
> restricted network, and they are what you want when attaching a debugger to a process.

```
GET  http://localhost:8000/health               PASS
POST http://localhost:8000/sum                  PASS
POST http://localhost:8000/sum (empty -> 422)   PASS
GET  http://localhost:3000/ (web -> api)        PASS
```

---

## 7. Phase 6 — Local CI

Two independent layers, and you want both.

**`pre-commit` — fast checks at commit time, on staged files only.**

```bash
cd ~/lab/demo-app
pre-commit install            # writes .git/hooks/pre-commit
pre-commit run --all-files    # first run; also populates its cache
```

The committed `.pre-commit-config.yaml` includes `detect-private-key` and
`check-added-large-files`, which prevent the two mistakes that are genuinely painful to undo once
pushed. Ref: <https://pre-commit.com>.

**`act` — run the real GitHub Actions workflow locally.**

```bash
act -l                        # list jobs
act push                      # execute the push-triggered workflow in Docker
```

`act` pulls a runner image (~1 GB on first use) and needs a working Docker daemon. It is not a
perfect emulation of GitHub-hosted runners — service containers and some `GITHUB_*` context
values differ — but it catches the large majority of workflow-syntax and step-ordering errors
without a push. Ref: <https://nektosact.com/>.

> Verified: `pre-commit install` + `pre-commit run --all-files` → 7 hooks, all passed, and the
> hooks fired again automatically on a real `git commit`. `act -l` correctly parsed `ci.yml` and
> listed the `build` job for `push,pull_request`. `act push` was **not** run — it needs to pull a
> runner image, and registry egress was blocked in this environment.

Because `ci.yml` only calls `make setup / lint / test / build`, `make ci` locally and the GitHub
job are running the same code path. That is the property to preserve: if you ever add a step to
CI that is not a make target, local and CI have diverged.

---

## 8. Troubleshooting: the failures you will actually hit

| Symptom | Cause | Fix |
|---|---|---|
| bootstrap aborts at exit 100 on `apt-get update` | one configured apt source is unreachable; `apt-get update` fails wholesale and `set -e` kills the script | already handled — the script warns and continues. If you hit it in your own scripts, `apt-get update \|\| true` and check the packages you need individually |
| `nvm install 22` → `Version '22' not found` | nvm cannot reach `nodejs.org` to fetch the version index | the script falls back to any already-installed Node ≥ target and warns; otherwise install Node from your distro or a mirror |
| macOS: script aborts with `SOFT_FAIL: unbound variable` on a *clean* run | bash 3.2 cannot dereference an empty array under `set -u` | already handled. In your own scripts, avoid empty-array deref or drop `set -u` |
| macOS: `timeout: command not found` | `timeout` is GNU coreutils, not in BSD userland | `brew install coreutils` (installs it as `gtimeout`), or probe for both |
| `permission denied /var/run/docker.sock` | user not in `docker` group in this shell | `sudo usermod -aG docker $USER` then `newgrp docker` or re-login |
| `403 Forbidden` / `failed to resolve source metadata` on `docker build` | registry egress blocked by a proxy or firewall | configure a registry mirror, or use `make up-native` |
| `ModuleNotFoundError` in tests but the file exists | package not installed, or `src/` not on the path | `uv pip install -e ".[dev]"`; confirm `pythonpath`/`testpaths` in `pyproject.toml` |
| Container starts then exits 0 immediately | the `CMD` process is not long-running | `docker compose logs <svc>`; ensure the command blocks |
| `web` cannot reach `api` in compose | used `localhost` instead of the service name | `http://api:8000` |
| smoke test flaky right after `up` | racing startup | add a `healthcheck` and use `up -d --wait` |
| `npm install` takes minutes under WSL2 | working on `/mnt/c/...` | move the repo into the Linux filesystem (`~/lab`) |
| Shell script silently stops mid-run | `set -o pipefail` plus a failing command in a substitution | append `|| true` inside the substitution; run `shellcheck` |

That last row is not hypothetical. `bootstrap.sh` originally contained:

```bash
NVM_TAG="$(curl -fsSL https://api.github.com/... | jq -r '.tag_name // empty')"
```

With `set -euo pipefail`, a failed `curl` makes the whole pipeline fail, the assignment inherits
that status, and the script exits — silently, at exit code 22, with no error message.
`shellcheck` does **not** flag this. It was caught only by running every flag combination and
asserting the script reached its final line. The lesson generalises: *lint is not verification,
execution is.*

---

## 9. Command reference

```bash
# toolchain
./bootstrap.sh [--dry-run] [--no-docker] [--no-ci]
./scaffold-lab.sh                      # LAB_ROOT=~/lab by default

# per-repo
make setup            # install all dependencies
make lint             # ruff check + ruff format --check + tsc --noEmit
make test             # pytest + vitest
make build            # docker compose build
make up   / make down         # containerised stack
make up-native / make down-native   # host processes, no Docker
make smoke            # black-box checks against whatever is running
make ci               # lint + test + build == what GitHub Actions runs
make clean

# git
git switch -c feat/x                   # branch before applying generated code
make lint && make test                 # gate
git switch main && git merge --no-ff feat/x
git branch -D feat/x                   # discard a failed attempt
git ls-remote --heads origin           # what the remote actually has
```

---

## 10. References

- Git Book — <https://git-scm.com/book/en/v2>
- Git bare repositories / server setup — <https://git-scm.com/book/en/v2/Git-on-the-Server-Getting-Git-on-a-Server>
- uv documentation — <https://docs.astral.sh/uv/>
- Python `src` vs flat layout — <https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/>
- pytest — <https://docs.pytest.org/>
- Ruff — <https://docs.astral.sh/ruff/>
- nvm — <https://github.com/nvm-sh/nvm>
- Vitest — <https://vitest.dev/guide/>
- TypeScript `tsconfig` reference — <https://www.typescriptlang.org/tsconfig>
- Docker Engine install (Ubuntu) — <https://docs.docker.com/engine/install/ubuntu/>
- Docker Desktop + WSL2 — <https://docs.docker.com/desktop/features/wsl/>
- Dockerfile best practices — <https://docs.docker.com/build/building/best-practices/>
- Build cache — <https://docs.docker.com/build/cache/>
- Compose file reference — <https://docs.docker.com/reference/compose-file/>
- Docker networking — <https://docs.docker.com/engine/network/>
- Multi-platform builds — <https://docs.docker.com/build/building/multi-platform/>
- GitHub Actions — <https://docs.github.com/actions>
- act (local Actions runner) — <https://nektosact.com/>
- pre-commit — <https://pre-commit.com>
- ShellCheck — <https://www.shellcheck.net/>
- FastAPI — <https://fastapi.tiangolo.com/>
- WSL filesystem performance — <https://learn.microsoft.com/windows/wsl/filesystems>
- GNU Make manual — <https://www.gnu.org/software/make/manual/>

*URLs are cited for you to verify against upstream; the sandbox this was written in had no web
access, so they were not fetched. Version-pinned examples (Node 22 LTS, Python 3.12, nvm tag)
may have moved on — the bootstrap script resolves the nvm tag at runtime rather than hardcoding
it.*
