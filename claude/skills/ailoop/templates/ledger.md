# Ledger — <project>

Append-only journal. How the loop got where it is: every judge decision and why,
attempt counts, budget spent, decompositions, drift flags, escalations. The audit
trail — distinct from `backlog.md` (forward state) and `oracle.md` (definition of
done). Newest entry at the bottom. Never rewrite history; append corrections.

## Run header
- **spec:** <path> @ <commit/hash if any>
- **started:** <timestamp>
- **caps:** max 3 attempts/ticket · thrash=2 · budget=<ceiling>

## Journal

<!-- One entry per event. Format:

[<seq>] <ticket|phase> — <event>
  decision: continue | retry | decompose | escalate | close-phase
  why: <one line grounded in the oracle or spec>
  attempt: <n/max>   budget-spent: <approx>
  evidence: <link or inline check output for done/gate events>

-->

[0001] intake — seeded backlog (N tickets), oracle derived, caps set
  decision: proceed
  why: every phase oracle is executable; no missing checks
