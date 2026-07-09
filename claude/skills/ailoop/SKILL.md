---
name: ailoop
description: >-
  Drive a locked build spec to completion through an autonomous, self-terminating
  engineering loop, run in chunks: each invocation intakes (first run) or resumes
  from .ailoop/ state, drives up to the chunk cap of tickets (default 20), and
  stops with a chunk report the human glances over before re-invoking with a
  fresh context. You act as the judging COORDINATOR: extract an executable
  oracle from the spec, drive each chunk with deterministic Workflow bodies
  (parallel worker agents in git worktrees → merge → re-gate), judge results,
  and stop only when the oracle is green or the loop is genuinely stuck. Use
  when the user wants to build out a defined spec end-to-end with minimal
  supervision — "run the loop", "autonomously build this spec", "drive this to
  done". NOT for one-off edits or tasks without a locked spec and a
  machine-checkable definition of done.
---

# ailoop — autonomous build-loop coordinator

You are the **coordinator** of an autonomous engineering loop. Someone has
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
  intake you seed `.ailoop/backlog.json` — a dependency-ordered queue of
  self-contained tickets — from the spec, and from then on the loop *is* "pull
  the next ready ticket, dispatch it, verify it, update the backlog." See
  **The backlog** below; it is the center of this skill.
- **Runs are chunked.** One invocation drives up to `chunk` tickets (default 20)
  and ends with a chunk report — a deliberate human checkpoint. The next
  invocation starts with a **fresh context** and resumes purely from the
  `.ailoop/` files. Anything worth surviving the gap must be written to them —
  a fact held only in conversation is a fact the next run never had.
- **You (the coordinator)** are the main loop executing this file. Within one
  invocation you pull ready tickets, dispatch them (a single subagent, or a
  Workflow fanning out a batch of independent ones), wait for the
  `<task-notification>`, read the structured result, judge, update the backlog,
  and pull the next — until the chunk cap is hit, the backlog is drained, or
  you must escalate.
- **Each ticket is built by a fresh subagent.** One ticket = one cold subagent
  with no memory of this conversation. That is deliberate: it bounds context and
  makes progress durable. It also sets the ticket-quality bar (see the schema).
- **Batches of independent ready tickets** fan out via a `Workflow` (see
  `templates/build-phase.workflow.js`): one worker per ticket in its own git
  worktree, then merge, then gate. Deterministic, backgrounded, resumable.

You do **not** need the `loop` skill. `loop` is for interval/recurring
re-invocation; ailoop's chunking is the human re-invoking `/ailoop` after each
checkpoint.

## Prime directives (non-negotiable)

1. **Oracle before build.** Never start a phase whose "done" is not
   machine-checkable. If the spec doesn't give you one, stop and ask the human
   to supply it. This is the *only* interruption allowed in a run, and it
   happens at intake — before the drive, never during.
2. **Trust the oracle, not the builder.** A worker reporting "done" is a claim,
   never a result — at every level. Per ticket, an **independent re-verify**
   (baseline + acceptance + scope check + gaming read), not the builder's
   self-report, is what counts; per phase, only a **merged-tree** oracle result
   counts (per-worktree green is not integration-green). See **Verification**.
3. **Stop before you thrash.** Hard caps on attempts per ticket and on tickets
   per invocation (the chunk). Escalate with a diagnosis rather than grinding a
   wall; end a chunk healthy rather than stretching a run.
4. **Stay in scope.** The spec's out-of-scope list is a tripwire, not a
   suggestion. If a phase's output crosses it, halt and report.
5. **Every ticket is cold-start runnable.** A ticket a fresh subagent can't
   complete from its own text is a bug in the ticket, not the subagent. Enrich
   or decompose it before dispatch — never hand a worker a ticket that leans on
   context only you hold. This includes failure history: a retried ticket
   carries its own `attempts` log.
6. **Judgment never does arithmetic.** Ready sets, fan-out batches, cap
   breaches, cycles — deterministic graph work with one right answer — come
   from the scheduler script, never from you eyeballing the backlog. Your
   judgment starts where its output ends.

---

## The backlog — the loop's driver

`.ailoop/backlog.json` is the heart of this skill: a dependency-ordered queue
of tickets, machine-readable **on purpose**. The loop is nothing more than:
**pull the next ready ticket → dispatch → verify → update the backlog →
repeat.** Everything else serves this.

Why backlog-driven and not phase-driven:
- When you plan, you find *many* things to do at once. You cannot hold them all
  in one context and work them all — you'd pick one and lose the rest. The
  backlog is where the rest live so nothing is dropped and ordering is explicit.
- Work is **decomposable on demand.** A ticket that turns out too big becomes
  several child tickets pushed back onto the backlog — so no single context ever
  rots trying to do too much. This is the primary defense against context rot.
- The backlog is durable state. It survives compaction *and the gap between
  chunked runs*: the loop's position is *"what does the scheduler say,"* not
  your memory.

### The scheduler — never compute readiness by eye

Everything the loop needs to *compute* about the backlog is deterministic graph
work — exactly the bookkeeping an LLM eyeballing a growing file gets silently
wrong (one misread `depends_on` = a worker building against code that doesn't
exist). At intake, copy `templates/schedule.mjs` to `.ailoop/schedule.mjs`.
Every loop turn starts with:

```
node .ailoop/schedule.mjs
```

It prints: dangling/duplicate dependencies, dependency cycles, the ready set,
file-disjoint fan-out batches (manifest/lockfiles excluded — they're allowlisted
for every ticket), attempt-cap breaches, and stale `in-progress` tickets. You
judge what the output *means* — whether a ready ticket is truly fit to
dispatch, which batch first — never *what it is*.

### Ticket schema

Each ticket carries everything a cold subagent needs — no reliance on the
coordinator's in-context knowledge:

```jsonc
{
  "project": "<name>",
  "caps": { "maxAttempts": 3, "thrash": 2, "chunk": 20 },
  "tickets": [
    {
      "id": "T017",
      "title": "Add POST /session login endpoint",
      "status": "todo",        // todo | in-progress | done | blocked | decomposed
                               // "ready" is COMPUTED by the scheduler, never stored
      "depends_on": ["T003", "T009"],
      "files": ["src/server/auth.ts", "src/server/routes.ts"],
      "origin": "spec §4.2",   // or "decomposed from T0NN" or "repair: gate red after T012+T014"
      "context": "Spec §4.2 defines the request/response shape; §4.5 the token rules (frozen). Locked (cite oracle.md): bcrypt hashing, 15-min token TTL. Already exists: User model (T003), db access layer (T009). Build ONLY this endpoint: validate credentials, issue a session token.",
      "acceptance": "- <project type-check command> passes\n- POST /session with valid creds → 200 + token; with bad creds → 401",
      "attempts": [],          // durable diagnosis log — see below
      "evidence": null         // filled on completion: the INDEPENDENT re-verify's output
    }
  ]
}
```

- **`depends_on` + `files`** together are the scheduler's input. Ready = all
  deps `done`. Among ready tickets, disjoint `files` → safe to fan out in
  worktrees; overlapping `files` → serialize. The `files` declaration is a
  **contract, not an honor system** — the independent verifier diffs the branch
  and fails any ticket that touched undeclared files (manifest/lockfiles
  excepted; any ticket may add a dependency).
- **`context`** must let a subagent that has never seen this conversation
  succeed. If you can't write it self-contained, the ticket is too big or too
  vague — decompose or sharpen it.
- **`acceptance`** is the ticket-local oracle — its bespoke behavioral checks,
  *on top of* the mandated baseline (type-check/build/lint/tests) every ticket
  clears (see **Verification**). Prefer input→output contrast checks over
  artifact-existence checks — existence is the most gameable form.
- **`attempts`** is the durable diagnosis log — one entry per failed attempt:
  `{ "n": 1, "failed": "<which checks>", "hypothesis": "<why>", "fixNote":
  "<instruction given on re-dispatch>" }`. It exists because chunked runs mean
  a re-dispatch may happen in a session that never saw the failure: the ticket
  carries its own failure history the way it carries its own context. Thrash
  detection reads this log, not your memory.

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
  why a ticket exists in `origin` (spec section, parent it decomposed from, or
  the gate failure it repairs).
- A ticket is `done` only when the independent re-verify passed *and*
  `evidence` holds the re-verify's actual output.
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

The builder runs all of this itself and returns the evidence — but its word is
a **claim**. The authoritative signal is the **independent re-verify**: a
separate agent (or you) re-checks the ticket's tree before the ticket is
accepted. In the fan-out Workflow this is a dedicated Verify stage per ticket,
run on the worker's worktree *before* integration; for a single-ticket
dispatch, you re-run it yourself. The re-verify is more than re-running the
builder's commands:

- **Re-run baseline + acceptance** (mechanical: exit codes and captured output,
  not the builder's transcript).
- **Scope check (mechanical).** `git diff --name-only` from the branch's
  merge-base: every touched path must be in the ticket's declared `files` or
  the manifest allowlist (`package.json` + lockfiles — any ticket may add a
  dependency). An undeclared touch **fails the ticket** with the overflow
  listed. This is what lets the parallelism scheduler trust `files`.
- **Gaming read (judgment).** Read the diff and ask: was the acceptance
  satisfied by implementing the intent, or by gaming the check — hardcoded
  outputs, weakened or deleted tests, special-cased inputs? Suspicion doesn't
  auto-fail; it comes to you with the *why*, and you judge against the spec. A
  confirmed gamed ticket is a failed attempt **and** triggers the escaped-bug
  rule (below).

Three gates, widening — a ticket must pass the narrow one to earn the next:

**baseline + acceptance + scope (independently re-verified, per ticket) →
integration (merge clean) → phase oracle (merged tree).**

A ticket that regresses the baseline is a **failed** ticket even if its own
acceptance passes.

---

## When a check is wrong — oracle amendments

The loop steers by its checks: it builds *whatever makes them pass*, not what
the spec meant — and wherever those two differ, an autonomous loop drives into
the gap at full speed with nobody watching. Four mechanisms keep the checks
honest. "Frozen" means never *silently* changed — not never changed:

- **Red-team at intake (Stage 1.5).** Before any build spend, adversarially
  review every seeded acceptance: *"how could a lazy builder make this pass
  without delivering the intent?"* Every cheat found = sharpen the check.
- **Mechanical amendments — self-serve.** A check wrong in letter but not
  meaning (misspelled command, wrong port/path/flag) would otherwise force a
  full-stop escalation on a typo — or tempt silent reinterpretation, which is
  worse. Fix `oracle.md` yourself, with a ledger entry citing the evidence.
- **Semantic amendments — never self-serve.** Any change to *what behavior
  counts as done* escalates, always. Weakening a check to get a stuck ticket
  through is the loop marking its own homework.
- **The escaped-bug rule.** When a defect passed a ticket's acceptance but was
  caught downstream (gate red, a later ticket tripping over it), the repair
  ticket must **also strengthen the check that let it through**. This is the
  only mechanism that makes the oracle sharper over the run instead of frozen
  at intake quality.

---

## Stage 1 — Intake & Oracle Contract

Do this once, on the first invocation only (see **Resume** for every run
after). Produce `.ailoop/oracle.md`, `.ailoop/backlog.json`, and
`.ailoop/ledger.md` (templates in `templates/`), and copy
`templates/schedule.mjs` → `.ailoop/schedule.mjs`. This is the pre-flight; the
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

4. **Seed the backlog.** Turn each phase into tickets in `.ailoop/backlog.json`,
   each sized to one focused subagent session and written cold-start runnable
   (full schema above). Wire `depends_on` so the graph encodes the spec's
   de-risk order — the riskiest phase's tickets come first and downstream
   tickets depend on them. Err small; you will decompose further mid-flight
   anyway. Do **not** try to enumerate every ticket for late phases perfectly —
   seed them coarsely and refine as earlier tickets teach you the shape.

5. **Red-team the acceptance.** Before any build spend, an adversarial pass
   over every seeded ticket (fan out a few cheap agents, one per phase's
   tickets): *"how could a lazy builder pass this acceptance without delivering
   the spec's intent?"* Each cheat found = sharpen the check. Prefer
   input→output contrast checks ("these 3 JDs must flip the lede differently")
   over artifact-existence checks ("file exists", "function returns") —
   existence is the most gameable form. Record the pass in the ledger.

6. **Set the caps.** In `backlog.json`'s `caps`: per-ticket max attempts
   (default 3), thrash threshold (a ticket's failing set doesn't shrink across
   2 attempts → escalate), and the chunk cap (tickets per invocation, default
   20). Snapshot them in the ledger run header.

Report the intake to the user as a short pre-flight: the phase→oracle map, the
seeded backlog (ticket count + the first few ready tickets + the dependency
spine), the caps, the red-team findings, and any oracle you had to ask them to
supply. Then drive.

---

## Stage 2 — The Drive

Work off the backlog. One turn of the loop:

### 2.1 Pull ready tickets
Run `node .ailoop/schedule.mjs` and read its output — never compute readiness,
batches, or breaches by eye (Prime directive 6):
- `problems` or `cycles` non-empty → fix the graph if it's your bookkeeping
  error (ledger entry), else escalate.
- `staleInProgress` non-empty → reconcile first (see **Resume**).
- `capBreaches` non-empty → those tickets are walls; escalate them (see 2.4).
- `ready` empty while `todo` tickets remain → blocked graph → escalate.
- `ready` empty and nothing `todo` → done (go to Termination).
- Otherwise: `batches[0]` is the next fan-out set (file-disjoint by
  construction). Tickets in later batches wait; after each judged result,
  re-run the scheduler.

### 2.2 Dispatch

**Model tiering — builders may downgrade, gates never do.** Builder agents run
`model: 'sonnet'` (single-ticket dispatch and the Workflow's Build stage alike):
the locked spec and the ticket's self-contained brief constrain them, and the
independent re-verify catches what they get wrong. Everything that *judges* —
the Verify stage, the integrator, the phase-oracle gate, and you the coordinator
— stays on the session model, no override. The failure mode this split guards
against is the reverse: a cheap judge rubber-stamping expensive (or cheap)
workers costs loop iterations; never downgrade the gate.

- **Single ticket** → one `Agent` subagent (`model: 'sonnet'`). Its prompt is
  the ticket's `context` + `acceptance` + the baseline gate + the frozen locked
  decisions + the declared `files` (touch only those, plus manifest/lockfile
  for dependencies) + **the full `attempts` log if this is a retry** — a fresh
  session must never re-diagnose from scratch. It must build, add tests for new
  behavior, then run baseline + acceptance and return the captured output. Then
  **you re-verify** (baseline + acceptance + scope check + gaming read) before
  accepting — its self-report is only a claim.
- **A disjoint batch** → the `build-phase` Workflow (see the template): one
  worker `agent()` per ticket, each `isolation: 'worktree'`, then a per-ticket
  **Verify** stage on each worktree, then **merge** the verified ones, then gate
  on the merged tree.

Every worker is instructed to return one of:
- `{ done: true, branch, evidence }` — built it, **added tests for new
  behavior**, ran the **baseline + acceptance**, output attached;
- `{ tooBig: true, proposedTickets: [...] }` — the ticket is bigger than one
  session; here is the proposed split (it did **not** half-build it);
- `{ blocked: true, reason }` — it hit a missing dependency or contradiction in
  the spec.

Wait for the `<task-notification>`. Never assume a worker succeeded.

### 2.3 Judge each result
The judgment the inner body cannot do:
- **`done` + independent re-verify green** (baseline + acceptance pass, no
  out-of-scope files, no credible gaming suspicion) **+ in scope** → mark the
  ticket `done`, store the **re-verify** evidence on the ticket, update the
  backlog. This may unblock downstream tickets.
- **re-verify red** — acceptance failed, the ticket **regressed the baseline**,
  OR it **touched undeclared files** → the ticket failed. Diagnose *why* using
  the spec — many specs tell you where to look (e.g. "if the behavior doesn't
  flip, the prompt is wrong, not the code"). Append an `attempts` entry
  (`failed` / `hypothesis` / `fixNote`) to the ticket — the diagnosis must
  survive compaction and the chunk gap — then re-dispatch with the full log.
- **Gaming suspicion** (verifier flagged the diff) → you read the diff and
  judge against the spec's intent. Gamed → failed attempt (append to
  `attempts`) **and** sharpen the acceptance that was gamed (escaped-bug rule).
  Clean → accept and note why in the ledger.
- **`tooBig`** → mark the parent `decomposed`, push the proposed child tickets
  onto the backlog with dependencies, refine their `context`/`acceptance` so
  each is cold-start runnable, continue. This is expected and healthy, not a
  failure.
- **`blocked`** → if the missing dependency is a ticket you can order, add/fix
  the edge and requeue. If it's a genuine spec contradiction, escalate.
- **Merge conflicts** (batch) → manifest conflicts are mechanical: take the
  union of `package.json` additions and **regenerate the lockfile with the
  project's install command** — never hand-merge a lockfile. Other conflicts:
  resolve if trivial and obvious; otherwise treat as a failed batch and
  re-dispatch the conflicting tickets serially.
- **Gate red after a clean merge** → the integration failure the merged-tree
  oracle *exists* to catch: every ticket verified green alone, the merge was
  textually clean, and the combination is broken. No single ticket is at fault,
  so don't pick a scapegoat — and **don't patch the merged tree yourself**; you
  are the judge, not a builder. Attribute by bisection: run the failing checks
  on base + each implicated branch alone (mechanical, cheap). Then spawn a
  **repair ticket** whose `context` carries the implicated tickets' evidence
  and the gate output, with `depends_on` on them and `origin: "repair: gate red
  after <ids>"`. The escaped-bug rule applies: the repair ticket also
  strengthens whichever acceptance let the interaction slip.
- **Scope tripwire hit** → halt, report; do not "fix" it by building more.

After integrating a batch or a phase's worth of tickets, run that **phase's
oracle** from `oracle.md` on the merged tree — the ticket-local checks are
necessary but the phase oracle is what actually closes a phase.

### 2.4 Enforce the caps
**Before every re-dispatch** (per ticket, from the `attempts` log — never from
memory):
- attempts ≥ `maxAttempts`, **or**
- the failing set hasn't shrunk across `thrash` consecutive attempts
→ **stop and escalate**: the ticket, its last re-verify result, your best
diagnosis of the wall (the `attempts` log writes this report for you), and the
specific human decision you need. Do not loop again on that wall.

**Before every new dispatch:**
- tickets closed this invocation ≥ `chunk` → **end the chunk healthy**: finish
  judging anything already dispatched (never abandon in-flight work), write the
  chunk report, stop. A chunk end is a checkpoint, not an escalation.

Then loop back to 2.1.

---

## Termination & report

A run ends one of three ways:

1. **Chunk cap reached** → a **chunk report**: tickets closed this run (with
   evidence pointers), decompositions and repair tickets spawned, current
   phase-oracle state, what the scheduler says is ready next, and "invoke
   `/ailoop` to continue." This is the healthy steady state.
2. **Backlog drained and every phase oracle green** → the **final report**:
   - **Shipped:** what was built, keyed by phase / ticket.
   - **Oracle evidence:** the passing check output per phase (the proof, not
     your say-so).
   - **Backlog history:** tickets completed, decomposed, repaired — the shape
     of the work, honestly.
   - **Cut / deferred:** anything the spec deferred or you consciously left out.
   - **Drift caught:** scope tripwires, retries, gamed tickets, gate-red
     bisections, oracle amendments — plain, not smoothed over.
3. **Escalation** → "stuck at ticket T, here's the wall and the decision I
   need" — never a rosy summary of a loop that didn't finish.

## Resume — every invocation after the first

`.ailoop/` exists → skip intake entirely. Read `oracle.md`, the ledger tail,
and run the scheduler. Reconcile before dispatching:

- **Stale `in-progress`** (a previous run ended mid-ticket): don't guess what
  happened. Independently re-verify the ticket against the current tree — if
  green, judge it like any worker result; if red, reset it to `todo` and append
  an `attempts` entry noting the interrupted run.
- **Legacy markdown backlog** (`backlog.md` from an older version of this
  skill): convert it to `backlog.json` once, preserving all tickets and history
  verbatim; ledger entry.

The files are the whole memory. If a fact from a previous run matters and isn't
in them, it's gone — that's a bug in what was written, and the fix is to write
more into the ticket/ledger *this* run, not to try to remember harder.

---

## Durable state — three files + one script, four jobs

All under `.ailoop/`. Trust these files over your recollection; they are what
survives context compaction and the gap between chunked runs.

- **`backlog.json`** — the **forward** state and the loop driver: the ticket
  queue with status, dependencies, and per-ticket `attempts` diagnosis logs.
  "Where is the loop?" is answered by the scheduler, never by memory.
- **`schedule.mjs`** — the deterministic scheduler (copied from templates at
  intake). Ready sets, batches, breaches — computed, never eyeballed.
- **`oracle.md`** — the **definition of done**: locked decisions, the scope
  tripwire list, the baseline gate, and the executable per-phase checks.
  Written at intake; amendable only per the amendment tiers (mechanical =
  self-serve + ledger entry; semantic = escalate); workers cite it; you gate
  against it.
- **`ledger.md`** — the append-only **journal**: every judge decision and why,
  oracle amendments, red-team findings, decompositions, drift flags,
  escalations, chunk boundaries. The audit trail — how the loop got where it is.

Update `backlog.json` after every ticket outcome and `ledger.md` after every
judge decision.

## Guards checklist (re-read before each dispatch)

- [ ] Ready set / batches / breaches came from `schedule.mjs` output — not from
      eyeballing the backlog.
- [ ] The ticket is cold-start runnable (self-contained `context`; full
      `attempts` log included on retries).
- [ ] Its `acceptance` is executable (not vibes) and was red-teamed at intake.
- [ ] Worker ran the baseline (type-check/build/lint/full test suite) + acceptance.
- [ ] New behavior has new tests, green under the baseline.
- [ ] **Independent re-verify** passed: checks green, touched files ⊆ declared
      ∪ manifest allowlist, diff read for gaming — and no baseline regression.
- [ ] Workers cite locked decisions; none re-litigated.
- [ ] Only merged-tree checks count as green; phase oracle run before closing a phase.
- [ ] Gate red after a clean merge → bisect + repair ticket; never patch the
      tree yourself.
- [ ] Oracle changed only via the amendment tiers, each with a ledger entry.
- [ ] Attempt/thrash caps checked from the `attempts` log before every
      re-dispatch; chunk cap checked before every new dispatch.
- [ ] Nothing built crosses the out-of-scope list.
- [ ] `backlog.json` and `ledger.md` updated.

## Scope of this skill

- **Runs are chunked by design.** Default 20 tickets per invocation, a quick
  human look between runs, fresh context each time. The `.ailoop/` files are
  the only memory across invocations.
- **No token budgeting.** The main loop has no spend gauge, so a token cap
  would be enforced by guesswork — and fictional numbers in the audit trail are
  worse than no cap. The real guards are attempts, thrash, and the chunk cap;
  cost control is model tiering (Sonnet builders, session-model gates), not
  budget arithmetic.
- **Fully autonomous within a chunk.** The only human touches in a healthy run
  are the intake pre-flight, the glance between chunks, and the final report.
  Everything else is escalation, which by definition means the loop couldn't
  proceed safely.
