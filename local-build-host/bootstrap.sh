#!/usr/bin/env bash
#
# bootstrap.sh — install the toolchain for a local build/test host.
#
# Supports: Debian/Ubuntu (including WSL2) and macOS (Apple Silicon or Intel).
# Idempotent: every step checks before it installs, so re-running is safe and fast.
#
# Usage:
#   ./bootstrap.sh                 # install everything
#   ./bootstrap.sh --no-docker     # skip the container runtime
#   ./bootstrap.sh --no-ci         # skip act / gh / pre-commit
#   ./bootstrap.sh --dry-run       # print what would happen, change nothing
#
# Failure policy: a blocked download or an unreachable apt repo degrades to a
# warning and the run continues. Only ESSENTIAL tools (git, make, curl, uv,
# node, npm) cause a non-zero exit. This matters on corporate networks, where
# one proxied repository should not abort the whole bootstrap.
#
# Sources for each install method are cited inline; verify them against the
# upstream docs before running this on a machine you care about.

set -euo pipefail

NODE_LTS="22"
WANT_DOCKER=1
WANT_CI=1
DRY=0

for arg in "$@"; do
  case "$arg" in
    --no-docker) WANT_DOCKER=0 ;;
    --no-ci)     WANT_CI=0 ;;
    --dry-run)   DRY=1 ;;
    -h|--help)   sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- ui helpers
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Not every tool answers --version (unzip wants -v), so try both and never fail.
ver()  { { "$1" --version 2>/dev/null || "$1" -v 2>/dev/null || echo installed; } | head -1 | cut -c1-50; }

# Degraded-step tracking.
# NOT an array on purpose: macOS ships bash 3.2 (2007, GPLv2 — Apple will not
# ship bash 4+), and in bash < 4.4 dereferencing an EMPTY array under `set -u`
# aborts with "unbound variable". A newline-delimited string is 3.2-safe.
SOFT_FAIL=""
SOFT_N=0
soft_fail() { SOFT_FAIL="${SOFT_FAIL}$1
"; SOFT_N=$((SOFT_N + 1)); }

# `mktemp` with no template is GNU-only; BSD/macOS needs an explicit one.
mktmp() { mktemp "${TMPDIR:-/tmp}/bootstrap.XXXXXX"; }

# macOS has no `timeout` (GNU coreutils installs it as `gtimeout`).
# Degrade to running without a timeout rather than failing outright.
with_timeout() {
  local secs="$1"; shift
  if   have timeout;  then timeout  "$secs" "$@"
  elif have gtimeout; then gtimeout "$secs" "$@"
  else "$@"; fi
}

# run  — must succeed. Aborts the script on failure (set -e).
run() { if [ "$DRY" = 1 ]; then printf '    \033[90m# %s\033[0m\n' "$*"; else eval "$*"; fi; }

# try  — best effort. On failure: warn, show the tail of the log, record, keep going.
#        Usage: try "<label>" "<command>"
try() {
  local label="$1"; shift
  if [ "$DRY" = 1 ]; then printf '    \033[90m# %s\033[0m\n' "$*"; return 0; fi
  local log; log="$(mktmp)"
  if eval "$*" >"$log" 2>&1; then
    rm -f "$log"; return 0
  fi
  warn "$label failed — continuing"
  sed 's/^/         /' "$log" | tail -4
  soft_fail "$label"
  rm -f "$log"
  return 0
}

# ------------------------------------------------------------ platform probe
OS="$(uname -s)"
IS_WSL=0
case "$OS" in
  Linux)
    if ! have apt-get; then
      echo "This script handles Debian/Ubuntu (apt) and macOS only." >&2
      echo "On Fedora/Arch, install the same tools with dnf/pacman and re-read the runbook." >&2
      exit 1
    fi
    PLATFORM=debian
    grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1
    ;;
  Darwin) PLATFORM=macos ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

say "platform: $PLATFORM$([ "$IS_WSL" = 1 ] && echo ' (WSL2)')  arch: $(uname -m)"
[ "$DRY" = 1 ] && warn "dry run — nothing will be installed"

# ------------------------------------------------------------ package manager
if [ "$PLATFORM" = macos ]; then
  # https://brew.sh
  if ! have brew; then
    say "installing Homebrew"
    try "Homebrew install" '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      [ -x "$p" ] && eval "$("$p" shellenv)" && break
    done
  else
    ok "Homebrew $(brew --version | head -1)"
  fi
  PKG_INSTALL="brew install"
else
  say "refreshing apt index"
  # apt-get update exits non-zero if ANY configured source fails, even when
  # every source you actually need succeeded. Report the broken ones, continue.
  if [ "$DRY" = 1 ]; then
    printf '    \033[90m# sudo apt-get update\033[0m\n'
  else
    APT_LOG="$(mktmp)"
    # shellcheck disable=SC2024  # false positive: APT_LOG is a user-owned mktemp,
    # and the redirect is performed by this shell, not by the sudo'd process.
    if sudo apt-get update -qq >"$APT_LOG" 2>&1; then
      ok "apt index current"
    else
      warn "some apt sources are unreachable (proxy/firewall?):"
      grep -oE "https?://[^ ]+" "$APT_LOG" | sed 's|/dists/.*||' | sort -u \
        | sed 's/^/         /' | head -5
      warn "continuing — packages from working sources are still installable"
      soft_fail "apt sources unreachable"
    fi
    rm -f "$APT_LOG"
  fi
  PKG_INSTALL="sudo apt-get install -y -qq"
fi

# ------------------------------------------------------------------ base bits
say "base tools"
for pkg in git curl jq make unzip; do
  if have "$pkg"; then ok "$pkg $(ver "$pkg")"
  else try "install $pkg" "$PKG_INSTALL $pkg"; fi
done
# build toolchain — many pip/npm packages compile native extensions
if [ "$PLATFORM" = debian ]; then
  have gcc || try "install build-essential" "$PKG_INSTALL build-essential"
  # ca-certificates + gnupg are prerequisites for adding third-party apt repos
  try "install ca-certificates gnupg" "$PKG_INSTALL ca-certificates gnupg"
else
  xcode-select -p >/dev/null 2>&1 || try "xcode CLT" "xcode-select --install"
fi
have shellcheck || try "install shellcheck" "$PKG_INSTALL shellcheck"

# ---------------------------------------------------------------------- git
say "git configuration"
git config --global --get init.defaultBranch >/dev/null 2>&1 \
  || run "git config --global init.defaultBranch main"
git config --global --get pull.rebase >/dev/null 2>&1 \
  || run "git config --global pull.rebase true"
# Long paths + CRLF are the two classic cross-platform footguns.
if [ "$PLATFORM" = debian ]; then
  git config --global --get core.autocrlf >/dev/null 2>&1 \
    || run "git config --global core.autocrlf input"
fi
if ! git config --global --get user.email >/dev/null 2>&1; then
  warn "git user.name / user.email are unset. Set them before committing:"
  warn "  git config --global user.name  'Your Name'"
  warn "  git config --global user.email 'you@example.com'"
else
  ok "committing as $(git config --global user.name) <$(git config --global user.email)>"
fi

# --------------------------------------------------------------------- python
# uv replaces pyenv + pip + virtualenv + pip-tools. https://docs.astral.sh/uv/
say "python toolchain (uv)"
if have uv; then
  ok "uv $(uv --version)"
else
  try "uv install" 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  export PATH="$HOME/.local/bin:$PATH"
fi
# Pin an interpreter uv manages, so the host python is never the build python.
if have uv; then
  try "uv python install 3.12" "uv python install 3.12"
fi

# ----------------------------------------------------------------------- node
# nvm keeps Node per-user and per-project. https://github.com/nvm-sh/nvm
say "node toolchain (nvm + Node ${NODE_LTS} LTS)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  # `|| true` matters: without it, `set -o pipefail` makes a failed curl abort.
  NVM_TAG="$(curl -fsSL https://api.github.com/repos/nvm-sh/nvm/releases/latest 2>/dev/null \
             | jq -r '.tag_name // empty' 2>/dev/null || true)"
  NVM_TAG="${NVM_TAG:-v0.40.1}"   # fallback if the API is unreachable
  try "nvm install ($NVM_TAG)" \
      "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_TAG}/install.sh | bash"
else
  ok "nvm present at $NVM_DIR"
fi

if [ "$DRY" = 0 ]; then
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    try "nvm install $NODE_LTS" "nvm install $NODE_LTS && nvm alias default $NODE_LTS"
  fi
  # nvm may have failed (blocked download) while a usable node is already present.
  if have node; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$NODE_MAJOR" -ge "$NODE_LTS" ]; then
      ok "node $(node --version), npm $(npm --version)"
    else
      warn "node $(node --version) is older than the target v${NODE_LTS}.x"
      soft_fail "node older than v${NODE_LTS}"
    fi
  fi
fi

# --------------------------------------------------------------------- docker
if [ "$WANT_DOCKER" = 1 ]; then
  say "container runtime"
  if have docker; then
    ok "docker $(docker --version)"
  elif [ "$PLATFORM" = macos ]; then
    # Docker Desktop or OrbStack; OrbStack is lighter and CLI-compatible.
    try "docker desktop install" "brew install --cask docker"
    warn "launch Docker Desktop once to finish setup"
  elif [ "$IS_WSL" = 1 ]; then
    warn "WSL2 detected. Two options:"
    warn "  a) Install Docker Desktop on Windows and enable WSL integration (easiest)"
    warn "     https://docs.docker.com/desktop/features/wsl/"
    warn "  b) Install Docker Engine directly in this distro (below), then"
    warn "     add 'sudo service docker start' to your shell profile"
    warn "Re-run with --no-docker to skip. Proceeding with (b) in 5s..."
    sleep 5
  fi

  if [ "$PLATFORM" = debian ] && ! have docker; then
    # https://docs.docker.com/engine/install/ubuntu/  (apt repo, not get.docker.com)
    try "docker keyring" "sudo install -m 0755 -d /etc/apt/keyrings \
      && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
      && sudo chmod a+r /etc/apt/keyrings/docker.asc"
    try "docker apt source" "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \$(. /etc/os-release && echo \\\"\\\${UBUNTU_CODENAME:-\\\$VERSION_CODENAME}\\\") stable\" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null && sudo apt-get update -qq"
    try "docker engine install" "sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    if have docker; then
      try "docker group" "sudo usermod -aG docker \$USER"
      warn "log out and back in (or run 'newgrp docker') for group membership to apply"
    fi
  fi

  # A reachable registry is a separate question from an installed daemon.
  if [ "$DRY" = 0 ] && have docker && docker info >/dev/null 2>&1; then
    if with_timeout 45 docker pull -q hello-world >/dev/null 2>&1; then
      ok "registry reachable (pulled hello-world)"
      docker rmi -f hello-world >/dev/null 2>&1 || true
    else
      warn "daemon runs but the registry is unreachable — image builds will fail."
      warn "Use 'make up-native' for the app loop, or configure a registry mirror:"
      warn "  https://docs.docker.com/docker-hub/image-library/mirror/"
      soft_fail "container registry unreachable"
    fi
  fi
fi

# ------------------------------------------------------------------ ci tools
if [ "$WANT_CI" = 1 ]; then
  say "CI + hygiene tools"

  # pre-commit — runs linters on staged files before every commit.
  # https://pre-commit.com
  if have pre-commit; then ok "pre-commit $(pre-commit --version)"
  elif have uv; then try "pre-commit install" "uv tool install pre-commit"
  else warn "skipping pre-commit (uv unavailable)"; soft_fail "pre-commit"; fi

  # gh — GitHub CLI. https://github.com/cli/cli/blob/trunk/docs/install_linux.md
  if have gh; then
    ok "gh $(gh --version | head -1)"
  elif [ "$PLATFORM" = macos ]; then
    try "gh install" "brew install gh"
  else
    try "gh apt source" "sudo mkdir -p -m 755 /etc/apt/keyrings \
      && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
      && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      && echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
      && sudo apt-get update -qq"
    try "gh install" "sudo apt-get install -y -qq gh"
  fi

  # act — runs GitHub Actions workflows locally in Docker.
  # https://nektosact.com/installation/
  if have act; then
    ok "act $(act --version)"
  elif [ "$PLATFORM" = macos ]; then
    try "act install" "brew install act"
  else
    try "act install" "curl -fsSL https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash -s -- -b /usr/local/bin"
  fi
fi

# ----------------------------------------------------------------- shell rc
say "shell profile"
RC="$HOME/.bashrc"
[ "$(basename "${SHELL:-bash}")" = zsh ] && RC="$HOME/.zshrc"
MARK="# --- local build host (bootstrap.sh) ---"
if ! grep -qF "$MARK" "$RC" 2>/dev/null; then
  if [ "$DRY" = 1 ]; then
    warn "would append PATH + nvm lines to $RC"
  else
    {
      echo ""
      echo "$MARK"
      echo 'export PATH="$HOME/.local/bin:$PATH"'
      echo 'export NVM_DIR="$HOME/.nvm"'
      echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
      echo '[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"'
    } >> "$RC"
    ok "appended to $RC"
  fi
else
  ok "$RC already configured"
fi

# ------------------------------------------------------------------- summary
echo
say "verification"
ESSENTIAL="git make curl uv node npm"
OPTIONAL="jq shellcheck pre-commit gh act docker"
missing_essential=0

for t in $ESSENTIAL; do
  printf '    %-12s ' "$t"
  if have "$t"; then printf '\033[32m%s\033[0m\n' "$(ver "$t")"
  else printf '\033[31mMISSING (essential)\033[0m\n'; missing_essential=1; fi
done
for t in $OPTIONAL; do
  printf '    %-12s ' "$t"
  if [ "$t" = docker ] && have docker; then
    if docker info >/dev/null 2>&1; then printf '\033[32mdaemon reachable\033[0m\n'
    else printf '\033[33minstalled, daemon not running\033[0m\n'; fi
  elif have "$t"; then printf '\033[32m%s\033[0m\n' "$(ver "$t")"
  else printf '\033[33mnot installed (optional)\033[0m\n'; fi
done

echo
if [ "$SOFT_N" -gt 0 ]; then
  say "degraded steps ($SOFT_N)"
  printf '%s' "$SOFT_FAIL" | sed 's/^/    - /'
  echo
fi

if [ "$missing_essential" = 1 ]; then
  warn "essential tools are missing — the build loop will not run. Scroll up for the failing step."
  exit 1
fi

say "ready. Next:  ./scaffold-lab.sh && cd ~/lab/demo-app && make setup && make ci"
if [ "$SOFT_N" -gt 0 ]; then
  warn "optional steps degraded (listed above) — 'make up-native' covers the Docker-free path"
fi
exit 0
