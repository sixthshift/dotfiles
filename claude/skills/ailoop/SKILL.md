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
- **One invocation runs to completion.** There is no dispatch cap: the run
  ends only when the backlog is drained and every phase oracle is green, or on
  escalation. Hours-long runs spanning many phases are the intended shape —
  never end a run early because it is long, the context was compacted, or many
  dispatches have been spent. Context **will** be compacted mid-run; the
  `.ailoop/` files, not the conversation, are the loop's memory. Anything worth
  surviving compaction or an interruption must be written to them — a fact held
  only in conversation is a fact the loop will eventually lose.
- **You (the coordinator)** are the main loop executing this file. You pull
  ready tickets, dispatch them (a single subagent, or a
  Workflow fanning out a batch of independent ones), wait for the
  `<task-notification>`, read the structured result, judge, update the backlog,
  and pull the next — until the backlog is drained or
  you must escalate.
- **Each ticket is built by a fresh subagent.** One ticket = one cold subagent
  with no memory of this conversation. That is deliberate: it bounds context and
  makes progress durable. It also sets the ticket-quality bar (see the schema).
- **Batches of independent ready tickets** fan out via a `Workflow` (see
  `templates/build-phase.workflow.js`): one worker per ticket in its own git
  worktree, then merge, then gate. Deterministic, backgrounded, resumable.

You do **not** need the `loop` skill. `loop` is for interval/recurring
re-invocation; ailoop runs to completion in one invocation and is re-invoked
only to resume after an interruption or a resolved escalation.

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
- The backlog is durable state. It survives compaction *and any interruption*:
  the loop's position is *"what does the scheduler say,"* not
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
- **`attempts`** is the durable diagnosis log — one entry per failed attempt:
  `{ "n": 1, "failed": ["<check name>", ...], "hypothesis": "<why>", "fixNote":
  "<instruction given on re-dispatch>" }`. `failed` is an **array of check
  names**, not prose — the scheduler compares consecutive attempts' failing
  sets to detect thrash mechanically; freeform text there would put that
  arithmetic back on you. The log exists because compaction and interruptions
  mean a re-dispatch may happen in a context that never saw the failure: the ticket
  carries its own failure history the way it carries its own context. Thrash
  detection reads this log via the scheduler, never your memory.

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
- **Red-team the children's fresh `acceptance`** the same way intake acceptance
  was red-teamed (Stage 1.5). Mid-flight tickets — decomposed children and
  repair tickets — are the only ones that would otherwise skip that pass, and
  they're born precisely where something already went sideways. Ledger the pass.

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
   intake (Stage 1.0) and classify each into a tier:
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

The builder runs all of this itself and returns the evidence — but its word is
a **claim**. The authoritative signal is the **independent re-verify**: a
separate agent (or you) re-checks the ticket's tree before the ticket is
accepted. In the fan-out Workflow this is a dedicated Verify stage per ticket,
run on the worker's worktree *before* integration; for a single-ticket
dispatch, you re-run it yourself. The re-verify is more than re-running the
builder's commands:

- **Re-run baseline + acceptance** (mechanical: exit codes and captured output,
  not the builder's transcript). The verifier runs the full fast tier — plus
  the ticket's own gate-tier tests — even where the builder scoped it.
- **Scope check (mechanical).** `git diff --name-only <baseSha>..<branch>`,
  where `baseSha` is the fork point you captured (`git rev-parse HEAD`)
  immediately before dispatch — the verifier is handed the SHA, never left to
  guess a merge-base. Every touched path must be in the ticket's declared
  `files` or the manifest allowlist (`package.json` + lockfiles — any ticket
  may add a dependency). An undeclared touch **fails the ticket** with the
  overflow listed. This is what lets the parallelism scheduler trust `files`.
- **Gaming read (judgment).** Read the diff and ask: was the acceptance
  satisfied by implementing the intent, or by gaming the check — hardcoded
  outputs, weakened or deleted tests, special-cased inputs? Suspicion doesn't
  auto-fail; it comes to you with the *why*, and you judge against the spec. A
  confirmed gamed ticket is a failed attempt **and** triggers the escaped-bug
  rule (below).

Three gates, widening — a ticket must pass the narrow one to earn the next:

**fast-tier baseline + acceptance + scope (independently re-verified, per
ticket) → integration (merge clean) → gate-tier baseline + phase oracle
(merged tree).**

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

Do this once, on the first invocation only (see **Resume** for re-invocations
after an interruption). Produce `.ailoop/oracle.md`, `.ailoop/backlog.json`, and
`.ailoop/ledger.md` (templates in `templates/`), copy
`templates/schedule.mjs` → `.ailoop/schedule.mjs`, and create
`.ailoop/evidence/` for captured check output. This is the pre-flight; the
human sees it and the drive runs unattended after.

0. **Locate the spec.** Use the path the user gave. Otherwise look for a locked
   build spec in the repo root or `docs/` (`spec.md`, `SPEC.md`, `PLAN.md`, or
   similar). If none exists, or several plausible candidates do, **stop and ask**
   — do not guess which document is the contract. A spec authored by the
   `aispec` skill carries `status:` frontmatter: `locked` is a contract;
   **`draft` is a refuse-to-start** — send the human back to `/aispec` to
   finish it. Also detect the project's own
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

   Also record in `oracle.md`: the **baseline gate** — the type-check / build /
   lint / test commands (from Stage 1.0's toolchain detection) that *every*
   ticket must pass regardless of what it touches, classified into fast tier
   (per ticket) and gate tier (per phase close) per **Verification**
   — and the **contract identity**: the spec's path, its `spec_version` (if the
   frontmatter has one), and its sha256 content hash (`shasum -a 256`). Resume
   verifies this identity before every run; it is what makes a mid-drive spec
   change detectable instead of silent.

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
   (full schema above), each tagged with its `phase` and a **non-empty**
   `files` declaration **anchored in evidence**: every declared path either
   exists and demonstrably hosts the behavior (grep for it; cite the anchor in
   `context`) or is an explicit create. Never infer what the codebase probably
   calls things — a guessed home is a wasted dispatch when the builder
   discovers the real one, and it is the single most repeated footprint bug in
   practice. Wire `depends_on` so the graph encodes the spec's
   de-risk order — the riskiest phase's tickets come first and downstream
   tickets depend on them. Err small; you will decompose further mid-flight
   anyway. Do **not** try to enumerate every ticket for late phases perfectly —
   seed them coarsely and refine as earlier tickets teach you the shape.

   Then write the **coverage map** into `oracle.md`: every requirement/section
   of the spec → the ticket(s) or oracle check that delivers it. A requirement
   with no entry gets a ticket now or an explicit "deferred" line — silence in
   this map is how an under-derived intake finishes an incomplete build with
   every check green. Update the map as tickets decompose.

5. **Red-team the acceptance.** Before any build spend, an adversarial pass
   over every seeded ticket (fan out a few cheap agents, one per phase's
   tickets): *"how could a lazy builder pass this acceptance without delivering
   the spec's intent?"* Each cheat found = sharpen the check. Prefer
   input→output contrast checks ("these 3 JDs must flip the lede differently")
   over artifact-existence checks ("file exists", "function returns") —
   existence is the most gameable form. Record the pass in the ledger.

6. **Set the caps.** In `backlog.json`'s `caps`: per-ticket max attempts
   (default 3) and the thrash threshold (a ticket's failing set doesn't shrink
   across 2 attempts → escalate; the scheduler computes this from the
   `attempts` log). There is no cap on total dispatches — the run goes to
   completion. Snapshot the caps in the ledger run header.

Report the intake to the user as a short pre-flight: the phase→oracle map, the
seeded backlog (ticket count + the first few ready tickets + the dependency
spine), the caps, the red-team findings, and any oracle you had to ask them to
supply. Then drive.

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

**Model tiering — builders may downgrade, gates never do.** Builder agents run
`model: 'sonnet'` (single-ticket dispatch and the Workflow's Build stage alike):
the locked spec and the ticket's self-contained brief constrain them, and the
independent re-verify catches what they get wrong. Everything that *judges* —
the Verify stage, the integrator, the phase-oracle gate, and you the coordinator
— stays on the session model, no override. The failure mode this split guards
against is the reverse: a cheap judge rubber-stamping expensive (or cheap)
workers costs loop iterations; never downgrade the gate.

- **Single ticket** → one `Agent` subagent (`model: 'sonnet'`,
  `isolation: 'worktree'`) — **never on the main working tree**: an
  interrupted worker must leave a branch to reconcile, not a dirty tree, and
  the scope check needs a defined diff base. Capture `baseSha`
  (`git rev-parse HEAD`) immediately before dispatch. The prompt is the
  ticket's `context` + `acceptance` + the baseline gate + the frozen locked
  decisions + the declared `files` (touch only those, plus manifest/lockfile
  for dependencies) + **the full `attempts` log if this is a retry** — a fresh
  session must never re-diagnose from scratch. It must build, add tests for
  new behavior, run the fast-tier baseline + acceptance (it may scope the
  full-suite step to
  affected tests), and report its **branch** with the captured output. Then
  **you re-verify on that branch** (full fast tier + acceptance + scope check
  via `git diff --name-only <baseSha>..<branch>` + gaming read) before
  accepting — its self-report is only a claim. On accept, merge the branch
  into the mainline; if the mainline moved past `baseSha` since the fork,
  re-run the fast tier on the merged tree — that is the integration gate a
  batch run would have given you.
- **A disjoint batch** → the `build-phase` Workflow (see the template),
  passing `baseSha` (`git rev-parse HEAD` at invocation) alongside the
  tickets, frozen decisions, baseline, and phase oracle: one worker `agent()`
  per ticket, each `isolation: 'worktree'`, a per-ticket **Verify** stage
  pipelined behind each build, then **merge** the verified ones, then gate on
  the merged tree (skipped when nothing merged — `oracle: null`).

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
- **Red-team upcoming acceptance early.** Fan out the Stage 1.5-style
  adversarial pass over soon-to-be-ready tickets now, not at dispatch time —
  decomposed children and repair tickets especially, so their mandatory
  red-team never sits on the critical path.
- **Coverage map and ledger upkeep.**

Write every result into the `.ailoop/` files as it lands — prep held only in
context dies at compaction. Prefer cheap background agents over your
own context for the fan-out parts; your context is the loop's scarcest
resource.

### 2.3 Judge each result
The judgment the inner body cannot do:
- **`done` + independent re-verify green** (baseline + acceptance pass, no
  out-of-scope files, no credible gaming suspicion) **+ in scope** → mark the
  ticket `done`, write the **re-verify** evidence to
  `.ailoop/evidence/<id>.txt` and store the pointer on the ticket, update the
  backlog. This may unblock downstream tickets.
- **re-verify red** — acceptance failed, the ticket **regressed the baseline**,
  OR it **touched undeclared files** → the ticket failed. Diagnose *why* using
  the spec — many specs tell you where to look (e.g. "if the behavior doesn't
  flip, the prompt is wrong, not the code"). Several failures in one batch →
  fan out one diagnosis agent per failed ticket, in parallel; the diagnoses
  are independent, and you judge their output — serializing them is pure
  wall-clock waste. Append an `attempts` entry
  (`failed` / `hypothesis` / `fixNote`) to the ticket — the diagnosis must
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
- **Gaming suspicion** (verifier flagged the diff) → you read the diff and
  judge against the spec's intent. Gamed → failed attempt (append to
  `attempts`) **and** sharpen the acceptance that was gamed (escaped-bug rule).
  Clean → accept and note why in the ledger.
- **`tooBig`** → mark the parent `decomposed`, push the proposed child tickets
  onto the backlog with dependencies, and do the decomposition bookkeeping
  (see **Decomposition**): rewire the parent's dependents onto the children,
  give children the parent's `phase`, refine their `context`/`acceptance` so
  each is cold-start runnable, and red-team the fresh acceptance. This is
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

1. **Backlog drained (`complete: true`) and every phase oracle green** → run
   the **coverage pass** before writing the final report: re-read the spec
   against `oracle.md`'s coverage map — every requirement must point at a
   `done` ticket or a green check, or sit explicitly under Cut / deferred. An
   unmapped requirement means the build is **not** done, whatever the backlog
   says: seed the missing tickets and keep driving. Then the **final report**:
   - **Shipped:** what was built, keyed by phase / ticket.
   - **Oracle evidence:** the passing check output per phase (the proof, not
     your say-so).
   - **Coverage:** the spec→delivery map, every requirement resolved as
     shipped or explicitly deferred.
   - **Backlog history:** tickets completed, decomposed, repaired — the shape
     of the work, honestly.
   - **Cut / deferred:** anything the spec deferred or you consciously left out.
   - **Drift caught:** scope tripwires, retries, gamed tickets, gate-red
     bisections, oracle amendments — plain, not smoothed over.
2. **Escalation** → "stuck at ticket T, here's the wall and the decision I
   need" — never a rosy summary of a loop that didn't finish.

## Resume — after an interruption or a resolved escalation

`.ailoop/` exists → a previous run already did intake; skip it entirely. Read
`oracle.md`, the ledger tail,
and run the scheduler. Reconcile before dispatching:

- **Contract changed** — recompute the spec's sha256 and compare it to the
  contract identity in `oracle.md`. Mismatch → the spec changed since intake
  (read its Change orders section to see what and why): **stop before any
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
- **Legacy markdown backlog** (`backlog.md` from an older version of this
  skill): convert it to `backlog.json` once, preserving all tickets and history
  verbatim; ledger entry.

The files are the whole memory. If a fact from a previous run matters and isn't
in them, it's gone — that's a bug in what was written, and the fix is to write
more into the ticket/ledger *this* run, not to try to remember harder.

---

## Durable state — the `.ailoop/` directory

Trust these files over your recollection; they are what survives context
compaction and an interrupted run.

- **`backlog.json`** — the **forward** state and the loop driver: the ticket
  queue with status, phase, dependencies, and per-ticket `attempts` diagnosis
  logs. "Where is the loop?" is answered by the scheduler, never by memory.
  Bulk never lives here — captured output goes to `evidence/`.
- **`schedule.mjs`** — the deterministic scheduler (copied from templates at
  intake). Ready sets, batches, cap/thrash breaches, phase drain, completion —
  computed, never eyeballed.
- **`oracle.md`** — the **definition of done**: locked decisions, the scope
  tripwire list, the baseline gate, the executable per-phase checks, and the
  spec→delivery coverage map. Written at intake; amendable only per the
  amendment tiers (mechanical = self-serve + ledger entry; semantic =
  escalate); workers cite it; you gate against it.
- **`ledger.md`** — the append-only **journal**: every dispatch, every judge
  decision and why, oracle amendments, red-team findings, decompositions,
  drift flags, escalations. The audit trail — how the loop
  got where it is.
- **`evidence/`** — captured check output, one file per re-verify
  (`T017.txt`; failed-attempt logs `T017-a2.txt`). Tickets and the ledger hold
  pointers into it; `backlog.json` stays lean.

Update `backlog.json` after every ticket outcome and `ledger.md` after every
judge decision.

## Guards checklist (re-read before each dispatch)

- [ ] Ready set / batches / breaches / thrash / phase drain / completion came
      from `schedule.mjs` output — not from eyeballing the backlog.
- [ ] The ticket is cold-start runnable (self-contained `context`; full
      `attempts` log included on retries) with a non-empty `files` declaration
      and a `phase` tag.
- [ ] Scheduler `missingFiles` resolved for the ticket: every missing declared
      path is an intentional create, not a guessed home.
- [ ] Its `acceptance` is executable (not vibes) and was red-teamed — at intake
      for seeded tickets, at creation for decomposed children and repairs.
- [ ] Decomposed parents: dependents rewired onto the children.
- [ ] Worker dispatched into a worktree with `baseSha` captured; ledgered as a
      dispatch.
- [ ] Worker ran the fast-tier baseline (full-suite step may be scoped to
      affected tests) + acceptance; new behavior has new tests, green under it.
- [ ] **Independent re-verify** passed: FULL fast tier + the ticket's own
      gate-tier tests + acceptance green,
      touched files (diffed from `baseSha`) ⊆ declared ∪ manifest allowlist,
      diff read for gaming — and no baseline regression.
- [ ] Evidence written to `.ailoop/evidence/` and pointed at — never inlined
      into `backlog.json`.
- [ ] Workers cite locked decisions; none re-litigated.
- [ ] Only merged-tree checks count as green; gate-tier baseline + phase
      oracle run when the scheduler says the phase drained; branches kept
      until they're green, pruned after.
- [ ] Gate red after a clean merge → bisect + repair ticket; never patch the
      tree yourself.
- [ ] Oracle changed only via the amendment tiers, each with a ledger entry.
- [ ] Attempt/thrash breaches read from the scheduler before every re-dispatch.
- [ ] Nothing built crosses the out-of-scope list.
- [ ] `backlog.json` and `ledger.md` updated; coverage map current.

## Scope of this skill

- **One invocation, one run to done.** No dispatch cap and no mid-run
  checkpoint: the run ends at completion or escalation, however many hours and
  phases that takes. The `.ailoop/` files are the only memory across compaction
  and interruptions.
- **No token budgeting.** The main loop has no spend gauge, so a token cap
  would be enforced by guesswork — and fictional numbers in the audit trail are
  worse than no cap. The real guards are attempts and thrash;
  cost control is model tiering (Sonnet builders, session-model gates), not
  budget arithmetic.
- **Fully autonomous.** The only human touches in a healthy run
  are the intake pre-flight and the final report.
  Everything else is escalation, which by definition means the loop couldn't
  proceed safely.
