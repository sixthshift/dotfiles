---
name: legibility-audit
description: Grade a codebase on how findable and trustable its structure is for a reader with zero memory — "a place for everything, everything in its place" made checkable. Walks the tree hunting misleading names, parallel homes, junk drawers, and files past read-once size; outputs a graded verdict with violations ranked by navigation cost. Reports only — never refactors. Use when asked to audit structure, legibility, or findability, or "how does this repo stack up".
---

# Legibility Audit

Grade the repo's structure against a single reader model: **someone with zero memory of it** — the author two years later, or an agent at session start. Structure is good exactly insofar as it lets that reader load only what's relevant and trust it's complete.

The judgment layer lives in `voice/coding.md` (ambient via CLAUDE.md) — this file is procedure only; cite the voice for rationale, don't restate it. This audit checks honesty *at rest* (does the structure tell the truth). Correctness, runtime honesty (fail-loud, boundary validation), and style are out of scope — those belong to code review and typecheck.

## The checks

Each is a question with a falsifiable answer, not a preference:

1. **Guess-the-path.** Location must be a function of purpose: pick ~10 concerns from the domain vocabulary, guess each file path *before* looking, score the misses. Depth is free when each segment narrows the guess; depth that doesn't narrow is noise.
2. **One home per concern.** Found once must mean found all. Canonical violation: parallel directories for the same kind of thing (two homes for hooks, two for helpers). The cost isn't slow search — it's confidently editing one of two homes believing you've seen both.
3. **Names must not lie.** Worst defect class: a misleading name sends the reader confidently in the wrong direction (e.g. `format.ts` sitting beside `format-v2.ts` but holding a default constant, not the legacy version). Generic names (`utils`, `helpers`, `common`, `misc`, proliferating bare `index`) are the lesser form — they force opening the file to learn what the name should have said.
4. **Read-once sizing.** Split by semantics, not line count — a long file that is genuinely one concern passes. But past read-at-once size (~500 lines as a flag, not a law) the reader greps-and-windows and loses surrounding invariants; section-comment banners are a confession the file holds several concerns.
5. **Single sources of truth.** Registries and contract files that answer a whole category in one read are worth more than perfect placement of the same knowledge scattered. Their absence for a repeated concern is a finding.
6. **The index tells the truth.** CLAUDE.md / README pointers are the highest-leverage lines in the repo — they convert searches into direct reads. Check them against the actual tree; a stale index is a misleading name at repo scale.

## Procedure

1. **Map before territory.** Read the index docs first (CLAUDE.md, README, architecture notes). The audit later verifies them against the tree — note claims as you read.
2. **Census.** Full file list (`find`, skip vendored/generated) + line counts sorted descending. Flag: size outliers, generic names, barrel/index files, casing or convention splits, sibling names that look like versions or duplicates of each other.
3. **Guess-test** per check 1, using domain vocabulary from the index docs.
4. **Open only the suspects.** For each flagged file, read enough (head + structure) to answer its check — name-vs-content for suspected liars, banner-scan for oversized files, both candidates for suspected parallel homes. Do not read the whole repo; the audit models a navigating reader, not an exhaustive one.
5. **Verify the index** against what the census actually found.

## Output

Decision-order, graded verdict first:

- **Grade** (A–F) with a one-sentence justification.
- **What delivers** — the structures doing the most navigation work (registries, derivable homes), so they're protected, not just the faults.
- **Violations**, ranked by navigation cost (liars > parallel homes > junk drawers/indirection > oversized files > convention splits), each with: what, which check it fails, the concrete cost, and a tag — **fix-now** (cheap, high-traffic) vs **fix-on-touch** (per the migrate-forward rule: adopt when already in the file for another reason).
- **Not checked** — disclose scope skipped (e.g. vendored dirs, generated code), per "disclose the scar".

**Report, don't refactor.** This skill never applies fixes, however obvious — the fix is a separate ask with its own scope.
