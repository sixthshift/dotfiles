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
link "claude/skills"         "$HOME/.claude/skills"
link "claude/agents"         "$HOME/.claude/agents"
link "claude/hooks"          "$HOME/.claude/hooks"
# Uncomment once you've populated it (review the file first):
# link "claude/settings.json"  "$HOME/.claude/settings.json"

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
