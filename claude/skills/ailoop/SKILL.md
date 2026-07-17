---
name: ailoop
description: >-
  Drive a locked build spec to completion through an autonomous, self-terminating
  engineering loop: one invocation intakes (first run) or resumes from .ailoop/
  state and drives the backlog until every phase oracle is green — no dispatch
  cap; hours-long, multi-phase runs are the intended shape. You act as the
  judging COORDINATOR: extract an executable oracle from the spec, dispatch
  deterministic Workflow bodies (parallel worker agents in git worktrees →
  merge → re-gate), judge results,
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

Stage-local protocols live in `references/` and load at their moment, never
before: `references/intake.md` when starting a fresh campaign (Stage 1),
`references/termination.md` when the backlog completes. This file is the
always-loaded core: the loop, its guards, and everything used mid-run.

## The mental model — two layers

An autonomous build loop has two kinds of work that want opposite things. Never
collapse them into one.

| | **Outer loop — coordination (you)** | **Inner body — execution (Workflow)** |
|---|---|---|
| Job | Which ticket is ready? Is its acceptance met? Is it too big? Are we drifting or stuck? | Build this ticket. Verify it. Report a structured result. |
| Wants | **Judgment** — pick the next ticket, interpret failures, decide retry vs. decompose vs. escalate | **Determinism** — reproducible build, verify-gate, no improvisation |

- **The backlog drives the loop.** You do not work off the spec directly: at
  intake you seed `.ailoop/backlog.json`, and from then on the loop *is* "pull
  the next ready ticket → dispatch → verify → update the backlog → repeat."
  See **The backlog** below; it is the center of this skill.
- **One invocation runs to completion.** There is no dispatch cap: the run
  ends only when the backlog is drained and every phase oracle is green, or on
  escalation. Hours-long, multi-phase runs are the intended shape — length,
  compaction, or dispatches spent are never reasons to stop. Context **will**
  be compacted mid-run; the `.ailoop/` files, not the conversation, are the
  loop's memory — a fact held only in conversation is a fact the loop will
  eventually lose.
- **Each ticket is built by a fresh subagent** with no memory of this
  conversation. That is deliberate: it bounds context and makes progress
  durable — and it sets the ticket-quality bar (see the schema). Batches of
  independent ready tickets fan out via a `Workflow`
  (`templates/build-phase.workflow.js`): one worker per ticket in its own git
  worktree, then merge, then gate. Deterministic, backgrounded, resumable.
- You do **not** need the `loop` skill — ailoop runs to completion in one
  invocation and is re-invoked only to resume after an interruption or a
  resolved escalation.

## Prime directives (non-negotiable)

1. **Oracle before build.** Never start a phase whose "done" is not
   machine-checkable. If the spec doesn't give you one, stop and ask the human
   to supply it. This is the *only* interruption allowed in a run, and it
   happens at intake — before the drive, never during.
2. **Trust the oracle, not the builder.** A worker reporting "done" is a claim,
   never a result — at every level. Per ticket, an **independent re-verify**,
   not the builder's self-report, is what counts; per phase, only a
   **merged-tree** oracle result counts (per-worktree green is not
   integration-green). See **Verification**.
3. **Stop before you thrash.** Hard caps on attempts per ticket, thrash
   detection across attempts. Escalate with a diagnosis rather than grinding a
   wall. Length alone is never a reason to stop — a wall is.
4. **Stay in scope.** The spec's out-of-scope list is a tripwire, not a
   suggestion. If a phase's output crosses it, halt and report.
5. **Every ticket is cold-start runnable.** A ticket a fresh subagent can't
   complete from its own text is a bug in the ticket, not the subagent. Enrich
   or decompose it before dispatch — never hand a worker a ticket that leans on
   context only you hold. This includes failure history: a retried ticket
   carries its own `attempts` log.
6. **Judgment never does arithmetic.** Ready sets, fan-out batches, cap and
   thrash breaches, cycles, phase drain, completion — deterministic graph work
   with one right answer — come from the scheduler script, never from you
   eyeballing the backlog. Your judgment starts where its output ends.

---

## The backlog — the loop's driver

`.ailoop/backlog.json` is the heart of this skill: a dependency-ordered queue
of tickets, machine-readable **on purpose**. Why backlog-driven and not
phase-driven:

- Planning surfaces many things to do at once; one context cannot hold and
  work them all. The backlog is where the rest live — nothing dropped,
  ordering explicit.
- Work is **decomposable on demand**: a too-big ticket becomes child tickets
  pushed back onto the backlog, so no single context ever rots trying to do
  too much. The primary defense against context rot.
- It is durable state: the loop's position is *"what does the scheduler say,"*
  not your memory — it survives compaction and any interruption.

### The scheduler — never compute readiness by eye

Everything the loop needs to *compute* about the backlog is deterministic graph
work — exactly the bookkeeping an LLM eyeballing a growing file gets silently
wrong (one misread `depends_on` = a worker building against code that doesn't
exist). At intake, copy `templates/schedule.mjs` to `.ailoop/schedule.mjs`.
Every loop turn starts with:

```
node .ailoop/schedule.mjs
```

It prints: structural problems (dangling/duplicate dependencies, dependents
stranded on `decomposed` tickets, tickets with no declared `files`), dependency
cycles, the ready set, declared-but-missing paths per ticket (`missingFiles` —
each is an intentional create or a guessed home to fix before dispatch),
file-disjoint fan-out batches (manifest/lockfiles
excluded — they're allowlisted for every ticket), attempt-cap **and thrash**
breaches (both computed from the `attempts` log), per-phase drain state, a
`complete` flag, and stale `in-progress` tickets. You judge what the output
*means* — whether a ready ticket is truly fit to dispatch, which batch first —
never *what it is*.

### Ticket schema

Each ticket carries everything a cold subagent needs — no reliance on the
coordinator's in-context knowledge:

```jsonc
{
  "project": "<name>",
  "caps": { "maxAttempts": 3, "thrash": 2 },
  "fastChecks": [           // machine mirror of oracle.md's fast tier — verify.mjs runs it
    { "name": "type-check", "cmd": "bun run check" }
  ],
  "resources": {            // OPTIONAL: shared mutable test resources — see
    "db": {                 // Verification → Shared verify resources
      "pool": 3,            // concurrent isolated instances (1 + no provision = serialize on ambient)
      "provision": "<cmd>", // `<cmd> <slot>` stands up instance <slot>, prints KEY=VAL env lines
      "teardown": "<cmd>"   // `<cmd> <slot>` stops it — run via --teardown-resources at termination
    }
  },
  "tickets": [
    {
      "id": "T017",
      "title": "Add POST /session login endpoint",
      "status": "todo",        // todo | in-progress | done | blocked | decomposed
                               // "ready" is COMPUTED by the scheduler, never stored
      "phase": "P2",           // the spec phase this ticket closes toward — the
                               // scheduler reports per-phase drain from it
      "depends_on": ["T003", "T009"],
      "files": ["src/server/auth.ts", "src/server/routes.ts"],  // NON-EMPTY, always
      "origin": "spec §4.2",   // or "decomposed from T0NN" or "repair: gate red after T012+T014"
      "context": "Spec §4.2 defines the request/response shape; §4.5 the token rules (frozen). Locked (cite oracle.md): bcrypt hashing, 15-min token TTL. Already exists: User model (T003), db access layer (T009). Build ONLY this endpoint: validate credentials, issue a session token.",
      "acceptance": "- <project type-check command> passes\n- POST /session with valid creds → 200 + token; with bad creds → 401",
      "acceptanceChecks": [    // the runnable mirror of acceptance — verify.mjs executes these
        { "name": "session-endpoint", "cmd": "bun test src/server/auth.test.ts" }
      ],
      "builderModel": "haiku", // OPTIONAL: opt-down for an obviously-mechanical ticket; default sonnet
      "scaffold": true,        // OPTIONAL: pure scaffold/config — the gaming read is skipped
      "resources": ["db"],     // OPTIONAL: shared resources its acceptanceChecks MUTATE —
                               // verify.mjs leases an instance before running them
      "attempts": [],          // durable diagnosis log — see below
      "evidence": null         // filled on completion: a POINTER into .ailoop/evidence/
                               // to the INDEPENDENT re-verify's output — never inline
    }
  ]
}
```

- **`depends_on` + `files`** together are the scheduler's input. Ready = all
  deps `done`. Among ready tickets, disjoint `files` → safe to fan out in
  worktrees; overlapping `files` → serialize. The `files` declaration is a
  **contract, not an honor system** — the independent verifier diffs the branch
  and fails any ticket that touched undeclared files (manifest/lockfiles
  excepted; any ticket may add a dependency). It must be **non-empty**: an
  empty declaration means unknown footprint — unbatchable and unverifiable —
  and the scheduler rejects it as a problem. Declare the expected paths or
  decompose until you can.
- **`context`** must let a subagent that has never seen this conversation
  succeed. If you can't write it self-contained, the ticket is too big or too
  vague — decompose or sharpen it.
- **`acceptance`** is the ticket-local oracle — its bespoke behavioral checks,
  *on top of* the mandated fast-tier baseline every ticket
  clears (see **Verification**). Prefer input→output contrast checks over
  artifact-existence checks — existence is the most gameable form.
  **`acceptanceChecks`** is its runnable mirror: named `{name, cmd}` commands
  `verify.mjs` executes. An acceptance line that can't be written as a command
  isn't executable acceptance — sharpen it until it is (usually: the builder
  ships a test pinning it, and the check runs that test).
- **`attempts`** is the durable diagnosis log — one entry per failed attempt:
  `{ "n": 1, "failed": ["<check name>", ...], "hypothesis": "<why>", "fixNote":
  "<instruction given on re-dispatch>" }`. `failed` is an **array of check
  names**, not prose — the scheduler compares consecutive attempts' failing
  sets to detect thrash mechanically. The log exists because compaction and
  interruptions mean a re-dispatch may happen in a context that never saw the
  failure: the ticket carries its own failure history the way it carries its
  own context.

### Decomposition (the anti-rot move)

Splitting happens at two moments:
1. **At planning** — you break the spec's phases/epics into tickets each sized
   to one focused subagent session. Err small.
2. **Mid-flight** — a dispatched subagent may find its ticket is bigger than one
   session. It returns `{ tooBig: true, proposedTickets: [...] }` **instead of**
   a half-finished build. You mark the parent `decomposed`, push the children
   (with dependencies) onto the backlog, and continue. Never let a worker grind
   a too-big ticket to context exhaustion.

Every decomposition follows the same bookkeeping, or the graph silently rots:
- **Rewire the parent's dependents.** A `decomposed` ticket never becomes
  `done`, so any ticket still depending on it is stranded forever. Point each
  dependent at the child(ren) that actually deliver what it needs. The
  scheduler flags stranded edges as problems, but fix them at decomposition
  time, not when the alarm fires.
- **Children inherit the parent's `phase`** — phase drain is computed from it.
- **Refine each child cold-start runnable** (self-contained `context`, its own
  `acceptance`), then **red-team the fresh `acceptance`** with the two-lens
  pass (see **When a check is wrong**). Mid-flight tickets — decomposed
  children and repair tickets — are the only ones that would otherwise skip
  that pass, and they're born precisely where something already went sideways.
  Ledger the pass.

### Rules

- New tickets are **appended and ordered by dependency**, not by whim. Record
  why a ticket exists in `origin` (spec section, parent it decomposed from, or
  the gate failure it repairs).
- A ticket is `done` only when the independent re-verify passed *and*
  `evidence` points at the re-verify's actual output, written to
  `.ailoop/evidence/<id>.txt` (failed-attempt output at `<id>-a<n>.txt` when
  worth keeping). Never inline captured output into `backlog.json` — the
  scheduler and every resume re-read that file; bulk there taxes every turn of
  the loop.
- The backlog is append-mostly: don't delete tickets, mark them `done` /
  `decomposed`. The history is part of the audit trail.

---

## Verification — what every ticket must clear

"Trust the oracle, not the builder" applies at the **ticket** level, not just at
phase close. A ticket is `done` only when an **independent** check — never the
builder's self-report alone — confirms three things:

1. **Baseline (every ticket, no exceptions).** The project's standing quality
   gate, defined once in `oracle.md` and applied to *every* ticket regardless of
   what it touched. Detect the exact commands from the project's manifest at
   intake (intake step 0) and classify each into a tier:
   - **Fast tier — runs per ticket:** type-check/compile, build, lint, and the
     full unit-test suite. This is the immediate regression net: a ticket that
     breaks a previously-green unit test is caught at its own verify, not at
     phase close.
   - **Gate tier — runs per phase close:** slow suites (e2e, anything needing
     a live server or minutes of wall-clock). These run on the merged tree at
     the phase gate, not per ticket — per-ticket e2e is where the loop's
     wall-clock goes, and phase-close granularity plus bisection buys it back.
     Two obligations keep the deferral honest: a ticket shipping a NEW
     gate-tier test runs that test itself (builder and verifier both — it is
     the ticket's own acceptance, not the whole tier), and a ticket changing
     behavior that an EXISTING gate-tier test pins names and re-runs that test.
     The accepted cost: a gate-tier regression surfaces at phase close with
     batch attribution — that is the gate-red bisection's job (2.3), and it is
     why worker branches are kept until the gate is green.
   Cost note: the **builder** may scope the fast tier's full-suite step to the
   tests its change affects — the **independent verifier always runs the full
   fast tier**, and that authoritative run is what counts. Never scope the
   verifier's fast tier or the phase gate.
2. **Ticket acceptance.** The ticket's own behavioral checks (its `acceptance`
   field), with captured output as evidence.
3. **New tests for new behavior.** A ticket that adds behavior must add tests
   covering it, green under the baseline — this is how the regression net grows
   as the build proceeds. Exempt only pure scaffold/config tickets with no
   behavior to test, and say so in the ticket.

The independent re-verify splits by kind: the *measurement* is `verify.mjs`
(copied from templates at intake) — a script, because exit codes and set
arithmetic need no model — and the *judgment* is the gaming read over the diff
the script dumps. In the fan-out Workflow the Verify stage is a cheap relay
that runs the script, with a session-model gaming read pipelined behind it;
for a single-ticket dispatch you run the script and read the diff yourself.

- **`verify.mjs` measures (mechanical, no model).** Run from the repo root
  against the worker's worktree
  (`node .ailoop/verify.mjs --ticket <id> --dir <worktree> --base <baseSha>`),
  it: refuses a **dirty tree** (only committed work merges, so only committed
  work verifies); re-runs the **full fast tier** plus the ticket's
  `acceptanceChecks` — exit codes decide, not the builder's transcript — even
  where the builder scoped its suite (a ticket with its own gate-tier tests
  carries them in `acceptanceChecks`); **scope-checks**
  `git diff --name-only <baseSha>..HEAD` against the declared `files` ∪
  manifest allowlist (an undeclared touch **fails the ticket** with the
  overflow listed — this is what lets the parallelism scheduler trust
  `files`); and dumps the evidence and the diff patch into
  `.ailoop/evidence/`. Its `failing` array is stable check *names* — it
  becomes the `attempts` entry's `failed` set, verbatim. `baseSha` is the fork
  point you captured (`git rev-parse HEAD`) immediately before dispatch — the
  script is handed it, never left to guess a merge-base.
- **Gaming read (judgment — never downgraded).** Read the dumped diff and ask:
  was the acceptance satisfied by implementing the intent, or by gaming the
  check — hardcoded outputs, weakened or deleted tests, special-cased inputs?
  Suspicion doesn't auto-fail; it comes to you with the *why*, and you judge
  against the spec. A confirmed gamed ticket is a failed attempt **and**
  triggers the escaped-bug rule (below). Skip the read only for tickets marked
  `scaffold: true` — pure scaffold/config with nothing behavioral to game. Its
  hit rate is measurable from the ledger; tune its scope from that evidence,
  not vibes.

Three gates, widening — a ticket must pass the narrow one to earn the next:

**fast-tier baseline + acceptance + scope (independently re-verified, per
ticket) → integration (merge clean) → gate-tier baseline + phase oracle
(merged tree).**

A ticket that regresses the baseline is a **failed** ticket even if its own
acceptance passes.

### Shared verify resources — lease, don't collide

Some acceptance checks mutate a shared external resource — a dev database the
integration suite resets, a queue, a local object store. Two such verifies
running concurrently corrupt each other's results, and the hazard is invisible
to the scheduler: batches are file-disjoint, not resource-disjoint. The guard
is declarative and mechanical, never coordinator vigilance:

- The backlog's top-level `resources` block (seeded at intake) defines each
  shared resource: `{ pool, provision, teardown }`. `provision <slot>` is a
  **project-authored** command that stands up isolated instance `<slot>` and
  prints the `KEY=VAL` env lines checks need to target it (values may contain
  `{dir}` — substituted with the tree under verification, for instances that
  must read config/migrations from the branch being verified); `teardown
  <slot>` stops it (`verify.mjs --teardown-resources`, at termination). **No
  provision command → pool of 1 with no env**: the ambient shared instance,
  with leases serializing access — correctness without parallelism, for
  projects where isolation isn't provisionable.
- A ticket lists the resource names its `acceptanceChecks` mutate in its own
  `resources` array. Read-only touches don't count; a suite that *resets* the
  resource does.
- `verify.mjs` leases one slot per declared resource before running any check
  (flake probes included), provisions lazily on first lease, injects the env
  into every check subprocess, and releases on exit. A full pool queues —
  serialization is the graceful floor, collision is never possible.

Disclosed limit: builders' own in-worktree check runs still share the ambient
instance and may contend during a fan-out — a resource-flavored failure in a
builder's *self-report* can be contention, and the leased independent
re-verify is what counts. Gate-tier and phase-oracle runs also use the ambient
instance; they are serial by construction (after a batch settles, before the
next dispatch).

### Flaky checks — discriminate, then decide

An intermittently failing check is never adjudicated by vibes and never
tolerated silently. When a verify or gate fails on a test the ticket plausibly
didn't touch:

1. **Discriminate.** Re-run the failing test file **alone**, 3–5 times — a
   single isolated pass is not conclusive; low-rate flakes exist. The probe is
   `verify.mjs` in ad-hoc mode:
   `--cmd "<single-file test command>" --repeat 5` (pass counts land in the
   evidence file). Fails in isolation → real regression, the ticket failed.
   Passes in isolation → flaky under the full run.
2. **Decide on the record.** A confirmed flake still has a root cause —
   usually test-infrastructure timing, occasionally a **real race in the
   product**, which is why this step exists: a dismissed flake can be a masked
   bug. Judge which, then:
   - **Root cause in scope** (the test pins behavior this spec owns, or the
     flake is a product race) → spawn a fix ticket — same spirit as the
     escaped-bug rule.
   - **Root cause out of scope** (pre-existing test-infra timing) →
     **quarantine**: record the test, its failure mode, and its discriminator
     in `oracle.md` so every later verify applies it without re-deriving, and
     carry the entry into the final report as an explicit residual.

   Quarantine narrows *interpretation*, never the check: the test still runs
   everywhere, and a quarantined test failing in isolation is still a hard red.

---

## When a check is wrong — oracle amendments

The loop steers by its checks: it builds *whatever makes them pass*, not what
the spec meant — and wherever those two differ, an autonomous loop drives into
the gap at full speed with nobody watching. Four mechanisms keep the checks
honest. "Frozen" means never *silently* changed — not never changed:

- **Red-team every acceptance before build spend** — at intake for seeded
  tickets (intake step 5), at creation for decomposed children and repair
  tickets. **Two lenses, in sequence, within the same agents** (no extra
  fan-out): (1) **gaming** — *"how could a lazy builder make this pass without
  delivering the intent?"*; (2) **instrument blindness** — *"assume an honest
  builder: what is this check's own vantage (its DB connection, auth level,
  what it reads) and what class of real defect is it structurally unable to
  see?"* A check that verifies through a superuser connection can't see a
  missing grant; one that reads the app's own echo can't prove persistence;
  one using the admin key can't see an RLS hole. Every cheat or blind spot
  found = sharpen the check. Ledger the pass.
- **Mechanical amendments — self-serve.** A check wrong in letter but not
  meaning (misspelled command, wrong port/path/flag) would otherwise force a
  full-stop escalation on a typo — or tempt silent reinterpretation, which is
  worse. Fix `oracle.md` yourself, with a ledger entry citing the evidence.
  (The fast tier is mirrored between `oracle.md` and `backlog.json`'s
  `fastChecks` — an amendment to one amends both.)
- **Semantic amendments — never self-serve.** Any change to *what behavior
  counts as done* escalates, always. Weakening a check to get a stuck ticket
  through is the loop marking its own homework.
- **The escaped-bug rule.** When a defect passed a ticket's acceptance but was
  caught downstream (gate red, a later ticket tripping over it), the repair
  ticket must **also strengthen the check that let it through**. This is the
  only mechanism that makes the oracle sharper over the run instead of frozen
  at intake quality.

---

## Stage 1 — Intake (first invocation only)

`.ailoop/` absent → this invocation starts the campaign: **read
`references/intake.md` and follow it** before any other action. It locates the
locked spec, derives the executable per-phase oracle and the baseline tiers,
enforces the refuse-to-start gate, seeds the backlog, red-teams every
acceptance, sets the caps, gitignores the campaign, and reports the pre-flight
to the human. Intake is the only stage that may interrupt the human (Prime
directive 1).

`.ailoop/` present → a previous run already did intake; never re-pick the spec
(`oracle.md`'s contract identity names it) — see **Resume**.

---

## Stage 2 — The Drive

Work off the backlog. One turn of the loop:

### 2.1 Pull ready tickets
Run `node .ailoop/schedule.mjs` and read its output — never compute readiness,
batches, breaches, thrash, phase drain, or completion by eye (Prime
directive 6):
- `problems` or `cycles` non-empty → fix the graph if it's your bookkeeping
  error (ledger entry), else escalate. Problems include dependents stranded on
  a `decomposed` ticket (rewire the edge to its children) and tickets with no
  declared `files` (declare the footprint or decompose).
- `staleInProgress` non-empty → reconcile first (see **Resume**).
- `missingFiles` names a ticket you're about to dispatch → resolve first: each
  missing path is an intentional create (fine) or a guessed home — grep for
  where the behavior actually lives and fix `files` now; the miss costs a
  ledger entry here and a whole dispatch later.
- `capBreaches` or `thrashBreaches` non-empty → those tickets are walls;
  escalate them (see 2.4).
- `phasesDrained` names a phase whose oracle hasn't run yet (check the ledger)
  → run that phase's oracle on the merged tree before dispatching onward.
- `complete: true` (no `todo`, `in-progress`, **or `blocked`** tickets remain)
  → done (go to Termination).
- `ready` empty while `complete` is false → nothing is dispatchable but live
  work remains — a blocked graph, unresolved `blocked` tickets, or walls.
  Resolve what you can (requeue an unblocked ticket, fix an edge) or escalate.
  **Never report done over live `blocked` tickets.**
- Otherwise: `batches[0]` is the next fan-out set (file-disjoint by
  construction). Tickets in later batches wait; after each judged result,
  re-run the scheduler.

### 2.2 Dispatch

**Model tiering — judgment never downgrades, measurement is scripted.** The
coordinator (you) runs top-tier: it holds the run's highest-leverage decisions
and every inline verdict (gaming reads, diagnosis, red-team, coverage).
Builders default `sonnet` — the locked spec and the ticket's self-contained
brief constrain them, and the independent re-verify catches what they get
wrong; an obviously-mechanical ticket may opt down via `"builderModel":
"haiku"`, set at seeding, per ticket, never globally. Mechanical verification
costs no model at all: `verify.mjs` measures, and the Workflow's Verify stage
is a `haiku` relay that only runs it. The failure mode this split guards
against is a cheap judge rubber-stamping workers: anything that *judges* stays
top-tier; anything that *measures* is a script.

- **Single ticket** → one `Agent` subagent (`model:` the ticket's
  `builderModel`, default `'sonnet'`; `isolation: 'worktree'`) — **never on
  the main working tree**: an interrupted worker must leave a branch to
  reconcile, not a dirty tree, and the scope check needs a defined diff base.
  Capture `baseSha` (`git rev-parse HEAD`) immediately before dispatch. The
  prompt is the ticket's `context` + `acceptance` + the baseline gate + the
  frozen locked decisions + the declared `files` (touch only those, plus
  manifest/lockfile for dependencies) + **the full `attempts` log if this is a
  retry** — a fresh session must never re-diagnose from scratch. It must
  build, add tests for new behavior, run the fast-tier baseline + acceptance
  (it may scope the full-suite step to affected tests), commit its work on the
  branch in conventional format (those commits merge into the mainline's
  permanent history), and report its **branch** with the captured output. Then
  **you re-verify on that branch per Verification**: run `verify.mjs` against
  the worktree, gaming-read the dumped diff. On accept, merge the branch into
  the mainline; if the mainline moved past `baseSha` since the fork, re-run
  the fast tier on the merged tree — that is the integration gate a batch run
  would have given you.
- **A disjoint batch** → the `build-phase` Workflow (see the template),
  passing `baseSha` (`git rev-parse HEAD` at invocation) alongside the
  tickets, frozen decisions, baseline, and phase oracle: one worker `agent()`
  per ticket, each `isolation: 'worktree'`, a per-ticket **Verify** relay
  (runs `verify.mjs`) plus a **gaming read** pipelined behind each build, then
  **merge** the verified ones, then gate on the merged tree (skipped when
  nothing merged — `oracle: null`).

Every worker is instructed to return one of:
- `{ done: true, branch, evidence }` — built it, **added tests for new
  behavior**, ran the **baseline + acceptance**, output attached;
- `{ tooBig: true, proposedTickets: [...] }` — the ticket is bigger than one
  session; here is the proposed split (it did **not** half-build it);
- `{ blocked: true, reason }` — it hit a missing dependency or contradiction in
  the spec.

Wait for the `<task-notification>`. Never assume a worker succeeded.

**The wait is work time.** While workers build, do the prep the loop needs
anyway — none of it touches in-flight tickets:
- **Refine the next frontier.** Late-phase tickets were seeded coarsely on
  purpose; sharpen the `context`/`acceptance` of tickets the in-flight batch is
  about to unblock, using what finished tickets taught you.
- **Red-team upcoming acceptance early.** Fan out the two-lens adversarial
  pass over soon-to-be-ready tickets now, not at dispatch time —
  decomposed children and repair tickets especially, so their mandatory
  red-team never sits on the critical path.
- **Coverage map and ledger upkeep.**

Write every result into the `.ailoop/` files as it lands — prep held only in
context dies at compaction. Prefer cheap background agents over your
own context for the fan-out parts; your context is the loop's scarcest
resource.

### 2.3 Judge each result
The judgment the inner body cannot do:
- **`done` + independent re-verify green + in scope** → mark the ticket
  `done`, write the **re-verify** evidence to `.ailoop/evidence/<id>.txt` and
  store the pointer on the ticket, update the backlog. **Then capture the
  per-ticket sidecars now** (2.3b) — this is the only moment the worker's
  transcript still exists.
- **re-verify red** — acceptance failed, the ticket **regressed the baseline**,
  OR it **touched undeclared files** → the ticket failed. A failing check the
  ticket plausibly didn't touch goes through the flake discriminator first
  (see **Flaky checks**) — never log an attempt against noise. Then diagnose
  *why* using
  the spec — many specs tell you where to look (e.g. "if the behavior doesn't
  flip, the prompt is wrong, not the code"). Several failures in one batch →
  fan out one diagnosis agent per failed ticket, in parallel; the diagnoses
  are independent, and you judge their output — serializing them is pure
  wall-clock waste. Append an `attempts` entry
  (`failed` / `hypothesis` / `fixNote`) to the ticket — the script's `failing`
  array is the entry's `failed` set, verbatim, and the diagnosis must
  survive compaction — then re-dispatch with the full log.
- **Resume before re-dispatch.** Whenever the builder session is still alive
  and its work so far is sound — an honest scope stop, a flagged wrong
  premise, a re-verify red whose fix is incremental (one more surface, a
  missed test migration) — continue the SAME agent via SendMessage with a
  targeted fixNote instead of dispatching fresh: it already holds the context
  and the branch, and a fresh session re-derives both at full price. Dispatch
  fresh only when the session is dead/stalled, or the diagnosis indicts the
  builder's approach rather than its coverage — a gamed or wrong-headed
  attempt is never resumed. A resume is a dispatch: ledger it like any other.
- **Gaming suspicion** (the gaming read flagged the diff) → you read the diff and
  judge against the spec's intent. Gamed → failed attempt (append to
  `attempts`) **and** sharpen the acceptance that was gamed (escaped-bug rule).
  Clean → accept and note why in the ledger.
- **`tooBig`** → mark the parent `decomposed`, push the proposed child tickets
  onto the backlog, and do the full bookkeeping in **Decomposition** (rewire
  dependents, inherit `phase`, refine + red-team the children). This is
  expected and healthy, not a failure.
- **`blocked`** → if the missing dependency is a ticket you can order, add/fix
  the edge and requeue. If it's a footprint gap — the declared home is wrong
  or a needed file is undeclared — verify the builder's analysis yourself
  (grep it), expand `files` with a ledger entry, and resume the same agent.
  If it's a genuine spec contradiction, escalate.
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
  on base + each implicated branch alone — mechanical, cheap, and independent
  per branch, so fan the runs out in parallel. Then spawn a
  **repair ticket** whose `context` carries the implicated tickets' evidence
  and the gate output, with `depends_on` on them and `origin: "repair: gate red
  after <ids>"`. The escaped-bug rule applies: the repair ticket also
  strengthens whichever acceptance let the interaction slip — and its own
  fresh acceptance gets red-teamed before dispatch, like any mid-flight ticket.
- **Scope tripwire hit** → halt, report; do not "fix" it by building more.

When the scheduler's `phasesDrained` shows a phase with no live tickets left —
never your own tally of the backlog — run the **baseline's gate tier** and that
**phase's oracle** from
`oracle.md` on the merged tree: the ticket-local checks are necessary, but the
deferred slow suites plus the phase oracle are what actually close a phase. Until it is green, **keep the
phase's worker branches** — a gate-red bisection needs them intact. Once it is
green, prune: delete the merged worker branches and `git worktree prune`
(ledger the phase close).

### 2.3b Capture at accept — the per-ticket dossier

The ledger records *decisions* and deliberately stays lean (it is re-read every
loop turn). The richer per-ticket record — how long, how expensive, what was
learned — lives in **`evidence/<id>.<kind>.json` sidecars**, written **at
accept, never at termination**: they derive from the worker's transcript, and
transcripts are **ephemeral — the harness reaps them on its own clock, often
mid-run**. Accept is the only moment the data still exists. `report.mjs` reads
the sidecars, never a transcript, and globs `<id>.*.json` — a new facet worth
capturing later is a new file, never a code change. Write these on every
accept:

- **`<id>.timing.json`** — run
  `node .ailoop/timing.mjs --ticket <id> <transcript-path> [<more paths>]`
  immediately on accept, passing the worker's transcript(s) (build + any
  verify/gaming + a resume all aggregate). The transcript path is the
  `output-file` from the `<task-notification>` (direct dispatch) or the
  workflow's `agent-<id>.jsonl`. It writes the activity split — and the
  dominant bucket is almost always `reasoning`: the model thinking and
  generating code, not test runs; naming it is the point.
- **`<id>.cost.json`** — `{ tokens, agents, dispatches }`. `tokens` is
  `subagent_tokens` from the notification (sum across a ticket's dispatches);
  `agents`/`dispatches` you already know. Free at accept, gone later.
- **`<id>.findings.json`** — `{ worker, rationale, amendments, escaped_bugs }`.
  The worker's notable finding (from its result), your one-line accept rationale,
  and any oracle amendment or escaped-bug this ticket triggered. This is the
  searchable "what did we learn / what bit us" record — otherwise it survives
  only in commit bodies and the reaped transcript.
- Optionally **`<id>.verify.json`** — `{ verdict, gaming, scope, flakes }` — the
  gaming-read verdict and scope result, if worth freezing beyond the ledger.

Same rule as check output: sidecars are the bulk home; `backlog.json` stays lean
(the ticket's `evidence` field still points at `<id>.txt`).

### 2.4 Enforce the caps
**Before every re-dispatch** (per ticket, read from the scheduler's
`capBreaches` and `thrashBreaches` — never from memory or an eyeballed diff of
failure notes):
- attempts ≥ `maxAttempts` (`capBreaches`), **or**
- the failing set hasn't shrunk across `thrash` consecutive attempts
  (`thrashBreaches`)
→ **stop and escalate**: the ticket, its last re-verify result, your best
diagnosis of the wall (the `attempts` log writes this report for you), and the
specific human decision you need. Do not loop again on that wall.

There is no dispatch budget: ledger each dispatch as it happens (the audit
trail, not a countdown) and keep driving. Only completion or a wall ends the
run.

Then loop back to 2.1.

---

## Termination & report

A run ends one of two ways — length, compaction, or dispatches spent are never
endings. (An *interrupted* run — killed session, crash — is not an ending
either: the next invocation picks it up from `.ailoop/`; see **Resume**.)

1. **Backlog drained (`complete: true`) and every phase oracle green** →
   **read `references/termination.md` and follow it**: the coverage pass
   (unmapped spec requirements mean the build is NOT done), the final report
   (run audit + per-ticket dossier via `report.mjs --out`, oracle evidence,
   coverage, drift — computed, not narrated), and the campaign close (flip the
   spec to `done`, delete `.ailoop/`). Never close a campaign — or report the
   build done — without it.
2. **Escalation** — closes nothing: the spec stays `locked` and `.ailoop/`
   stays put, so the resolved escalation resumes exactly where it stopped.
   The report is "stuck at ticket T, here's the wall and the decision I
   need" — never a rosy summary of a loop that didn't finish.

## Resume — after an interruption or a resolved escalation

`.ailoop/` exists → a previous run already did intake; skip it entirely. Read
`oracle.md`, the ledger tail,
and run the scheduler. Reconcile before dispatching. If the last run ended on an
escalation, open with a stamped `resume`-kind ledger entry (subject `run`) — it
closes the human-pause window the `escalate` entry opened, so the run audit
credits that idle time to the human, not the loop.

- **Contract changed** — recompute the spec's sha256 and compare it to the
  contract identity in `oracle.md`. Mismatch → the spec changed since intake
  (read its Change orders section to see what and why — the spec is
  untracked, so that section is the *only* record; there is no git diff
  behind it): **stop before any
  dispatch** and reconcile with the human. A change to *what behavior counts
  as done* goes through the semantic amendment tier; a structural change may
  need affected backlog tickets reseeded. Never resume silently against a
  changed contract — the loop would drive the old spec to green with every
  guard satisfied.
- **Stale `in-progress`** (a previous run ended mid-ticket): don't guess what
  happened. Workers build on branches, so look for the ticket's worker branch
  (`git branch --list` / `git worktree list`). Branch exists → independently
  re-verify it like any worker result (green → judge, merge; red → reset to
  `todo` with an `attempts` entry noting the interrupted run). No branch →
  nothing durable happened; reset to `todo`.
- **Legacy formats** (a markdown `backlog.md`, or a *tracked* `.ailoop/` /
  `specs/`, from an older version of this skill): convert to `backlog.json` /
  `git rm -r --cached` + gitignore once on first resume, preserving all
  tickets and history verbatim; ledger entry.

The files are the whole memory. If a fact from a previous run matters and isn't
in them, it's gone — that's a bug in what was written, and the fix is to write
more into the ticket/ledger *this* run, not to try to remember harder.

---

## Durable state — the `.ailoop/` directory

Trust these files over your recollection; they are what survives context
compaction and an interrupted run. The directory is untracked (intake step 7) and
lives exactly as long as its campaign — created at intake, deleted at
termination — so its presence is what marks which spec is in flight.

- **`backlog.json`** — the **forward** state and the loop driver: tickets with
  status, phase, dependencies, per-ticket `attempts` logs. Bulk never lives
  here — captured output goes to `evidence/`.
- **`schedule.mjs`** / **`verify.mjs`** / **`report.mjs`** / **`timing.mjs`**
  — the deterministic scripts, copied from templates at intake: scheduler
  (see **The scheduler**), mechanical verifier + flake probe + resource
  leases (see **Verification**), run auditor + dossier assembler (see
  **Termination**), and per-ticket transcript parser (see **2.3b**).
  Arithmetic lives in them, never in your eyeballing (Prime directive 6).
- **`oracle.md`** — the **definition of done**: locked decisions, the scope
  tripwire list, the baseline gate, the executable per-phase checks, the
  contract identity, and the spec→delivery coverage map. Written at intake;
  amendable only per the amendment tiers; workers cite it; you gate against it.
- **`ledger.md`** — the append-only **journal**: every dispatch, every judge
  decision and why, oracle amendments, red-team findings, decompositions,
  drift flags, escalations. Each entry opens with a stamped, machine-readable
  header (`[<seq> | <isoTs> | <kind> | <subject>]`) followed by the prose body
  — the header is the loop's only timing record, so append entries with a
  **live `date` read** (`$(date -u +%FT%TZ)`), never a hand-typed time; a
  forged or missing stamp is the one way to blind the audit. `report.mjs`
  parses the header, never the prose. Timing is telemetry: a malformed stamp
  costs one unmeasured gap in the audit, never a broken loop.
- **`evidence/`** — captured check output per re-verify (`T017.txt`;
  failed-attempt logs `T017-a2.txt`), the dumped diff per verify
  (`T017-diff.patch` — the gaming read's input), and the per-ticket dossier
  sidecars `<id>.<kind>.json` (2.3b). Tickets and the ledger hold pointers
  into it; `backlog.json` stays lean.

Update `backlog.json` after every ticket outcome and `ledger.md` after every
judge decision.

## Guards checklist (re-read before each dispatch)

- [ ] Ready set / batches / breaches / thrash / phase drain / completion came
      from `schedule.mjs` output — not from eyeballing the backlog.
- [ ] The ticket is cold-start runnable (self-contained `context`; full
      `attempts` log included on retries), with a non-empty `files`
      declaration, a `phase` tag, and every scheduler-reported `missingFiles`
      path resolved as an intentional create, not a guessed home.
- [ ] Its `acceptance` is executable (not vibes) and was red-teamed — at intake
      for seeded tickets, at creation for decomposed children and repairs.
- [ ] Worker dispatched into a worktree with `baseSha` captured; ledgered as a
      dispatch; workers cite locked decisions, none re-litigated.
- [ ] **Independent re-verify** green per **Verification**: `verify.mjs`
      (clean tree, full fast tier + `acceptanceChecks`, scope ⊆ declared ∪
      manifest allowlist, no baseline regression) + the gaming read (skipped
      only for `scaffold` tickets).
- [ ] Evidence written to `.ailoop/evidence/` and pointed at — never inlined
      into `backlog.json`.
- [ ] On accept, per-ticket sidecars captured **while the transcript still
      exists** (2.3b): timing, cost, findings.
- [ ] Only merged-tree checks count as green; gate-tier baseline + phase
      oracle run when the scheduler says the phase drained; branches kept
      until the gate is green, pruned after. Gate red after a clean merge →
      bisect + repair ticket; never patch the tree yourself.
- [ ] Oracle changed only via the amendment tiers, each with a ledger entry.
- [ ] Nothing built crosses the out-of-scope list.
- [ ] `backlog.json` and `ledger.md` updated — ledger entry appended with a
      live-`date` stamp and a `kind` in its header; coverage map current.
- [ ] Nothing under `.ailoop/` or `specs/` staged or committed — campaign
      state stays untracked; the rare mainline commit you author yourself
      goes through the `commit` skill.

## Scope of this skill

- **One invocation, one run to done.** No dispatch cap and no mid-run
  checkpoint: the run ends at completion or escalation, however many hours and
  phases that takes. The `.ailoop/` files are the only memory across compaction
  and interruptions.
- **No token budgeting.** The main loop has no spend gauge, so a token cap
  would be enforced by guesswork — and fictional numbers in the audit trail are
  worse than no cap. The real guards are attempts and thrash;
  cost control is scripted measurement (`verify.mjs`) plus model tiering
  (top-tier judgment, Sonnet builders, Haiku only on tickets marked
  mechanical), not budget arithmetic.
- **Fully autonomous.** The only human touches in a healthy run
  are the intake pre-flight and the final report.
  Everything else is escalation, which by definition means the loop couldn't
  proceed safely.
