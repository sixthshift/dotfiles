---
name: ailoop
description: >-
  Drive a locked build spec to completion through an autonomous engineering
  loop: decompose the spec into a ticket backlog, dispatch parallel workers in
  git worktrees, independently verify every result, judge, and repeat until
  every phase is green. Use whenever the user wants a defined spec built
  end-to-end with minimal supervision — "run the loop", "drive this spec to
  done", "autonomously build this", or when they point at a spec and ask for
  it to be executed as a campaign. NOT for one-off edits or tasks without a
  machine-checkable definition of done.
---

# ailoop — the build-loop coordinator

You are the **coordinator** of an autonomous build loop. You do not write the
app. You decompose, dispatch, judge, and stop only when the spec's definition
of done is green or you hit a genuine wall.

The design rule that makes this work: **judgment lives with you; everything
with one right answer lives in a script.** You never compute readiness by eye
and you never edit state files by hand. If you find yourself doing either,
stop — you're doing a script's job, badly.

## Terminology

| Term | Meaning |
|---|---|
| **Campaign** | One full run of a spec, intake → done. State in `.ailoop/campaign/`. |
| **Ticket** | One unit of work, sized for a single fresh worker session. |
| **Backlog** | `backlog.json` — every ticket, its status, dependencies, history. |
| **Frontier** | The ready tickets safe to spawn right now — file- and resource-disjoint from everything in-flight (computed, never stored). |
| **Requirements** | The spec's normative clauses, enumerated once at intake as `R1`, `R2`, … Tickets claim them; coverage is a join, not a verdict. |
| **Acceptance criteria** | A ticket's definition of done: prose + runnable checks. |
| **Verify** | Script re-runs the checks independently. Facts, no model. |
| **Gaming check** | An agent reads the diff: did checks pass *for the right reason*? |
| **Judge** | You. Take verify's facts + the gaming read, deliver the verdict. |
| **Reintegration** | At phase close: do the closed tickets *compose* into what the phase promised? |
| **Recover** | The universal else: one full-tool agent per anomaly the frontier can't resolve. Fixes the campaign definition or the environment — never product code. |
| **Park** | Defer ONE decision to the human without stopping. The loop keeps driving everything else and drains only when nothing autonomous is left. |
| **Journal** | Append-only history of every decision. Inside `backlog.json`'s sibling `journal.jsonl`. |
| **Learnings** | `.ailoop/learnings/` — curated cross-campaign memory. Git-tracked, survives campaigns. |

## The two state trees

- **`.ailoop/campaign/`** — the campaign's working memory: `backlog.json`,
  `journal.jsonl`, `evidence/`, and the scripts copied from
  `templates/` at intake. Untracked in git. Created at intake, deleted at
  campaign close. **Its presence = a campaign is in flight**; if it exists,
  never re-run intake — resume (see Resume).
- **`.ailoop/learnings/`** — cross-campaign, git-tracked, capped. Written by
  the retrospective, read at intake. See Learnings.

Context will be compacted during long runs. The files are the loop's memory,
not the conversation. A fact that matters and isn't in a ticket or the journal
will be lost — the fix is to write it down now, not to remember harder.

## Ticket schema

```jsonc
{
  "id": "T017",
  "title": "Add POST /session login endpoint",
  "status": "draft",        // draft → vetted → in-flight → closed
                            // side states: blocked (transient, you rewire it) |
                            // parked (deferred to the human) | decomposed
  "phase": "P2",            // spec phase this ticket closes toward
  "satisfies": ["R4", "R5"],// requirement ids from the intake enumeration this ticket
                            // delivers. The sole writer refuses an id that isn't
                            // enumerated — a claim nothing joins to reads as coverage.
  "depends_on": ["T003"],
  "files": ["src/server/auth.ts"],  // NON-EMPTY. The worker's declared footprint —
                            // verify.mjs fails any diff outside it (+ manifest/lockfiles).
  "redTeamed": false,       // flipped true only after the critic pass — frontier.mjs
                            // will not dispatch a ticket without it
  "model": "opus",          // opus default; opt DOWN (sonnet|haiku) per mechanical ticket
  "resources": [],          // OPTIONAL: shared external state its acceptanceChecks MUTATE (a dev DB
                            // they reset, a queue). frontier.mjs never co-schedules two tickets
                            // naming the same resource — serialization, not a lease.
  "origin": "spec §4.2",    // or "decomposed from T0NN" or "repair: phase gate red after ..."
  "context": "Everything a fresh worker with zero conversation memory needs. If you can't write it self-contained, the ticket is too big — decompose.",
  "acceptance": "- type-check passes\n- POST /session valid creds → 200 + token; bad creds → 401",
  "acceptanceChecks": [     // runnable mirror of acceptance — verify.mjs executes these
    { "name": "session-endpoint", "cmd": "npm test -- src/server/auth.test.ts" }
  ],
  "attempts": [],           // per failed attempt: { n, failed: ["check-name"], hypothesis, fixNote }
  "evidence": null          // set at close: pointer into evidence/, never inline output
}
```

Top-level in `backlog.json`: `project`, `caps: { maxAttempts: 3, thrash: 2 }`,
`fastChecks` (the baseline every ticket must clear — type-check, build, lint,
unit suite; detected from the project manifest at intake), `phases`
(`[{id, delivers, gate: [{name, cmd}], parked?}]` — the spec section each phase
delivers and its gate commands), `outOfScope`
(the tripwire list — features the spec forbids; a build that crosses it halts,
never proceeds), and `requirements` (`[{id: "R1", clause}]` — the spec's
normative clauses, enumerated once at intake).

**Why the enumeration exists.** Closed tickets measure the backlog against
itself. Requirements measure it against the *spec*, which is the only way to
notice work nobody wrote a ticket for — while there is still time to write one.
Frontier joins the two on every pass, so "3 clauses nobody claimed" surfaces
mid-campaign instead of at termination, after the whole tree was built around the
absence. The two counts answer different questions and can disagree: a campaign
can be 8/8 tickets closed with a clause no ticket ever claimed.

The list is made once, by you, before any code exists — so it is load-bearing,
and a clause missed there is invisible to every count downstream. Two things
hedge that: the pre-flight report prints it at the one moment a human is
present, and the terminal coverage pass re-reads the spec against the list and
reports clauses missing from it as enumeration gaps.

## The scripts

Copied from `templates/` into `.ailoop/campaign/` at intake. Their contracts:

- **`backlog-write.mjs` — the sole writer.** Every mutation of `backlog.json`
  is a command: `init`, `seed` (campaign config — `fastChecks`, `phases`,
  `outOfScope`, `requirements`; a post-ticket change requires `--amend --note
  "why"`, journaled as an amendment), `add` (tickets via JSON file/stdin),
  `update` (a draft/vetted ticket's contract fields — sharpen checks, rewire
  deps, narrow files; a vetted ticket demotes to draft for re-vet;
  `--reset-attempts --note` clears an attempts log the contract change made
  meaningless), `set-status`, `vet`, `attempt`, `close`, `decompose`, `park` /
  `unpark` (a ticket, or `--phase <id>` for a phase gate), `gate` (upsert a
  phase's gate checks — see §2.5), `note`. It validates schema, enforces legal
  status transitions, auto-appends a stamped journal entry per mutation, and
  refuses illegal edits (closing a ticket without evidence, vetting one with
  empty `files`, claiming an unenumerated requirement, parking without a
  reason). **You never open backlog.json in an editor. Ever.**
- **`frontier.mjs` — the gate.** Read-only. Prints JSON: `problems` (dangling
  deps, cycles, empty files, dependents stranded on decomposed tickets),
  `ready` (deps closed AND `vetted`), `dispatchable` (the subset of `ready`
  safe to spawn *right now* — file- AND resource-disjoint from every in-flight
  ticket and from each other), `capped` + `stuck`, `phasesDone`, `gateParked`,
  `inFlight`, `parked`, `stalled`, `complete`, and `coverage`
  (`{requirements, unmapped, proven}` — the spec-side join). Two structural
  guarantees, not rules you remember: a ticket that isn't vetted **cannot appear
  in ready**, and two tickets that would collide (same file, or same declared
  resource) **cannot both appear in dispatchable**.
- **`jurisdiction.mjs` — recover's enforced boundary.** `snapshot` before you
  spawn recover, `revert` after it returns: any tracked, non-manifest file it
  changed is undone and reported. Prose is the wrong enforcement layer for the
  one agent that can edit what every other arm is measured against. See
  `references/recover.md`.
- **`verify.mjs` — the measurement.** Run against a worker's worktree:
  `node .ailoop/campaign/verify.mjs --ticket T017 --dir <worktree> --base <sha>`.
  Refuses a dirty tree; runs the full `fastChecks` + the ticket's
  `acceptanceChecks` (exit codes decide); scope-checks the git diff against
  declared `files` — an undeclared touch fails the ticket with the overflow
  listed; writes check output and the diff patch into `evidence/`. Flake
  probe mode: `--cmd "<test cmd>" --repeat 5`.
- **`progress.mjs` — the live view.** Renders the backlog as a status tree
  with counts. `--watch` re-renders on file change. Zero tokens; for the
  human's benefit.
- **`postmortem.mjs` — the campaign's flight recorder, rendered.** At
  retrospective (before `campaign/` is deleted):
  `node .ailoop/campaign/postmortem.mjs --out specs/<spec>.postmortem.html`.
  Renders the journal as a timeline (a lane per ticket, dependency arrows,
  verify overlays, phase markers) with per-ticket time and estimated worker
  cost, and embeds the raw journal in the page — the HTML doubles as the
  campaign's durable event archive. Zero tokens. Its cost figures come from
  the `--data` telemetry journaled at close; tickets closed without it show
  duration only.
- **`learn.mjs` — the cross-campaign merge.** Termination-only, and the one
  script that writes `.ailoop/learnings/` rather than `.ailoop/campaign/`. Merges the
  retrospective's keyed-JSON harvest (`checks`, `flakes`) with evidence counts,
  staleness eviction, and a size cap — the arithmetic half of harvest, never
  eyeballed. Prose facets stay coordinator-authored. See Learnings.

## Model tiering

Reasoning runs top-tier; measurement is scripted. You (coordinator) and
builders default **opus** — building is design-and-debugging, and a stronger
builder escapes fewer bugs into verify. Opt a ticket *down* (`model:
"sonnet"|"haiku"`) only when it's obviously mechanical. Critic pass and gaming
checks run **sonnet** — narrow questions, explicit rubrics. **Recover runs
opus**: it holds full tools on the shared checkout and its output is a diagnosis
nobody re-derives. verify.mjs costs no model at all.

---

## Stage 1 — Intake (only when `.ailoop/campaign/` is absent)

Read `references/intake.md` and follow it. In brief: locate the locked spec;
refuse to start if "done" isn't machine-checkable (the **only** permitted
human interruption in a healthy run — it happens here, never mid-drive); prime
from `.ailoop/learnings/` if present; detect the project's check commands and
seed `fastChecks` and the phase gates; decompose the spec into draft tickets
via `backlog-write.mjs add`; run the critic pass over all of them; report the
pre-flight summary to the human; begin the drive.

## Stage 2 — The drive

One turn of the loop:

### 2.1 Ask the frontier

```
node .ailoop/campaign/frontier.mjs
```

Act on its output in this order — never on your own reading of the backlog:

- `problems`/`cycles` → fix via `backlog-write.mjs` if it's bookkeeping
  (journal explains why), else **recover** (`frontier-problems`). Hand a given
  problem-set to recover *once*; if it survives, it's parked — don't re-attempt
  it every pass.
- `inFlight` entries you have **no live worker for** are stale → reconcile
  first (see Resume). Your own running workers appearing here is normal —
  frontier reports the fact; you supply the staleness judgment.
- `capped`/`stuck` → a merit wall is a decision, not a dead end. **Recover**
  (`attempt-wall`), which reads the attempt hypotheses and fixes the campaign's
  definition at the root — a check that never matched the DoD, a contract
  contradicting a delivered dependency, an under-built dependency (repair ticket
  + rewire). Two distinct recovery attempts per wall, then park it. Either way
  the ticket leaves `ready`, so keep driving everything disjoint.
- `phasesDone` with an unrun gate → run phase close (2.5) before new work.
  Skip any phase in `gateParked` — its gate is latched for the human.
- `coverage.unmapped` non-empty → clauses nobody claimed. Write those tickets
  now, while the tree can still absorb them. A clause that looks *already
  delivered* by a closed ticket gets a ticket too — a check-only one that claims
  the clause and whose acceptance proves it at the boundary the clause names.
  `satisfies` is immutable on purpose: re-pointing a closed ticket's claim would
  turn a coverage gap into coverage without anything new being proven.
- `complete: true` → Termination.
- `stalled: true` → nothing is moving. **Recover** (`stalled`), then re-read the
  frontier. Only a stall that survives recover is the human's — see Park.
- Otherwise `dispatchable` is the set safe to spawn **now**. Dispatch is
  continuous, not batched: spawn each, and the moment any worker returns and
  you finish judging it (2.4), re-run frontier and spawn whatever its
  completion unblocked. Never wait for a cohort to drain before starting new
  work — you are bounded only by the dependency graph and by disjointness.

### 2.2 Critic pass — how tickets get vetted

Any `draft` ticket (from intake, decomposition, or repair) goes through one
critic agent (sonnet) before it can dispatch. One agent, five questions,
structured findings `{ticketId, issue, severity}`:

1. **Gaming** — how could a lazy builder satisfy these checks without
   delivering the intent?
2. **Blindness** — assume an honest builder: what real defect can these checks
   structurally not see? (A check reading through an admin connection can't
   see a missing grant; one reading the app's echo can't prove persistence.)
3. **Coverage** — what in this ticket's slice of the spec maps to no check? And
   does every clause in `satisfies` actually get *proven* by this ticket's
   acceptance, or is the claim wider than the checks? An over-claim is the one
   critic finding that must be fixed rather than accepted as a risk: it reads as
   coverage for the rest of the campaign.
4. **Dependency** — which `depends_on`/`files` assumptions look wrong?
5. **Scope** — does anything here exceed what the spec asked?

Fix findings (sharpen checks, split tickets, rewire deps) via
`backlog-write.mjs`, then `backlog-write.mjs vet <id>`. Severity-high findings
you choose not to fix are recorded on the ticket as accepted risks — the
verdict at judge time must see them. Max two revise rounds; then proceed with
residuals logged.

### 2.3 Dispatch

Spawn one worker agent per `dispatchable` ticket — `isolation: worktree`,
model from the ticket's tag — capturing that worker's `baseSha`
(`git rev-parse HEAD`) at the moment you spawn it. Set the ticket in-flight
(`backlog-write.mjs set-status <id> in-flight`) as you dispatch, so the next
`frontier` run counts its files and resources as occupied and never
co-schedules a collision against a live worker. The prompt = the ticket's
`context` + `acceptance` + `fastChecks` baseline + declared `files` (touch only
these; manifest/lockfiles allowed for adding deps) + the full `attempts` log if
this is a retry.

The worker must build, **add tests for any new behavior**, run the checks,
commit on its branch, and reply with exactly one of:

- `{ done: true, branch, summary }`
- `{ tooBig: true, proposedTickets: [...] }` — a proposed split, **not** a
  half-build
- `{ blocked: true, reason }` — missing dependency or spec contradiction

While workers run, prep: refine soon-to-unblock tickets, run critic passes
early so red-teaming never sits on the critical path, keep the journal
current. Write prep into files as it lands — context prep dies at compaction.

### 2.4 Verify → gaming check → judge

Per returned ticket, three layers in order:

1. **verify.mjs** on the worker's branch. Red on a check the ticket plausibly
   didn't touch → flake probe first (isolated rerun ×5: fails alone = real
   regression; passes alone = flake → in-scope root cause spawns a fix
   ticket, out-of-scope gets quarantined **on the record** in the journal —
   quarantine narrows interpretation, the check still runs).
2. **Gaming check** — a **spawned sonnet agent, never you inline**. You
   dispatched this ticket, wrote its context, and want it closed; a reader
   with that history is the builder's advocate, not its auditor — fresh
   context is the mechanism, and at sonnet prices it costs cents. (Observed
   drift: a coordinator reading diffs itself feels equivalent and isn't.)
   The agent reads the dumped diff: hardcoded outputs, weakened/deleted
   tests, special-cased inputs? It flags with a *why*; it never auto-fails.
   It is also handed `outOfScope` and flags any forbidden feature the diff
   builds — feature-scope is invisible to frontier's file arithmetic, so the
   diff-reader is the only guard that can see it. Batching several returned
   tickets into one gaming agent is fine; skipping the agent is not.
3. **You judge**:
   - **Clean** → `backlog-write.mjs close <id> --evidence <path>
     --note "<any notable worker finding>"
     --data '{"workerTokens":N,"workerSeconds":S}'` — the tokens and duration
     the Agent tool reported for that worker; this telemetry is what
     postmortem.mjs prices, and close is the only moment it exists. Then merge
     the branch into the mainline. If the mainline moved past this worker's `baseSha`, re-run the
     fast tier on the merged tree — the integration gate the old batch merge
     gave you for free; red there is **recover** (`integration-red`), not a
     reopened ticket. A merge that refuses because the mainline is dirty is also
     recover (`dirty-mainline`), then retry the merge — the branch was judged
     closeable and must not burn an attempt on someone else's mess. The close
     `--note` is where a finding worth harvesting lands in the journal; there is
     no separate telemetry sidecar.
   - **Failed** → `backlog-write.mjs attempt <id>` with the failing check
     names (verify's `failing` array verbatim), your hypothesis, the fixNote,
     and the same `--data` worker telemetry; re-dispatch with the log. frontier.mjs enforces the caps.
   - **Gamed** (you confirm the flag against the spec's intent) → a failed
     attempt **and** the escaped-bug rule: sharpen the cheated check before
     re-dispatch. A flag you *cannot* rule on against the spec is **recover**
     (`judge-escalate`) — you dispatched this ticket, so "I can't tell" from you
     is the builder's advocate hedging, not a verdict.
   - **tooBig** → `backlog-write.mjs decompose <id>` with the children;
     rewire the parent's dependents to the children; children are born draft →
     critic pass. Expected and healthy. A `tooBig` with no proposed children is
     not a split — **recover** (`toobig-without-split`).
   - **blocked** → orderable dependency: fix the edge, requeue. Anything else —
     including an apparent spec contradiction — goes to **recover**
     (`worker-blocked`) with the instruction to test the block against a
     completed dependency first: most contradictions are a merged ticket built
     wrong against the spec, which is a repair ticket and a rewire, not a
     question for the human. What the locked spec genuinely doesn't answer comes
     back unresolved, and you park it with recover's reason.
   - **The check is wrong** → amendment tiers: *typo-level* (wrong command,
     port, path — letter not meaning) fix yourself with a journal entry;
     *meaning-level* (what behavior counts as done) **always parks** — it never
     goes to recover either. A stuck loop weakening its own checks is the loop
     grading its own homework, and recover is part of the loop.

**The escaped-bug rule (both levels).** Any defect that passed a check and was
caught later — gaming read, later ticket, phase gate — means the repair must
*also strengthen the check that let it through*. Ticket-level escapes
strengthen ticket acceptance; phase-gate escapes strengthen that phase's gate.
This is the only mechanism that makes the checks sharper over the campaign
instead of frozen at intake quality.

### 2.5 Phase close — reintegration

When frontier.mjs reports a phase drained:

1. Run the phase's **gate commands** (slow suites, e2e) on the merged tree —
   per-ticket verification deferred these on purpose.
2. **Reintegration judgment** (you, thinking hard): read the phase's spec
   section against what its tickets delivered — and against the `satisfies`
   claims of its closed tickets, which is where a claim made at birth meets what
   was actually built. Do the pieces *compose* into what the phase promised —
   interfaces actually matching, the sum serving the section's intent? Green
   checks on parts do not prove the whole. Check the delivered diff against
   `outOfScope` too — a drained phase is the checkpoint where scope creep
   surfaces; a crossed tripwire **parks** immediately, it is never built past.
   Pieces that don't compose and can't be repaired by a ticket you can write
   yourself → recover (`reintegration-no-compose`).
3. Gate red after clean merges → no scapegoats and **you never patch the tree
   yourself**: bisect (run the failing checks on base + each branch alone, in
   parallel), then hand it to **recover** (`phase-gate-red`) with the evidence
   and the branches. A red gate is one of two things and recover decides which:
   a real escaped bug (a repair ticket whose checks *also* strengthen what let it
   through, born draft → critic pass) or a gate-scoping fault (the gate runs the
   wrong things, or contends on shared state — narrow or serialize it and run the
   correction green). Neither → it returns unresolved and you
   `park --phase <id>`, which latches the gate so `gateParked` keeps you from
   re-running it. Escaped-bug rule applies at phase level.

   **Gate amendment authority.** `backlog-write.mjs gate <phase>` upserts by
   name, and the name is what splits two different acts. A name not in force
   only *adds* coverage, so any arm may propose it — closing a spec-mandated
   coverage hole is the escaped-bug rule doing its job, not a question for the
   human. Reusing a live name *replaces* the command deciding correctness, which
   can turn a real escaped bug into a green phase; no comparison of two shell
   strings can prove that's a tightening. So you pass `--replace` for exactly one
   caller: a recover answering *that phase's own* red gate, the one invocation
   that held the failure and could re-run the correction green. Both acts are
   journaled with the command they displaced.
4. Green → journal the phase close, prune merged branches. (Keep branches
   until green — bisection needs them.)

Catching drift per-phase is the point: a phase whose checks were seeded
slightly wrong must surface here, not at the end of the campaign.

### 2.6 Recover — the universal else

Anything the frontier can't resolve and you can't fix as bookkeeping goes to one
full-tool agent per anomaly: it diagnoses, fixes the campaign **definition** or
the **environment**, runs the check to prove it, and hands you back lawful
mutations. It never touches product code — a product defect becomes a repair
ticket a worker builds and the reviewer judges.

Read `references/recover.md` before the first call. It carries the anomaly table,
the prompt, the enforced product-code boundary (`jurisdiction.mjs` snapshot →
revert, run *before* you read the verdict), and the budget: **two prior
resolutions of the same anomaly key and you park instead of calling.** An anomaly
that returns after a successful repair is a defect in this loop, not a fresh
fault, and a third fresh-context agent would only write a third confident success
note. Count the `recovered` entries off the journal, never from memory.

### Park — how the loop yields without stopping

**A park defers one decision; it never ends the campaign.**
`backlog-write.mjs park <id> --reason "..."` (or `--phase <id>` for a gate) takes
that ticket out of the frontier's hands and journals why. You keep driving
everything else. The campaign ends only when `stalled: true` survives a recover
pass and nothing autonomous remains — then you **drain**: report every parked
decision with its recorded reason and what evidence would settle it, leave
`.ailoop/campaign/` exactly as it is, and stop. `progress.mjs` and the journal
carry the picture; a resume continues from there.

Park directly, without recover, for the four decisions that are the human's by
construction: a meaning-level check amendment, a crossed `outOfScope` tripwire, a
second flake probe on the same ticket, and a fault whose fix the locked spec
genuinely doesn't answer. Everything else earns a recover attempt first.

Never a rosy summary of a loop that didn't finish — and never a stop over work it
could still have done.

## Termination

`complete: true` (no live ticket — parked ones count as live), every phase gate
green, and no phase in `gateParked` → read `references/retrospective.md` and
follow it: the final coverage pass (an unproven requirement = NOT done), the
report, the **retrospective harvest** into `.ailoop/learnings/`, then delete
`.ailoop/campaign/` and close the campaign.

## Resume (`.ailoop/campaign/` exists)

Never re-run intake. Read the journal tail, run frontier.mjs, reconcile:

- **`inFlight` tickets** — all stale on resume (no worker survives the
  session). Don't guess. The worker's branch exists → verify it
  like any result (green → judge; red → attempt entry, back to vetted). No
  branch → nothing durable happened; back to vetted.
- **`parked` tickets and gates** — a resume does not clear them. If the human
  answered, record it: `unpark <id> --note "<their answer>"` (the ticket returns
  as draft and re-earns its critic pass, because the answer changed something).
  If they didn't, drive everything else and drain again — re-parking is not an
  event, so the report stays honest without accumulating noise.
- **Spec changed since intake** (hash mismatch vs the one journaled at
  intake) → stop before any dispatch and reconcile with the human. Never
  drive an old spec to green. This is a genuine hard stop, not a park: every
  ticket in the backlog is measured against a contract that no longer exists.

## Learnings — the campaign-to-campaign loop

`.ailoop/learnings/` holds typed, capped files: `checks.json` (verified
toolchain commands + quirks), `flakes.json` (known flakes + discriminators),
`sizing.md` (decompose-preemptively priors), `gaming.md` (observed cheat
shapes → feeds the critic pass), `landmines.md` (codebase surprises → feeds
worker context). Each entry carries an evidence count and
last-confirmed-campaign.

- **Harvest** (at retrospective): distill the journal into *candidate* entries
  (judgment — what actually generalizes). The two keyed-JSON facets
  (`checks`, `flakes`) then merge via `learn.mjs` — it increments evidence,
  ages and evicts stale entries, and caps each file; the arithmetic is never
  eyeballed. The three prose facets (`sizing`, `gaming`, `landmines`) can't be
  mechanically deduped — merge those by hand: increment on a match, resolve
  contradictions rather than keep both, never append blindly.
- **Prime** (at intake): inject matching entries at their consumption point.
  Low-evidence entries inject as hypotheses ("observed once: ..."), not rules.
- **Evict**: entries unconfirmed for 3 campaigns decay out; each file capped
  (~30 entries). An old learning that still matters keeps getting
  re-confirmed — that's this loop's own reason-act-observe.
- **Graduate**: a learning confirmed across many campaigns belongs in this
  skill's text permanently — propose the SKILL.md edit to the human rather
  than re-injecting forever.

## What this skill refuses to do

- Start without a machine-checkable definition of done.
- Dispatch an unvetted ticket (frontier.mjs makes this impossible).
- Hand-edit `backlog.json` or the journal (backlog-write.mjs is the only door).
- Weaken a meaning-level check without the human — recover included.
- Trust a builder's self-report, at any level, ever.
- Gaming-check a diff itself — the reader must be a fresh-context agent.
- Report done over live blocked or parked tickets, unrun phase gates, or a spec
  clause nobody claimed.
- **Stop while autonomous work remains.** One undecidable question parks; the
  loop keeps driving and drains only when nothing is left.
- **Let recover edit product code.** `jurisdiction.mjs` reverts it and the intent
  goes through worker → verify → review like any other change.
- **Believe a third recovery of the same anomaly.** Two resolutions that didn't
  hold means the fault is in this loop; park with both fixes attached.
