---
name: commit
description: Analyze staged changes and create focused commits. If changes span multiple concerns, break them into separate logical commits.
---

# Commit

Analyze staged changes and create focused commits. If changes span multiple concerns, split them into separate logical commits.

## Execution model

> **If you are the subagent** (you were told to "perform the Procedure section"), skip straight to `## Procedure` — the rest of this section is not for you.

Committing is mostly mechanics plus one judgment call (the split decision and message quality). Run it in one subagent so it does not consume the main thread, then stop and relay.

- **Claude:** use one general-purpose Agent on Sonnet.
- **Codex:** use one `worker` subagent inheriting the current model and permissions.
- Prompt it to read the installed `commit/SKILL.md`, perform only its Procedure against the current repository, preserve any user-supplied invocation arguments, follow the coding-voice commit conventions, and report which files went into which commit.

Do not run any git commands yourself. After the subagent returns, relay its file→commit summary.

## Procedure

### Step 0: Defer to a project skill if one exists

This is a user-level (global) skill, which takes precedence over a project skill of the same name. If the current project defines its own `commit` skill, that one is more specific and should win.

Check for a project-level commit skill at `.agents/skills/commit/SKILL.md` or `.claude/skills/commit/SKILL.md` relative to the project root. Prefer the current agent's native location if both exist. If one exists, **read it and follow its instructions instead of the rest of this file**, then stop. Do not re-invoke `commit` through the skill selector; read the project file directly to avoid a resolution loop.

If no project skill exists, continue with the steps below.

### Step 1: Capture original state

1. Run `git status` to see the working tree.
2. Run `git diff --staged --name-only` to get the list of originally staged files. **Save this list** — only these files should be committed by the end.
3. Run `git diff --staged` to read the full staged changes.

If nothing is staged, stop and ask what to commit.

### Step 2: Analyze for split

Decide whether this is one commit or several.

**Signs to split:**
- Changes touch unrelated parts of the codebase (e.g., backend + frontend + docs)
- Multiple logical units (feature + refactor + bug fix bundled together)
- Different conventional-commit scopes

**Keep as one commit if:**
- All changes serve a single purpose
- Changes are tightly coupled (a refactor and the test updates that support it)
- Splitting would create broken intermediate states

If the user provided arguments (e.g., "single" or "don't split"), respect them.

### Step 3: Execute commits

Proceed without asking for approval. For each commit:

1. `git reset HEAD` to unstage everything (only before the first commit, after the initial capture).
2. `git add <specific files>` for only that commit's files. Verify with `git diff --staged --name-only`.
3. Create the commit. Use a HEREDOC for the message to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
type(scope): subject line

Optional body explaining the why.
EOF
)"
```

4. Repeat for the next commit if splitting.

Order matters: prefer fixes and preconditions before the features that depend on them.

### Step 4: Verify

1. Run `git status` to confirm no originally-staged files remain uncommitted.
2. Run `git log --oneline -N` to show the commits created.
3. Report which files went into which commit.

## Safety rules

- Only commit files that were in the original `git diff --staged --name-only`. Never silently add others.
- Use specific file paths with `git add` — never `git add .` or `git add -A`.
- Never `git commit -a` — only commit what was explicitly staged.
- Never amend an existing commit unless the user explicitly asked. Create new commits when fixing.
- Never skip hooks (`--no-verify`) unless the user explicitly asked.
- Don't push after committing unless asked.
- Watch for secrets (`.env`, `credentials.json`, `*.pem`, `*.key`). If staged, stop and warn before committing.
- Each commit should be buildable/valid on its own when possible.

## Commit message format

Conventional commits: `type(scope): description`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`

- Keep the subject line under 72 characters
- Use imperative mood ("add", not "added"; "fix", not "fixed")
- Focus on WHY, not WHAT — the diff already shows the what

If the change has context worth keeping (rationale, constraint, rejected alternative), add a body separated by a blank line.

## Examples

**Before (one bundled commit):**

```
feat: add user auth, fix navbar bug, update readme, refactor utils
```

**After (split by concern):**

```
feat(auth): add user authentication flow
fix(ui): resolve navbar alignment bug
docs: update readme with auth instructions
refactor(utils): simplify date formatting helpers
```

## Arguments

If the user passed arguments (e.g., "single" or "don't split"), respect them when deciding whether to split. The parent includes them in the dispatch prompt; if it supplies none, there were none.
