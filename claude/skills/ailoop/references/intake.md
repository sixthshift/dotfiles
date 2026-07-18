# Intake — starting a campaign

Only runs when `.ailoop/run/` is absent. Steps, in order:

## 0. Locate the spec and refuse-to-start gate

Find the locked spec the human pointed at. Read it fully. Then answer: **is
"done" machine-checkable?** Every phase must reduce to commands whose exit
codes settle the question. If any phase's done-ness is vibes ("the UX should
feel snappy"), stop and ask the human for the executable version. This is the
only permitted interruption in a healthy run — spend it here, never mid-drive.

Record the spec's sha256 (journal it) so Resume can detect a changed contract.

**Probe environment preconditions now.** The spec's listed keys, services,
and runtimes (aispec's contract requires them listed) get checked here, not
discovered at phase 3: env vars present, services reachable, runtimes at
version. A missing precondition is a refuse-to-start, reported alongside the
gate — the cheapest possible time to fail.

## 1. Prime from learnings (if `.ailoop/learnings/` exists)

Read each facet at its consumption point — don't dump them all into context:

- `checks.json` → step 2 (known-good toolchain commands, quirks)
- `sizing.md` → step 3 (what kinds of tickets proved too big before — split preemptively)
- `gaming.md` → step 4 (cheat shapes to probe for in the critic pass)
- `flakes.json` → journal the known flakes + discriminators now, so verify
  reds against them go straight to the probe
- `landmines.md` → fold relevant entries into ticket `context` in step 3

Inject low-evidence entries (evidence count 1) as hypotheses, not rules.
Every primed entry gets re-confirmed or retired by this campaign's
retrospective.

## 2. Detect the toolchain and seed the campaign

```
node <skill>/templates/backlog-write.mjs init --project <name>
cp <skill>/templates/*.mjs .ailoop/run/
```

Add `.ailoop/run/` to `.gitignore` (learnings/ stays tracked). From the
project manifest, detect the real commands (type-check, build, lint, unit
suite) — verify each actually runs before trusting it. Feed them in as
`fastChecks`, and the slow suites (e2e, anything needing a live server) as
each phase's gate commands, via `backlog-write.mjs seed` — it refuses once
the first ticket exists; later config changes are amendments, journaled.

**Fast vs gate tier:** fast = seconds-to-a-minute, runs on every ticket
verify. Gate = slow, runs per phase close on the merged tree. A ticket that
ships a new gate-tier test still runs *that test* at its own verify (it's the
ticket's own acceptance).

Seed `outOfScope` the same way — the spec's Out-of-scope list, verbatim. It is
the tripwire the gaming check reads per diff and phase-close reads per phase;
frontier can't see feature-scope, so this list is the only place it lives.

## 3. Decompose the spec into draft tickets

Break each phase into tickets sized for **one fresh worker session** — err
small; `tooBig` replies are healthy but not free. Near-term phases get full
detail; later phases may be seeded coarse and refined while workers run.
Every ticket: self-contained `context` (a worker with zero conversation
memory must succeed from it), non-empty `files`, executable
`acceptanceChecks`, `phase`, `origin` citing the spec section. Prefer
input→output contrast checks over artifact-existence checks — existence is
the most gameable form.

If a ticket's checks *mutate* shared external state (a dev DB they reset, a
queue, a local store), name it in the ticket's `resources` array — frontier
never co-schedules two tickets that share a resource, so parallel verifies
can't corrupt each other. Read-only touches don't count.

Feed them in via `backlog-write.mjs add` (it validates; fix what it refuses).

## 4. Critic pass over every draft

Per SKILL.md §2.2 — the five questions, findings fixed or logged as accepted
risks, then `vet` each ticket. Intake ends with the first frontier batch
vetted; later phases can be vetted during the drive's wait time.

## 5. Pre-flight report to the human

One message: the phases and their gates, ticket count, the first batch, any
accepted risks, anything about the spec that surprised you. Then start the
drive. No approval wait unless something in intake was genuinely ambiguous.
