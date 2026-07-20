#!/usr/bin/env bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

link() {
  local src="$DOTFILES_DIR/$1"
  local dest="$2"

  if [ ! -e "$src" ]; then
    echo "skip   $1  (not present in dotfiles)"
    return
  fi

  mkdir -p "$(dirname "$dest")"

  if [ -L "$dest" ]; then
    ln -sfn "$src" "$dest"
  elif [ -e "$dest" ]; then
    local backup="${dest}.bak.$(date +%Y%m%d-%H%M%S)"
    echo "backup $dest -> $backup"
    mv "$dest" "$backup"
    ln -s "$src" "$dest"
  else
    ln -s "$src" "$dest"
  fi
  echo "link   $1 -> $dest"
}

# --- Claude Code ---
# Symlink individual items (not the whole ~/.claude dir) so runtime state
# (history.jsonl, sessions/, projects/, plugins/) is preserved.
link "claude/CLAUDE.md"      "$HOME/.claude/CLAUDE.md"
link "claude/voice"          "$HOME/.claude/voice"
link "claude/skills"         "$HOME/.claude/skills"
link "claude/agents"         "$HOME/.claude/agents"
link "claude/hooks"          "$HOME/.claude/hooks"
# Uncomment once you've populated it (review the file first):
# link "claude/settings.json"  "$HOME/.claude/settings.json"

# --- Codex ---
# Claude remains the master copy for shared instructions, voice, and portable
# skills. Link skills individually so Claude-only ailoop (Workflow-based, no
# Codex equivalent) is not exposed to Codex.
link "claude/CLAUDE.md"                    "$HOME/.codex/AGENTS.md"
link "claude/voice"                        "$HOME/.codex/voice"
link "claude/skills/aispec"                "$HOME/.agents/skills/aispec"
link "claude/skills/commit"                "$HOME/.agents/skills/commit"
link "claude/skills/devcontainer"          "$HOME/.agents/skills/devcontainer"
link "claude/skills/dotfiles-sync"         "$HOME/.agents/skills/dotfiles-sync"
link "claude/skills/legibility-audit"      "$HOME/.agents/skills/legibility-audit"
link "claude/skills/new-project"           "$HOME/.agents/skills/new-project"

# --- loop (loop-engineering toolkit; `loop campaign` is the script sibling
#     of the claude/skills/ailoop skill) ---
# Runs under bun (the dashboard is Ink/JSX — bun transpiles .tsx natively, no
# build step). Deps live in loop/node_modules, resolved from the symlink's
# realpath, so the ~/.local/bin link needs nothing beside it.
link "loop/src/index.ts" "$HOME/.local/bin/loop"
if command -v bun >/dev/null 2>&1; then
  (cd "$DOTFILES_DIR/loop" && bun install --silent)
  echo "deps   loop/node_modules (bun install)"
else
  echo "skip   loop deps  (bun not found — install bun, then re-run)"
fi

# --- Shell ---
# Uncomment as you populate. Pick the shell(s) you actually use.
# link "shell/.zshrc"          "$HOME/.zshrc"
# link "shell/.bashrc"         "$HOME/.bashrc"
# link "shell/.shell-config.sh" "$HOME/.shell-config.sh"

# --- Git ---
# link "git/.gitconfig"        "$HOME/.gitconfig"
# link "git/.gitignore_global" "$HOME/.gitignore_global"

# --- Editor ---
# link "editor/nvim"           "$HOME/.config/nvim"

echo "done."
