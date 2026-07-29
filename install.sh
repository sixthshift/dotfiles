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
link "claude/agents"         "$HOME/.claude/agents"
link "claude/hooks"          "$HOME/.claude/hooks"

# Skills link individually rather than as one directory, because ~/.claude/skills
# has a second supplier: `loop skills install` puts ailoop and aispec there, and it
# refuses to write through a symlinked skills root — installing into this
# repository is exactly what that refusal is for. So the directory stays real and
# each side owns its own entries.
link "claude/skills/commit"           "$HOME/.claude/skills/commit"
link "claude/skills/devcontainer"     "$HOME/.claude/skills/devcontainer"
link "claude/skills/dotfiles-sync"    "$HOME/.claude/skills/dotfiles-sync"
link "claude/skills/legibility-audit" "$HOME/.claude/skills/legibility-audit"
link "claude/skills/new-project"      "$HOME/.claude/skills/new-project"
# Uncomment once you've populated it (review the file first):
# link "claude/settings.json"  "$HOME/.claude/settings.json"

# --- Codex ---
# Claude remains the master copy for shared instructions, voice, and portable
# skills. (aispec reaches ~/.agents/skills via `loop skills install`, not from
# here — it ships with the CLI whose gate defines its contract.)
link "claude/CLAUDE.md"                    "$HOME/.codex/AGENTS.md"
link "claude/voice"                        "$HOME/.codex/voice"
link "claude/skills/commit"                "$HOME/.agents/skills/commit"
link "claude/skills/devcontainer"          "$HOME/.agents/skills/devcontainer"
link "claude/skills/dotfiles-sync"         "$HOME/.agents/skills/dotfiles-sync"
link "claude/skills/legibility-audit"      "$HOME/.agents/skills/legibility-audit"
link "claude/skills/new-project"           "$HOME/.agents/skills/new-project"

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
