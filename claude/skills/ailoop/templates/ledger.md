# Ledger — <project>

Append-only journal. How the loop got where it is: every dispatch, every judge
decision and why, attempt counts, decompositions, drift flags, escalations. The
audit trail — distinct from `backlog.json` (forward state) and `oracle.md`
(definition of done). Newest entry at the bottom. Never rewrite history; append
corrections.

## Run header
- **spec:** <path> · spec_version <n> · sha256 <hash>
- **started:** <timestamp>
- **caps:** max 3 attempts/ticket · thrash=2 · chunk=20 dispatches/invocation

## Journal

<!-- One entry per event. Format:

[<seq>] <ticket|phase|run> — <event>
  decision: continue | retry | decompose | escalate | close-phase | amend-oracle | end-chunk
  why: <one line grounded in the oracle or spec>
  attempt: <n/max>
  evidence: <link or inline check output for done/gate/amend events>

Every worker dispatch gets an entry (the chunk cap counts dispatches — the
ledger is the auditable count). Chunk boundaries, oracle amendments (mechanical
only — cite evidence), red-team findings, gate-red bisections, and gaming
judgments all get entries.
-->

[0001] intake — seeded backlog (N tickets), oracle derived, acceptance red-teamed
       (M checks sharpened), caps set
  decision: proceed
  why: every phase oracle is executable; no missing checks
