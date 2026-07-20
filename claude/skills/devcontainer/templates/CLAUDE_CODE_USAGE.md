# Using Claude Code and Codex in this DevContainer

Claude Code and Codex run inside the container, following the personal devcontainer standard (see the `devcontainer` skill in dotfiles — the source of truth for versions and conventions).

## Setup

1. **Ensure Docker is running**, Codex is logged in on the host (`~/.codex/auth.json` must exist), and `ssh-agent` has your key (`ssh-add --apple-use-keychain`, or `AddKeysToAgent yes` in `~/.ssh/config`) — git auth inside the container comes from agent forwarding, not mounted keys.
2. **Open in VS Code** → `Dev Containers: Reopen in Container` (first build takes a few minutes).
3. **Authenticate Claude** once, inside the container:

```bash
claude auth login
```

Claude config persists in `claude-config`. Host Codex auth is imported into the separate `codex-config` volume during container creation; subsequent token refreshes stay container-local. Both volumes survive rebuilds.

## Using Claude Code

```bash
claude       # interactive
clauded      # claude --dangerously-skip-permissions (alias)
```

## Using Codex

```bash
codex        # interactive
codexd       # codex --yolo (alias)
```

## Isolation model — what's actually true

`clauded` and `codexd` are acceptable here because of what this container can and cannot reach:

- ✅ **No host filesystem** beyond this project's workspace and the explicit read-only Codex credential file.
- ✅ **No SSH keys in the container** — agent forwarding only; keys can be used for git, never read.
- ✅ **No docker socket** — the host Docker daemon is unreachable.{{IF_DIND}} Testcontainers talk to the isolated DinD sidecar (`DOCKER_HOST=tcp://docker:2375`); containers created there cannot touch the host.{{END_IF_DIND}}
- ⚠️ **Full network egress.** A prompt-injected agent could exfiltrate anything readable inside the container: this project's source, agent credentials, and whatever is in `.devcontainer/.env`. Accepted risk — keep only low-value dev credentials in `.env`. If this project ever holds credentials whose theft would hurt, add the egress firewall (see the skill's optional blocks).
- ⚠️ Both agents run as **root inside the container** — full access within it, by design.

## Project specifics

<!-- {{PROJECT_SPECIFICS}}: DATABASE_URL, host-published DB port from the skill's
     port registry, test database conventions, ports, special commands -->

## Volumes and persistence

- `claude-config` → `/root/.claude` — auth/settings, survives rebuilds
- `codex-config` → `/root/.codex` — imported host auth plus container settings, survives rebuilds
- `{{PROJECT}}-node-modules` → `/workspace/node_modules` — container-private so Linux and macOS native binaries don't collide
<!-- postgres-data / dind-storage as applicable -->

## Departures from standard

None.
<!-- If this project deviates from the skill's conventions, list each departure
     and its reason here — visible drift, not silent drift. -->

## Troubleshooting

Rebuild from the Command Palette: `Dev Containers: Rebuild Container`.
