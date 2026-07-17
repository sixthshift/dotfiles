---
name: ailoop-codex
description: Drive a locked aispec build specification to completion inside Codex using durable .ailoop state, Codex worker and verifier subagents, isolated Git worktrees, mechanical gates, bounded retries, and phase-level acceptance. Use when the user asks Codex to "run the loop", "run ailoop-codex", autonomously build a locked spec, or resume an interrupted Codex build campaign. Do not use for draft specs, one-off edits, or the Claude Workflow-based ailoop skill.
---

# AI loop for Codex

Coordinate the build; do not become the builder. Turn the locked spec into a
machine-scheduled backlog, delegate one cold worker per ticket, independently
verify every result, and continue until every phase oracle is green or a real
wall requires the human.

This is the Codex execution adapter for the contract produced by `aispec`.
Claude's `ailoop` remains a separate Workflow-based skill and is not available
through the Codex skill set.

## Non-negotiable invariants

1. **Oracle before spend.** Refuse a draft, ambiguous acceptance, missing
   environment precondition, or non-executable phase oracle before dispatch.
2. **Durable state owns the run.** `.ailoop/backlog.json`, `oracle.md`, and
   `ledger.md` are authoritative. Update them before starting the next turn.
3. **Cold workers build; the coordinator judges.** Give each worker a complete
   ticket brief. Never accept its self-report as verification.
4. **Isolation is explicit.** One ticket attempt gets one branch and one Git
   worktree. Tell the worker its exact worktree and forbid edits elsewhere.
5. **Mechanical facts stay mechanical.** Use `schedule.mjs` for readiness and
   breach detection and `verify.mjs` for checks, scope, cleanliness, and diffs.
6. **No silent fallback.** Do not switch to Claude, invoke Claude's `ailoop`, or
   build tickets in the coordinator when Codex delegation fails.
7. **Stop before thrash.** Maximum three attempts per ticket; two consecutive
   attempts whose failing-check set does not shrink are a wall.
8. **One invocation drives to a terminal state.** Length and context compaction
   are not stopping conditions. Resume from disk after interruption.

## Canonical resources

The Claude copy is the master for shared state formats and deterministic
scripts. Resolve it through the installed path:

```text
~/.claude/skills/ailoop/templates/
```

At first intake, copy these into `.ailoop/`: `backlog.json`, `ledger.md`,
`oracle.md`, `schedule.mjs`, `verify.mjs`, and `report.mjs`. Do not copy the
Claude-only `build-phase.workflow.js`, `timing.mjs`, or Codex relay schema.

If the master path is absent, stop and ask the user to run the dotfiles
installer. Do not reconstruct the schemas from memory.

## Stage 0: preflight or resume

Require Git, Node 18+, a non-detached branch, and a clean working tree. Refuse
to hide, stash, discard, or absorb pre-existing changes: worktrees start from
`HEAD`, so an unclean baseline would make the campaign misrepresent its input.

Then choose exactly one path:

- `.ailoop/` exists: resume. Run the scheduler, reconcile stale `in-progress`
  tickets against their recorded branches/worktrees, recompute the spec hash,
  and append a `resume` ledger event. A changed spec requires the aispec
  change-order path before dispatch.
- `.ailoop/` absent: locate the single `status: locked` spec under `specs/` or
  use the path the user supplied. Several locked specs require a user choice;
  none is a refusal.

## Stage 1: intake

First run a read-only contract gate over the spec. Every phase must already
contain an exact command/expected result or concrete input→output behavior, and
every required environment dependency must be named. If not, stop before
creating `.ailoop/` or any branch and ask for the missing contract.

After that gate passes, before spawning a builder:

1. Copy the canonical resources and create `.ailoop/evidence/` and
   `.ailoop/worktrees/`.
2. Record the spec path, version, and SHA-256 in `oracle.md` and `ledger.md`.
3. Detect the repository's real fast checks and slow gate checks. Probe them on
   the untouched baseline. A red baseline is an intake failure unless the spec
   explicitly owns that failure.
4. Copy locked decisions and the out-of-scope list into `oracle.md` verbatim.
5. Turn every phase requirement into executable acceptance only when the spec
   supplies the exact command/expected result or concrete input→output behavior.
   Never invent examples, thresholds, or assertions to make vague acceptance
   executable; refuse and ask the human for the missing behavior instead.
   Mirror the fast checks into `backlog.json.fastChecks`.
6. Seed dependency-ordered tickets. Every live ticket must declare a non-empty,
   honest file footprint, complete cold-start context, runnable acceptance
   checks, and its originating spec section.
7. Fill the coverage map from every spec requirement to a ticket or oracle
   check. Silence is not deferral.
8. Spawn one read-only verifier subagent with only the locked spec and proposed
   oracle. Ask it to find gameable checks, uncovered requirements, guessed
   intent, and non-executable acceptance. Sharpen the artifacts from evidence;
   do not delegate the final intake decision.
9. Run `node .ailoop/schedule.mjs`. Any problem, cycle, empty footprint, or
   unexplained missing edit-target is a refusal to start.

Append the stamped `intake` ledger entry only after the gate passes.

## Stage 2: drive tickets

Repeat this sequence without a dispatch-count limit.

### 2.1 Schedule

Run `node .ailoop/schedule.mjs` and trust its JSON. Escalate on cap/thrash
breaches or a blocked graph. If a phase is drained, run its phase-close gate
before scheduling later-phase work.

Take the first file-disjoint batch. Use at most three workers concurrently so
the coordinator and an independent verifier retain capacity. A single ready
ticket is still delegated.

### 2.2 Create isolated attempts

For each ticket, record the fork SHA, create a uniquely named `ailoop/` branch,
and add a worktree below `.ailoop/worktrees/`. Mark the ticket `in-progress`
and append a stamped `dispatch` event before spawning.

Give the Codex `worker` subagent:

- the absolute worktree path and a command to confirm it before editing;
- the ticket object, its governing spec excerpts, locked decisions, and scope
  tripwire;
- the exact baseline and ticket acceptance commands;
- the instruction to touch only declared files plus dependency manifests;
- the instruction to add tests for changed behavior, commit all work on the
  attempt branch, leave a clean tree, and return commit SHA plus evidence;
- the instruction to return `tooBig` with proposed child tickets before coding
  when the ticket cannot be completed safely as one unit.

Workers must not modify `.ailoop/`, merge, inspect sibling worktrees, or change
the spec. Agent launch failure is infrastructure failure: preserve state and
escalate instead of building in the main thread.

### 2.3 Verify independently

After a worker completes, run from the main checkout:

```text
node .ailoop/verify.mjs --ticket <id> --dir <worktree> --base <fork-sha>
```

Then spawn a fresh read-only verifier subagent with the ticket, oracle,
mechanical JSON result, and generated diff/evidence paths. Ask only whether the
patch games the checks, violates a locked decision, misses behavior, or crosses
scope. The verifier must not edit or repair.

Accept only when the mechanical verifier is green and the independent read is
clean. Capture the verdict in `.ailoop/evidence/<id>.verify.json` while the
evidence is available.

### 2.4 Judge the result

- **Accept:** merge the branch sequentially into the campaign branch, rerun the
  fast gate on the merged tree, mark `done`, record evidence, and append an
  `accept` event. Only then remove the run-created worktree and delete its
  fully merged attempt branch.
- **Retry:** record the stable failing-check names, evidence pointer,
  hypothesis, and targeted fix note in `attempts`; mark `todo`; remove only the
  failed run-created worktree; dispatch the next attempt from current `HEAD`.
- **Decompose:** mark the parent `decomposed`, add smaller dependency-correct
  children with non-overlapping ownership where possible, rewire dependents,
  update the coverage map, and append a `decompose` event.
- **Conflict after parallel work:** abort the merge, preserve the branch, and
  create an integration-repair ticket. Resolve only manifest/lockfile union
  mechanically; semantic overlap means the original footprints were false and
  must be corrected before more parallel dispatch.
- **Blocked, drift, cap, or thrash:** append `escalate`, preserve every branch
  and artifact, and ask one concrete decision. Never delete unmerged work.

## Stage 3: close phases

When the scheduler reports a drained phase, run every phase acceptance command
and slow gate on the merged campaign tree. Independently inspect whether the
implementation satisfies the phase's behavioral contract rather than merely
the commands.

A red phase creates repair tickets attributed to the checks that let the defect
escape. Strengthen those checks as part of the repair. Close the phase only on
a fully green merged tree and append `phase-close`.

Oracle amendments are allowed only for mechanical mistakes such as a misspelled
command or stale path, with evidence and an `amend` ledger entry. Any change to
what behavior counts as done is a spec change order and requires the human.

## Stage 4: terminate

Completion requires all of the following:

- scheduler reports `complete: true` with no problems or breaches;
- every phase has a stamped `phase-close` event after its last accepted repair;
- the coverage map accounts for every spec requirement;
- final fast and slow gates pass on the merged campaign tree;
- no run-created worktree contains uncommitted or unmerged work.

Before cleanup, run `.ailoop/report.mjs` with `--out` to write a report beside
the spec, stamp the spec `status: done`, and append the final ledger event.
Then remove only fully merged worktrees/branches created by this run and delete
`.ailoop/`. Report the merged commits, checks, phase outcomes, residual flakes
or limits, and the report path. Do not push.

## Escalation contract

Escalate only for missing intent or authority, changed locked input, unavailable
delegation, baseline/environment failure, out-of-scope work, cap/thrash breach,
or unresolvable integration conflict. State:

1. the exact wall and evidence;
2. what remains safely preserved;
3. the smallest human decision needed to resume.

Anything else is loop work: diagnose it, create or retry a ticket, and continue.
