---
name: devcontainer
description: Scaffold a project's devcontainer following my standard conventions (Debian + Bun + Claude Code in-container, isolated for --dangerously-skip-permissions). Use when asked to set up, recreate, or review a devcontainer for a project.
---

# Devcontainer Scaffold

Scaffold `.devcontainer/` for a project following the personal standard (lineage: personal-assistant → rostr/lede). The skill is the single source of truth for versions, conventions, and the host port registry — projects no longer carry "keep in sync with personal-assistant" comments.

## Version block

The only place versions are defined. Bump here; projects pick it up when scaffolded or synced.

| Component | Version |
|---|---|
| Base image | `debian:bookworm-slim@sha256:f9c6a2fd2ddbc23e336b6257a5245e31f996953ef06cd13a59fa0a1df2d5c252` |
| Bun | `1.3.9` — **positional arg**: `bash -s "bun-v1.3.9"`. The `BUN_VERSION` env var is silently ignored by the install script. |
| Node | 22 (nodesource `setup_22.x`) |
| Go | `1.24.13` |
| DinD sidecar | `docker:28-dind` |
| Postgres sidecar | `postgres:18-alpine` |

## Host port registry

Host-published DB ports across projects on this machine. Assign the next free port to new projects and **update this table** as part of the run.

| Host port | Project |
|---|---|
| 5432 | personal-assistant |
| 5433 | rostr |
| 5434 | (next free) |

In-container connections always use the service name and default port (`db:5432`); the registry only governs the host-side publish.

## Procedure

### 1. Inspect (before asking anything)

Derive from the repo:
- **Project name** (directory / package.json name) → container names, volume prefix.
- **Runtime**: is this a Bun/TypeScript project? If not (Python, etc.), this skill's templates don't apply — scaffold a standalone setup by hand, keeping only the agent-layer conventions (Claude and Codex config volumes, containerEnv, usage doc, no socket, no key mounts).
- **Database**: drizzle config, `DATABASE_URL` references, existing compose `db` service → postgres sidecar default.
- **Testcontainers**: `testcontainers` in deps → DinD sidecar default.
- **Playwright**: in deps → browser install default.
- **Ports**: dev-server/API ports from scripts and config (typical: 3000 API, 5173 Vite, 4983 Drizzle Studio).
- **Existing root `docker-compose.yml`**: if it already defines a `db`, use the **merge pattern** — `dockerComposeFile: ["../docker-compose.yml", "docker-compose.dev.yml"]` with the dev file as an overlay (`ports: !override` to re-publish on the registry port). Never duplicate a service definition.

### 2. Interview (one batched round, then run silently)

Ask in a single round, proposing detection-based defaults:
1. **Sidecar services** — default from detection (postgres / none). Mention the DinD sidecar if testcontainers was detected.
2. **Ports to forward** — propose the detected list for confirmation.
3. **Extras** — Playwright, drizzle-kit: default from detection.

Skip any question whose answer detection made unambiguous. Do not ask about things the standard settles (user, mounts, volumes, socket).

### 3. Emit

From `templates/`, fill placeholders (`{{PROJECT}}`, port labels, optional blocks) and write:
- `.devcontainer/devcontainer.json`
- `.devcontainer/Dockerfile`
- `.devcontainer/docker-compose.dev.yml`
- `.devcontainer/shell-config.sh`
- `.devcontainer/post-start.sh`
- `.devcontainer/CLAUDE_CODE_USAGE.md` (covers both Claude Code and Codex)
- `.devcontainer/.env.example` (and an empty-ish `.env`); verify `.env` is gitignored — add `.devcontainer/.env` to `.gitignore` if not.
- **`.claude/settings.json` at the repo root** (not under `.devcontainer/`) — the committed project-settings home. If absent, write `{"$schema": "https://json.schemastore.org/claude-code-settings.json", "env": {"ENABLE_LSP_TOOL": "1"}}`. If it already exists, **merge** the `env.ENABLE_LSP_TOOL` key in — never clobber a collaborator's existing project settings.

**Cache alignment rule:** the Dockerfile's invariant block (everything above the `--- project-specific ---` marker in the template) must be emitted **byte-identical and first** in every project. Docker's layer cache is keyed on the instruction chain, so identical leading blocks share cached layers across projects — this is deliberately a substitute for a shared base image (considered, rejected: the overlap is coincidental, not a real base concept). Project-specific lines go only below the marker, in the template's canonical order.

### 4. Verify

- `docker compose -f .devcontainer/docker-compose.dev.yml config` (include the root compose file first when using the merge pattern) — must parse cleanly.
- If the user wants a build test: `docker compose ... build dev` (slow; ask first).

### 5. Close out

- Update the port registry table in this SKILL.md if a port was assigned.
- Report: files written, ports chosen (host + forwarded), sidecars included, anything departed from standard.

## Non-negotiables (and why)

Emit these always; do not drop them even if they look optional:

- **`remoteUser: root`** — dev convenience inside an isolated container. The historical `vscode`-user fork (decryptid, petrol-patrol) is where the claude-config volume got lost and dead shell-config bugs crept in. Root-only.
- **Separate config volumes** — `claude-config` → `/root/.claude` and `codex-config` → `/root/.codex`, so each agent's auth and settings survive rebuilds. Compose namespaces volumes per project. Codex starts from a copy of the host login; Claude logs in once per project.
- **Host Codex auth import** — read-only bind `~/.codex/auth.json` to `/run/host-codex-auth.json`, then copy it with mode `600` into `codex-config` from `postCreateCommand`. Copy the credential only; mounting all of `~/.codex` would expose host sessions and mix macOS state with the Linux container. The host must use file-based credentials and be logged in before container creation.
- **`{{PROJECT}}-node-modules` named volume** — the host (macOS) and container (Linux) must not share one bind-mounted `node_modules`: native binaries are platform-specific and `bun install` only materializes the current platform's. The most-dropped element historically; always emit it.
- **No `~/.ssh` mount. Ever.** Git auth comes from SSH **agent forwarding**: VS Code forwards `SSH_AUTH_SOCK` automatically when `ssh-agent` runs on the host. Keys never enter the container, so an agent running with skipped permissions cannot read or exfiltrate them. Requires `ssh-add --apple-use-keychain` (or `AddKeysToAgent yes`) on the host — documented in the usage doc.
- **`~/.gitconfig:ro` mount** — commit identity and signing config inside the container.
- **No raw docker socket. Ever.** `/var/run/docker.sock` in a root container is host root (a created container can bind-mount `/Users` through the Docker Desktop VM). Projects needing Docker (testcontainers) get the **DinD sidecar**: an isolated daemon at `DOCKER_HOST=tcp://docker:2375`; binds made there only see the sidecar's filesystem. Costs: the sidecar is privileged (agent can only reach its TCP API, never the container itself) and has its own image cache.
- **`containerEnv`**: `CLAUDE_CONFIG_DIR=/root/.claude`, `IS_SANDBOX=1`. Container-runtime facts only — the LSP gate does **not** live here. It's a project policy, equally true on the host, so it belongs in the committed `.claude/settings.json` (next).
- **Committed `.claude/settings.json` at the repo root** — the home for project-wide Claude policy that must apply on host *and* in-container (project settings are read from the project tree regardless of `CLAUDE_CONFIG_DIR`). Emit it carrying the LSP gate `{"env": {"ENABLE_LSP_TOOL": "1"}}` — singular; the plural `ENABLE_LSP_TOOLS` is a silent no-op, absent from the Claude Code binary. This is the LSP *gate*; the language-server binary below is what it drives — the two are separate and both required.
- **Claude Code + OpenAI Codex CLIs** — both installed in the invariant Dockerfile block via their official `install.sh` scripts (standalone binaries → `/root/.local/bin`). Both are standard agent tooling, not extras. Their auth and settings persist in separate named volumes: `claude-config` → `/root/.claude`, `codex-config` → `/root/.codex`.
- **`post-start.sh` — the every-start hook, bind-mounted and run from the compose `command`.** Named for the lifecycle slot rather than the job because it *is* the slot: one per container, spec-defined, and it accumulates unrelated steps. It holds three, and everything in it refreshes something the Dockerfile already installed — the image is a working floor, the hook brings it current:
  1. **Agent CLIs** (`claude`, `codex`) — those install lines are unpinned but sit in the cache-aligned block, so the layer is built once and reused forever: a months-old CLI that *looks* like "latest at build".
  2. **Global dev tools** (`typescript-language-server`, plus `drizzle-kit` with postgres) — same staleness, cheap to redo.
  3. **`bun install`** — `node_modules` is a container-private volume, so a pull or branch switch that moves the lockfile leaves it stale until someone rebuilds. Keeps the `package.json` guard for repos scaffolded before the app exists.
  - **Nothing in it may abort the start** — every step tolerates failure and says so on stderr. A container that won't come up can't be debugged, and a stale dep tree is a worse thing to hide than to announce. Cost: ~15s on `docker compose up`.
  - **Deliberately excluded: `mcp-language-server`.** Textually the worst offender in the Dockerfile (`go install …@latest` in a never-invalidated layer), but refreshing it is a Go compile — the wrong cost for a start hook. Bump it by rebuilding.
  - **Rejected alternatives:** pinning the CLIs in the version block (not build inputs; the bump would be manual forever); `postCreateCommand` (create-only, and a failed download leaves no CLI at all); `COPY` into the image (a start script shouldn't need a rebuild to edit).
  - **Do not also wire `postStartCommand` in devcontainer.json** — under VS Code both would fire and the script would run twice. The compose command is the single hook, because it's the only one that survives a plain `docker compose up`.
- **`shell-config.sh` with the `clauded` and `codexd` aliases** (`claude --dangerously-skip-permissions` / `codex --yolo`), sourced from `/root/.bashrc` **off the workspace bind mount**, not `COPY`'d into the image — an alias edit should cost a new shell, not a rebuild. The `.bashrc` line is `[ -f … ] &&`-guarded so the image still opens a clean shell when run without the mount.
- **Go + mcp-language-server + typescript-language-server** — the language-server binaries the LSP tool drives; part of the standard, not an extra. `typescript-language-server` is refreshed by `post-start.sh`; `mcp-language-server` is not (compile cost) — rebuild to bump it. The gate that *activates* the tool lives in the committed `.claude/settings.json` (above), not here — binary and gate are separate.
- **`command: bash -c 'bash /workspace/.devcontainer/post-start.sh; exec sleep infinity'`** — invoked via the workspace bind mount, not a baked path, so the script is editable without a rebuild. `exec` keeps the idle process as PID 1 so the container stops cleanly. Plus `workspaceFolder`/`working_dir` `/workspace`, workspace bind `..:/workspace:cached`.
- **`postCreateCommand` imports the host Codex auth, and nothing else.** `bun install` moved to `post-start.sh`. The auth copy stays create-only on purpose: re-running it every start would overwrite a token the container refreshed itself with an older one from the host, which breaks auth rather than fixing it.

## Optional blocks (emit on detection or request)

- **Postgres sidecar** — `db` service, healthcheck, `depends_on: condition: service_healthy`, `DATABASE_URL` preset in dev environment, `postgresql-client` apt package, host publish from the port registry.
- **DinD sidecar** — when testcontainers detected: `docker` service (privileged, `DOCKER_TLS_CERTDIR=""`, `dind-storage` volume), `DOCKER_HOST=tcp://docker:2375` on dev, `docker-ce-cli` apt block in the Dockerfile.
- **Playwright** — `RUN bunx playwright install --with-deps chromium` (heavy; only when the project tests with it).
- **drizzle-kit** — global install alongside the DB block.
- **Egress firewall** — OFF by default; user has acknowledged the residual exfiltration risk (prompt injection + full network egress can leak whatever is in the container: source and dev creds). Offer it only when the container will hold credentials whose theft would actually hurt. Implementation if requested: `NET_ADMIN` capability + a `postStartCommand` iptables/ipset script — default-deny outbound, allowlist `api.anthropic.com`, `registry.npmjs.org`, GitHub's published IP ranges, plus the project's own API domains. Warn: breaks WebFetch of arbitrary URLs.

## Departures

If the user's request explicitly contradicts a rule here, honor it — and record the departure and its reason in the project's `CLAUDE_CODE_USAGE.md` under a "Departures from standard" heading, so drift is visible instead of silent. Never depart silently for convenience.
