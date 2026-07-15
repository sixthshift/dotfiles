# Ledger — <project>

Append-only journal. How the loop got where it is: every dispatch, every judge
decision and why, attempt counts, decompositions, drift flags, escalations. The
audit trail — distinct from `backlog.json` (forward state) and `oracle.md`
(definition of done). Newest entry at the bottom. Never rewrite history; append
corrections.

## Run header
- **spec:** <path> · spec_version <n> · sha256 <hash>
- **started:** <timestamp>
- **caps:** max 3 attempts/ticket · thrash=2

## Journal

<!-- One entry per event. Every entry opens with a machine-readable header line,
then a human prose body:

[<seq> | <isoTs> | <kind> | <subject>] <event, one line>
  decision: continue | retry | decompose | escalate | close-phase | amend-oracle
  why: <one line grounded in the oracle or spec>
  attempt: <n/max>
  evidence: <link or inline check output for done/gate/amend events>

The header carries the four fields `report.mjs` reads for the run audit — nothing
else parses this file, so keep the shape exact:
  - <seq>     zero-padded sequence, e.g. 0042
  - <isoTs>   UTC ISO-8601 stamp. STAMP IT LIVE at append time so it can't be
              forged or forgotten — append the entry with a real clock read:
                printf '[%04d | %s | dispatch | T017] retry after gate red\n' 42 "$(date -u +%FT%TZ)" >> .ailoop/ledger.md
  - <kind>    closed vocab, one per event — this IS the machine-readable decision,
              so report.mjs counts work without parsing the prose:
                intake · dispatch · accept · retry · decompose · phase-close ·
                escalate · resume · amend · flake · blocked · note
  - <subject> a ticket id (T017), a comma-joined batch (T012,T014,T017),
              a phase (P2), or `run`. No `|` — it runs to the `]`.

`escalate`/`resume` bracket the loop's human-pause windows; the audit subtracts
that idle time from "active" so a night spent awaiting a decision never inflates
the work total. Timing is telemetry: a missed or malformed stamp costs one
unmeasured gap in the audit, never a broken loop — but the live-date append above
makes a miss a non-event.

Every worker dispatch gets an entry (the ledger is the auditable dispatch count).
Oracle amendments (mechanical only — cite evidence), red-team findings, gate-red
bisections, and gaming judgments all get entries.
-->

[0001 | <isoTs> | intake | run] seeded backlog (N tickets), oracle derived, acceptance red-teamed (M checks sharpened), caps set
  decision: proceed
  why: every phase oracle is executable; no missing checks
