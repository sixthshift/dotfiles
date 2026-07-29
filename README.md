# dotfiles

Personal configuration that travels across machines.

## Layout

- `claude/` — master agent config (Claude instructions, voice, portable skills, agents, hooks, settings)
- `codex/` — Codex-only adapters and skills; shared content links from `claude/`
- `shell/` — shell configuration (.bashrc, .zshrc, .shell-config.sh)
- `git/` — git configuration (.gitconfig, global ignore)
- `editor/` — editor configuration (nvim, vim, vscode)

Each subdirectory mirrors a real location under `$HOME` and is symlinked into place by `install.sh`. New tools go in their own top-level directory; add the matching `link` line to `install.sh`.

## Setup on a new machine

```bash
git clone <your-repo-url> ~/dotfiles
cd ~/dotfiles
./install.sh
```

`install.sh` is idempotent: re-running it updates symlinks without losing existing content. Anything real in the way gets backed up to `*.bak.<timestamp>`.

## What syncs vs what stays local

**Tracked in git** (portable):
- `claude/CLAUDE.md` — universal instructions, installed for Claude and Codex
- `claude/skills/`, `claude/agents/`, `claude/hooks/` — master portable skills/agents/hooks
- `claude/settings.json` — global preferences (model, theme, defaults)

**Gitignored** (machine-specific or sensitive):
- `~/.claude/settings.local.json` — local permissions, MCP server paths
- `~/.claude/projects/`, `sessions/`, `history.jsonl`, `plugins/`, `cache/`, etc. — runtime state, never in git
- `~/.codex/config.toml`, auth, sessions, plugins, cache, and project trust — machine-local runtime state, never replaced by `install.sh`
- Anything in `.gitignore`

## Claude and Codex

`claude/` is authoritative. The installer exposes the same universal
instructions and the five portable skills to Codex through `~/.codex/AGENTS.md`
and individual symlinks under `~/.agents/skills`.

**`~/.claude/skills` has two suppliers,** so it is a real directory with per-skill
symlinks rather than one link to `claude/skills`. This repo owns the five general
skills. The build-loop pair — `aispec` (spec interrogation) and `ailoop` (a model
in a build loop's coordinator seat) — moved to the
[`loop`](https://github.com/sixthshift/loop) project and arrive via
`loop skills install`, because they are clients of that CLI's contract: a renamed
verb or a tightened kickoff gate breaks them, so they version with it instead of
drifting here. `loop skills install` refuses to write through a symlinked skills
root, which is exactly why the whole-directory link had to go.

So after `./install.sh` on a new machine, run `loop skills install` too.

## Adding a new tool

1. Create a subdirectory (e.g. `tmux/`).
2. Move the real config file in (e.g. `tmux/.tmux.conf`).
3. Add a line to `install.sh`: `link "tmux/.tmux.conf" "$HOME/.tmux.conf"`.
4. Re-run `./install.sh`.

## Pushing to GitHub

```bash
cd ~/dotfiles
git init
git add .
git commit -m "initial dotfiles"
gh repo create dotfiles --public --source=. --push    # or --private
```
