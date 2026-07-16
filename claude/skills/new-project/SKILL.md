---
name: new-project
description: Scaffold a fresh Bun/TypeScript project end-to-end, wiring the pieces I always want and the one I keep forgetting — the project-level TypeScript LSP for Claude. Orchestrates bun init, the LSP gate, a project CLAUDE.md stub, the devcontainer skill, and an optional aispec handoff. Use when starting a new project from scratch.
---

# New Project Scaffold

The front door for a new repo. It exists for one reason above the others: **the project-level TypeScript LSP config keeps getting dropped when I create projects by hand.** Everything else here is glue that guarantees that step is never skipped again.

This is an **orchestrator, not a template dump**. The stack skeleton comes from `bun init` (idiomatic, self-updating); the devcontainer comes from the `devcontainer` skill. This skill owns only the Claude-layer glue and the sequencing.

Assumes a **Bun/TypeScript** project. For other stacks, this skill doesn't apply — scaffold by hand.

## The payload: project-level LSP

The whole point. Written to the project's `.claude/settings.json` so it's committed and applies to everyone who clones — not an env var living on one machine:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ENABLE_LSP_TOOL": "1"
  }
}
```

**Why this mechanism, definitively (verified against the installed binary, v2.1.211):**

- `ENABLE_LSP_TOOL` (singular) is the real feature gate — confirmed present in the binary. Set to `"1"`, it activates Claude Code's LSP tool (goToDefinition, findReferences, diagnostics, hover); with the gate on and a language-server binary on PATH, the server is auto-detected. No plugin, no `.lsp.json`.
- **Not** `ENABLE_LSP_TOOLS` (plural) — that string appears nowhere in the binary and is a silent no-op. (The `devcontainer` skill historically used the plural; treat that as a bug to fix, not a precedent.)
- **Not** the `typescript-lsp@claude-plugins-official` plugin — it has a known registration bug ([#16291](https://github.com/anthropics/claude-code/issues/16291), closed "not planned"). The env gate is the reliable path.

The gate turns the tool on; the **binary** is the separate prerequisite the skill can't install into the repo (step 4).

## Procedure

### 1. Confirm target

- Target directory and project name (default: directory basename). These feed `bun init` and the container names downstream.
- If the directory is already a git repo with a `package.json`, this is not a fresh project — stop and ask whether the user wants the individual steps (LSP wiring, devcontainer) applied to the existing repo instead.
- `git init` if not already a repo.

### 2. Skeleton via `bun init`

Run `bun init` (accept defaults; pass the project name). This produces `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, and an entry file. Do **not** hand-write these — deferring to `bun init` is deliberate: no template to drift out of sync with the current Bun toolchain.

### 3. Write the LSP gate

Create `.claude/settings.json` with the config block above. If the file already exists (unlikely in a fresh repo), merge the `env.ENABLE_LSP_TOOL` key in rather than overwriting.

### 4. Check the LSP binary

`which typescript-language-server`. If missing, print — do not attempt to auto-install globally:

```
Enable the TypeScript language server (once per machine):
  npm install -g typescript-language-server typescript
```

The env gate is committed to the repo; the binary is a per-machine prerequisite. State plainly if it's absent so the LSP isn't silently dead.

### 5. Seed a project CLAUDE.md stub

Write a minimal `CLAUDE.md` for **project-specific** guidance only. The global `~/.claude/CLAUDE.md` and coding voice already layer on top of every project automatically — do not restate or re-point at them here. A short stub naming the project and any early constraints is enough; leave it thin and let it grow per touch.

### 6. Devcontainer

Invoke the `devcontainer` skill. It handles stack detection, sidecars, and ports on its own, and installs the language-server binary in the image. It also writes/merges the same repo-root `.claude/settings.json` gate — so on a fresh project it just finds step 3's file already there and no-ops. Same home, one source of truth for the gate.

### 7. Offer the aispec handoff

Ask whether to start a spec now via the `aispec` skill (the front of the `aispec` → `ailoop` pipeline), or leave that for later. Don't assume — a new repo isn't always headed straight into a spec.

## Close out

Report: directory scaffolded, LSP gate written, whether the language-server binary was found (and the install line if not), devcontainer result, and whether an aispec session was started. Do not commit — staging and `git commit` are the user's call.
