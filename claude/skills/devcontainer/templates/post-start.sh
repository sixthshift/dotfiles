#!/usr/bin/env bash
# Runs on every container start, from the compose `command` — NOT from
# devcontainer.json's `postStartCommand`, which only fires under VS Code or the
# `devcontainer` CLI and would skip a plain `docker compose up`. Wiring it in
# both places would run it twice.
#
# Bind-mounted rather than COPY'd into the image, so editing start behaviour
# costs a restart instead of a rebuild.
#
# Everything here refreshes something the Dockerfile already installed: the
# image holds a working floor, this brings it current. Nothing here may abort
# the start — a container that won't come up can't be debugged.

set -uo pipefail

# The Dockerfile's agent-CLI layers are a floor, not a pin: those install lines
# are unpinned but sit in the cache-aligned block, so the layer is built once
# and reused forever — "latest at build" that is silently months old. These are
# dev tools; they should be current on every `up`.
reinstall_cli() {
  local name=$1 installer=$2

  echo "[post-start] $name..."
  if curl -fsSL --max-time 90 "$installer" | bash; then
    return
  fi
  echo "[post-start] $name unreachable — keeping the image-baked version" >&2
}

# Same staleness story as the CLIs, and cheap enough to redo each start.
# Deliberately excludes mcp-language-server: `go install` is a compile, the
# wrong cost for a start hook — bump that one by rebuilding.
refresh_global_tools() {
  local -a tools=(typescript-language-server)
  # {{IF_POSTGRES}}
  tools+=(drizzle-kit)
  # {{END_IF_POSTGRES}}

  echo '[post-start] global dev tools...'
  if bun add -g "${tools[@]}"; then
    return
  fi
  echo '[post-start] registry unreachable — keeping the image-baked versions' >&2
}

# node_modules lives in a container-private volume, so a pull or branch switch
# that moves the lockfile leaves it stale until someone rebuilds. Re-running
# here costs ~1s when it is already in sync.
#
# The package.json guard is for new repos, which scaffold the devcontainer
# before the app exists.
sync_dependencies() {
  cd /workspace || return

  if [[ ! -f package.json ]]; then
    echo '[post-start] no package.json yet — skipping bun install'
    return
  fi

  echo '[post-start] bun install...'
  if bun install; then
    return
  fi
  echo '[post-start] bun install FAILED — dependencies are stale' >&2
}

reinstall_cli 'claude code' https://claude.ai/install.sh
reinstall_cli 'codex' https://chatgpt.com/codex/install.sh
refresh_global_tools
sync_dependencies
