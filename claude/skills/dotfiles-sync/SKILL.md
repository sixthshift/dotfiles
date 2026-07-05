---
name: dotfiles-sync
description: Sync the dotfiles repo (~/dotfiles) with its remote — commit and push local changes via the commit skill, pull remote changes, or both. Use when asked to sync, push, or pull dotfiles, or after editing anything under ~/dotfiles (including ~/.claude/skills, which symlinks into it).
---

# Dotfiles Sync

Reconcile `~/dotfiles` with `origin/main`. One skill, both directions — the direction is detected from git state, not chosen up front.

Optional argument pins the intent:
- `pull` — fetch/merge only; never touch local uncommitted changes.
- `push` — commit and push only; don't merge remote changes unless required to push (diverged).
- (none) — auto: do whatever the state below dictates.

## Context

- Repo: `~/dotfiles`, branch `main`, remote `origin` (GitHub over SSH — repo is public: the secrets gate below is mandatory).
- `~/.claude/skills` symlinks to `claude/skills/` inside this repo, so this skill syncs itself and its sibling skills. A pull can change skills available to the *running* session — always report skill changes.

## Procedure

### 1. Assess

```bash
git -C ~/dotfiles fetch origin
git -C ~/dotfiles status --short
git -C ~/dotfiles rev-list --left-right --count main...origin/main
```

Four states: **clean & current** (report "in sync", done), **dirty only** (→ Push), **behind only** (→ Pull), **dirty and/or ahead + behind** (→ Both).

### 2. Pull

Only with a clean working tree:

```bash
git -C ~/dotfiles pull --ff-only origin main
```

Then report what changed (`git diff --stat ORIG_HEAD..HEAD`), calling out anything under `claude/` explicitly — new or updated skills, settings, or CLAUDE.md affect live Claude sessions.

If the tree is dirty and the intent was `pull`: stop and report the dirty files — do not stash or discard on the user's behalf.

### 3. Push

1. **Stage everything**: `git -C ~/dotfiles add -A`. Then show `git status --short` so the user's about to-be-committed set is visible in the transcript.
2. **Secrets gate** (mandatory — the repo is on public GitHub). Scan the staged diff:

   ```bash
   git -C ~/dotfiles diff --staged | grep -nEi 'BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]|github_pat_|sk-ant-|sk-[a-z]{2,}-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|xox[bap]-|password\s*[=:]|secret\s*[=:]|token\s*[=:]|api[_-]?key\s*[=:]'
   ```

   Also flag any staged file named like a secret store (`.env*`, `*.pem`, `*_rsa*`, `*.key`, `credentials*`). On any hit: **stop**, unstage nothing, show the user exactly what matched, and let them decide. False positives happen (e.g. docs mentioning `password =`) — the user overrides, not you.
3. **Commit via the commit skill.** Invoke the `commit` skill — it reads the staged changes, splits them into focused commits if they span concerns, and writes conventional-commit messages matching this repo's history (`feat(skills): ...`, `refactor(claude): ...`). Do not hand-roll commit logic here.
4. **Push**: `git -C ~/dotfiles push origin main`.

This skill is the explicit exception to the "don't auto-commit" rule: invoking it *is* the ask to commit and push.

### 4. Both (diverged, or dirty + behind)

Order: local commits first, then reconcile, then push.

1. If dirty: run Push steps 1–3 (stage, secrets gate, commit) but don't push yet.
2. `git -C ~/dotfiles pull --rebase origin main`.
3. On conflicts: **stop**. Report the conflicted files and both versions' intent — dotfiles conflicts are config-preference decisions, not mechanically resolvable. Leave the rebase in progress for the user (or abort if they ask).
4. Clean rebase → `git push origin main`.

### 5. Report

Always end with: direction(s) taken, commits created (messages), what was pulled (files, with `claude/` changes highlighted), and current state (`in sync with origin/main`).
