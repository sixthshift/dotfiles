---
name: ailoop
description: >-
  Drive a locked build spec to completion through a fully autonomous,
  self-terminating engineering loop. You act as the judging COORDINATOR:
  extract an executable oracle from the spec, drive each phase with
  deterministic Workflow bodies (parallel worker agents in git worktrees →
  merge → re-gate), judge results, and stop only when the oracle is green or
  the loop is genuinely stuck. Use when the user wants to build out a defined
  spec end-to-end with minimal supervision — "run the loop", "autonomously
  build this spec", "drive this to done". NOT for one-off edits or tasks
  without a locked spec and a machine-checkable definition of done.
---

# ailoop — autonomous build-loop coordinator

You are the **coordinator** of a fully autonomous engineering loop. Someone has
handed you a *locked* build spec (over-specified on purpose so no decision
stalls the build) and asked you to drive it to done without supervising each
step. Your job is not to write the app — it is to **orchestrate and judge**.

Read this whole file before acting. The value of this skill is discipline, not
speed: a loop with a fuzzy oracle either never terminates or terminates on
vibes and hallucinates completion. Most of your IP is the guards.

## The mental model — two layers

An autonomous build loop has two kinds of work that want opposite things. Never
collapse them into one.

| | **Outer loop — coordination (you)** | **Inner body — execution (Workflow)** |
|---|---|---|
| Job | Which ticket is ready? Is its acceptance met? Is it too big? Are we drifting or stuck? | Build this ticket. Verify it. Report a structured result. |
| Wants | **Judgment** — pick the next ticket, interpret failures, decide retry vs. decompose vs. escalate | **Determinism** — reproducible build, verify-gate, no improvisation |

- **The backlog drives the loop.** You do not work off the spec directly. At
  intake you seed `.ailoop/backlog.md` — a dependency-ordered queue of
  self-contained tickets — from the spec, and from then on the loop *is* "pull
  the next ready ticket, dispatch it, verify it, update the backlog." See
  **The backlog** below; it is the center of this skill.
- **You (the coordinator)** are the main loop executing this file. Within one
  autonomous turn you pull ready tickets, dispatch them (a single subagent, or a
  Workflow fanning out a batch of independent ones), wait for the
  `<task-notification>`, read the structured result, judge, update the backlog,
  and pull the next — over and over — until the backlog is drained or you stop
  and report. That *is* "full run, report at end."
- **Each ticket is built by a fresh subagent.** One ticket = one cold subagent
  with no memory of this conversation. That is deliberate: it bounds context and
  makes progress durable. It also sets the ticket-quality bar (see the schema).
- **Batches of independent ready tickets** fan out via a `Workflow` (see
  `templates/build-phase.workflow.js`): one worker per ticket in its own git
  worktree, then merge, then gate. Deterministic, backgrounded, resumable.

You do **not** need the `loop` skill for a single drive-to-done. `loop` is for
interval/recurring re-invocation; a continuous autonomous build is just you
calling Workflows in sequence.

## Prime directives (non-negotiable)

1. **Oracle before build.** Never start a phase whose "done" is not
   machine-checkable. If the spec doesn't give you one, stop and ask the human
   to supply it. This is the *only* interruption allowed in a full run, and it
   happens at intake — before the drive, never during.
2. **Trust the oracle, not the builder.** A worker reporting "done" is a claim,
   never a result — at every level. Per ticket, an **independent re-verify**
   (baseline + acceptance), not the builder's self-report, is what counts; per
   phase, only a **merged-tree** oracle result counts (per-worktree green is not
   integration-green). See **Verification**.
3. **Stop before you thrash.** Hard caps on iterations and token budget.
   Escalate to the human with a diagnosis rather than burning the budget on a
   wall you keep hitting.
4. **Stay in scope.** The spec's out-of-scope list is a tripwire, not a
   suggestion. If a phase's output crosses it, halt and report.
5. **Every ticket is cold-start runnable.** A ticket a fresh subagent can't
   complete from its own text is a bug in the ticket, not the subagent. Enrich
   or decompose it before dispatch — never hand a worker a ticket that leans on
   context only you hold.

---

## The backlog — the loop's driver

`.ailoop/backlog.md` is the heart of this skill. It is a dependency-ordered
queue of tickets. The loop is nothing more than: **pull the next ready ticket →
dispatch → verify → update the backlog → repeat.** Everything else serves this.

Why backlog-driven and not phase-driven:
- When you plan, you find *many* things to do at once. You cannot hold them all
  in one context and work them all — you'd pick one and lose the rest. The
  backlog is where the rest live so nothing is dropped and ordering is explicit.
- Work is **decomposable on demand.** A ticket that turns out too big becomes
  several child tickets pushed back onto the backlog — so no single context ever
  rots trying to do too much. This is the primary defense against context rot.
- The backlog is durable state. It survives compaction and is the resume anchor:
  the loop's position is *"what's the next ready ticket,"* not your memory.

### Ticket schema

Each ticket carries everything a cold subagent needs — no reliance on the
coordinator's in-context knowledge:

```
### T017 — Add POST /session login endpoint    # id + one-line title
status:     ready                              # todo | ready | in-progress | blocked | done | decomposed
depends_on: [T003, T009]                       # ticket ids that must be done first
files:      [src/server/auth.ts, src/server/routes.ts]    # expected touch set → parallelism scheduler
context: |                                     # THE load-bearing field: self-contained brief
  Spec §4.2 defines the request/response shape; §4.5 the token rules (frozen).
  Locked (cite oracle.md): bcrypt hashing, 15-min token TTL.
  Already exists: User model (T003), db access layer (T009).
  Build ONLY this endpoint: validate credentials, issue a session token.
acceptance: |                                  # the ticket's OWN oracle (checkable)
  - <project type-check command> passes
  - POST /session with valid creds → 200 + token; with bad creds → 401
evidence:                                      # filled on completion (proof, not claims)
```

- **`depends_on` + `files`** together are the scheduler. **Ready** = all deps
  `done`. Among ready tickets, disjoint `files` → safe to fan out in worktrees;
  overlapping `files` → serialize.
- **`context`** must let a subagent that has never seen this conversation
  succeed. If you can't write it self-contained, the ticket is too big or too
  vague — decompose or sharpen it.
- **`acceptance`** is the ticket-local oracle — its bespoke behavioral checks,
  *on top of* the mandated baseline (type-check/build/lint/tests) every ticket
  clears (see **Verification**). It is narrower than the phase oracle
  (`oracle.md`); passing every ticket (baseline + acceptance, independently
  re-verified), then the phase oracle on the merged tree, is what closes a phase.

### Decomposition (the anti-rot move)

Splitting happens at two moments:
1. **At planning** — you break the spec's phases/epics into tickets each sized
   to one focused subagent session. Err small.
2. **Mid-flight** — a dispatched subagent may find its ticket is bigger than one
   session. It returns `{ tooBig: true, proposedTickets: [...] }` **instead of**
   a half-finished build. You mark the parent `decomposed`, push the children
   (with dependencies) onto the backlog, and continue. Never let a worker grind
   a too-big ticket to context exhaustion.

### Rules

- New tickets are **appended and ordered by dependency**, not by whim. Record
  why a ticket exists (which spec section or which parent it decomposed from).
- A ticket is `done` only when its `acceptance` passed *and* `evidence` is
  filled with the actual check output.
- The backlog is append-mostly: don't delete tickets, mark them `done` /
  `decomposed`. The history is part of the audit trail.

---

## Verification — what every ticket must clear

"Trust the oracle, not the builder" applies at the **ticket** level, not just at
phase close. A ticket is `done` only when an **independent** check — never the
builder's self-report alone — confirms three things:

1. **Baseline (every ticket, no exceptions).** The project's standing quality
   gate, defined once in `oracle.md` and applied to *every* ticket regardless of
   what it touched:
   - type-check / compile clean
   - build succeeds
   - lint clean (if the project lints)
   - **the full existing test suite passes** — this is the regression guard, and
     it is how a ticket that breaks a previously-green one is caught
     *immediately*, not at phase close.
   Detect the exact commands from the project's manifest at intake (Stage 1.0).
2. **Ticket acceptance.** The ticket's own behavioral checks (its `acceptance`
   field), with captured output as evidence.
3. **New tests for new behavior.** A ticket that adds behavior must add tests
   covering it, green under the baseline — this is how the regression net grows
   as the build proceeds. Exempt only pure scaffold/config tickets with no
   behavior to test, and say so in the ticket.

The builder runs all three itself and returns the evidence — but its word is a
**claim**. The authoritative signal is the **independent re-verify**: a separate
agent (or you) re-runs baseline + acceptance on the ticket's tree before the
ticket is accepted. In the fan-out Workflow this is a dedicated Verify stage per
ticket, run on the worker's worktree *before* integration; for a single-ticket
dispatch, you re-run it yourself.

Three gates, widening — a ticket must pass the narrow one to earn the next:

**baseline + acceptance (independently re-verified, per ticket) → integration
(merge clean) → phase oracle (merged tree).**

A ticket that regresses the baseline is a **failed** ticket even if its own
acceptance passes.

---

## Stage 1 — Intake & Oracle Contract

Do this once, up front. Produce `.ailoop/oracle.md`, `.ailoop/backlog.md`, and
`.ailoop/ledger.md` (templates in `templates/`). This is the pre-flight; the
human sees it and the drive runs unattended after.

0. **Locate the spec.** Use the path the user gave. Otherwise look for a locked
   build spec in the repo root or `docs/` (`spec.md`, `SPEC.md`, `PLAN.md`, or
   similar). If none exists, or several plausible candidates do, **stop and ask**
   — do not guess which document is the contract. Also detect the project's own
   toolchain (type-check / test / build commands, package manager) from its
   manifest; the oracle's checks must use *this* project's commands, not
   assumed ones.

1. **Read the entire spec.** Extract, verbatim where possible:
   - **Build order / phases.** Respect the spec's own phasing and de-risk order
     — do not invent your own plan. (A good spec puts the riskiest phase first;
     honor that.)
   - **Locked decisions.** Stack, data model, architecture, "do not add X"
     lists. These are frozen — workers must never re-litigate them. Copy them
     into the oracle doc so every worker prompt can cite them.
   - **Out-of-scope list** → the scope tripwire.

2. **Derive the per-phase oracle.** For each phase, write the *executable*
   checks that mean "this phase is done." Each check is a command with an
   expected result, or a scripted acceptance test. Prefer, in order:
   - build/type-check passes (e.g. `bun run check`),
   - the service boots and a health endpoint responds,
   - a **behavioral** acceptance test the spec names explicitly (the sharpest
     kind — e.g. "given these 3 contrasting inputs, the output must differ in
     *this* way"). Write it as a runnable harness, not a vibe.

   Also record the **baseline gate** in `oracle.md` — the type-check / build /
   lint / full-test-suite commands (from Stage 1.0's toolchain detection) that
   *every* ticket must pass regardless of what it touches (see **Verification**).

3. **The refuse-to-start gate.** Stop and ask the human if either:
   - a phase's oracle is not executable **as written** (hand-wavy / no runnable
     check) — a full autonomous run with a fuzzy oracle is the single most
     dangerous configuration this skill can be in; **or**
   - the oracle is well-defined but its **environment preconditions aren't
     met** — the checks can't actually run here. Probe these at intake: required
     API keys/secrets, network access, a git repo (worktree fan-out needs one),
     runtimes/toolchain, and any runtime discrepancy between the spec's locked
     stack and what's installed. A verifiable-in-principle oracle you cannot run
     *now* is not a green light.

4. **Seed the backlog.** Turn each phase into tickets on `.ailoop/backlog.md`,
   each sized to one focused subagent session and written cold-start runnable
   (full schema above). Wire `depends_on` so the graph encodes the spec's
   de-risk order — the riskiest phase's tickets come first and downstream
   tickets depend on them. Err small; you will decompose further mid-flight
   anyway. Do **not** try to enumerate every ticket for late phases perfectly —
   seed them coarsely and refine as earlier tickets teach you the shape.
5. **Set the caps.** Per-ticket max attempts (default 3), whole-run token
   budget (ask the user or default to a conservative ceiling), and a thrash
   threshold (a ticket's failing acceptance set doesn't shrink across 2
   attempts → escalate). Record them in the ledger.

Report the intake to the user as a short pre-flight: the phase→oracle map, the
seeded backlog (ticket count + the first few ready tickets + the dependency
spine), the caps, and any oracle you had to ask them to supply. Then drive.

---

## Stage 2 — The Drive

Work off the backlog. One turn of the loop:

### 2.1 Pull ready tickets
A ticket is **ready** when every `depends_on` ticket is `done`. Select the
ready set. If it's empty and tickets remain, you have a dependency cycle or a
blocked ticket → escalate. If both the ready set and the backlog are empty →
you're done (go to Termination).

Among the ready set, group by **file disjointness**:
- Tickets with **disjoint `files`** → dispatch as a parallel batch.
- Tickets that **share files** → serialize (run one, re-evaluate readiness).

### 2.2 Dispatch
- **Single ticket** → one `Agent` subagent. Its prompt is the ticket's
  `context` + `acceptance` + the baseline gate + the frozen locked decisions. It
  must build, add tests for new behavior, then run baseline + acceptance and
  return the captured output. Then **you re-verify** (re-run baseline +
  acceptance) before accepting — its self-report is only a claim.
- **A disjoint batch** → the `build-phase` Workflow (see the template): one
  worker `agent()` per ticket, each `isolation: 'worktree'`, then a per-ticket
  **Verify** stage on each worktree, then **merge** the verified ones, then gate
  on the merged tree.

Every worker is instructed to return one of:
- `{ done: true, evidence }` — built it, **added tests for new behavior**, ran
  the **baseline (type-check/build/lint/tests) + acceptance**, output attached;
- `{ tooBig: true, proposedTickets: [...] }` — the ticket is bigger than one
  session; here is the proposed split (it did **not** half-build it);
- `{ blocked: true, reason }` — it hit a missing dependency or contradiction in
  the spec.

Wait for the `<task-notification>`. Never assume a worker succeeded.

### 2.3 Judge each result
The judgment the inner body cannot do:
- **`done` + independent re-verify green (baseline + acceptance) + in scope** →
  mark the ticket `done`, paste the **re-verify** evidence, update the backlog.
  This may unblock downstream tickets. (The worker's own report never suffices —
  the independent re-verify is the signal.)
- **re-verify red** — acceptance failed, OR the ticket **regressed the baseline**
  (broke type-check/build/a previously-green test) even though its own acceptance
  passed → the ticket failed. Diagnose *why* using the spec — many specs tell you
  where to look (e.g. "if the behavior doesn't flip, the prompt is wrong, not the
  code"). Form a specific hypothesis and re-dispatch with a targeted fix note.
  Increment the ticket's attempt count.
- **`tooBig`** → mark the parent `decomposed`, push the proposed child tickets
  onto the backlog with dependencies, refine their `context`/`acceptance` so
  each is cold-start runnable, continue. This is expected and healthy, not a
  failure.
- **`blocked`** → if the missing dependency is a ticket you can order, add/fix
  the edge and requeue. If it's a genuine spec contradiction, escalate.
- **Merge conflicts** (batch) → resolve if trivial and obvious; otherwise treat
  as a failed batch and re-dispatch the conflicting tickets serially.
- **Scope tripwire hit** → halt, report; do not "fix" it by building more.

After integrating a batch or a phase's worth of tickets, run that **phase's
oracle** from `oracle.md` on the merged tree — the ticket-local checks are
necessary but the phase oracle is what actually closes a phase.

### 2.4 Enforce the caps (before every re-dispatch)
- attempts for this ticket ≥ max, **or**
- the ticket's failing acceptance set hasn't shrunk across the thrash
  threshold, **or**
- `budget.remaining()` is below what a ticket costs
→ **stop and escalate**: the ticket, its last acceptance result, your best
diagnosis of the wall, and the specific human decision you need. Do not loop
again on that wall.

Then loop back to 2.1.

---

## Termination & report

Stop when the **backlog is drained and every phase oracle is green**, or you
escalate. Then write a final report to the user:
- **Shipped:** what was built, keyed by phase / ticket.
- **Oracle evidence:** the passing check output per phase (the proof, not your
  say-so).
- **Backlog history:** tickets completed, and any that were decomposed — the
  shape of the work, honestly.
- **Cut / deferred:** anything the spec deferred or you consciously left out.
- **Drift caught:** scope tripwires, retries, decompositions, walls hit — plain,
  not smoothed over.

If you escalated, the report is "stuck at ticket T, here's the wall and the
decision I need" — never a rosy summary of a loop that didn't finish.

---

## Durable state — three files, three jobs

All under `.ailoop/`. Trust these files over your recollection; they are what
survives context compaction and anchors resume.

- **`backlog.md`** — the **forward** state and the loop driver: the ordered
  ticket queue with status. "Where is the loop?" is answered by "what's the next
  ready ticket," never by memory.
- **`oracle.md`** — the frozen **definition of done**: locked decisions, the
  scope tripwire list, and the executable per-phase acceptance checks. Written
  once at intake; workers cite it; you gate against it.
- **`ledger.md`** — the append-only **journal**: attempt counts, budget spent,
  every judge decision and why, decompositions, drift flags, escalations. The
  audit trail — how the loop got where it is.

Update `backlog.md` after every ticket outcome and `ledger.md` after every
judge decision.

## Guards checklist (re-read before each dispatch)

- [ ] The ticket is cold-start runnable (self-contained `context`).
- [ ] Its `acceptance` is executable (not vibes).
- [ ] Worker ran the baseline (type-check/build/lint/full test suite) + acceptance.
- [ ] New behavior has new tests, green under the baseline.
- [ ] **Independent re-verify** passed (not the builder's word) and the ticket
      did not regress the baseline.
- [ ] Workers cite locked decisions; none re-litigated.
- [ ] Ready set correct (all `depends_on` truly `done`); batch is file-disjoint.
- [ ] Only merged-tree checks count as green; phase oracle run before closing a phase.
- [ ] Attempt and budget caps enforced before every re-dispatch.
- [ ] Failing set is shrinking; if not for 2 attempts → escalate.
- [ ] Nothing built crosses the out-of-scope list.
- [ ] `backlog.md` and `ledger.md` updated.

## Scope of this skill

- **v1 is one continuous run.** Workflow `resumeFromRunId` handles mid-phase
  crashes. Cross-session durability (wrapping the drive in `loop` + a durable
  ledger) is a deliberate later addition, not v1.
- **Fully autonomous after intake.** The only human touch during a healthy run
  is reading the pre-flight and the final report. Everything else is escalation,
  which by definition means the loop couldn't proceed safely.
