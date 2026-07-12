# Oracle — <project>

**Contract:** `<spec path>` · spec_version <n> · sha256 `<hash>`
<!-- Recorded at intake. Resume recomputes the hash and refuses to dispatch on
     a mismatch — a changed spec is a change order to reconcile, never silent. -->

The definition of done. Written at intake, before any build. Workers cite it;
the coordinator gates against it. If a phase's checks below are not executable
as written, the loop must **not** start — ask the human to supply the missing
check.

Frozen means never *silently* changed, not never changed (SKILL.md — oracle
amendments): a check wrong in letter but not meaning (misspelled command, wrong
port/path) may be fixed by the coordinator with a ledger entry; any change to
*what behavior counts as done* always escalates. When a defect slips past a
check and is caught downstream, the repair must also strengthen the check that
let it through.

## Locked decisions (never re-litigated)

<!-- Copy the spec's frozen choices verbatim: stack, data model, architecture,
     "do not add X" lists. Every worker prompt cites this block. -->

- ...

## Scope tripwire (halt if crossed)

<!-- The spec's explicit out-of-scope list. Building any of these = drift = halt. -->

- ...

## Baseline gate (every ticket, no exceptions)

<!-- The project's standing quality gate, from Stage 1.0 toolchain detection.
     EVERY ticket must pass all of these regardless of what it touched — this is
     also the regression guard. Use THIS project's real commands. -->

- [ ] type-check / compile: `<command>` → exit 0
- [ ] build: `<command>` → exit 0
- [ ] lint (if the project lints): `<command>` → exit 0
- [ ] full existing test suite: `<command>` → all pass
- [ ] new behavior ships with new tests, green under the above

## Per-phase acceptance (executable)

Each check is a command + expected result, or a scripted behavioral test. A phase
closes only when all its checks pass **on the merged tree**.

### Phase 0 — <name>
- [ ] `<command>` → <expected>
- [ ] service boots; `<health check>` → <expected>
- [ ] behavioral: <given inputs> → <the output must differ in THIS way>

### Phase 1 — <name>
- [ ] ...

## Coverage map (spec → delivery)

<!-- Every requirement/section of the spec → the ticket(s) or oracle check that
     delivers it. Filled at intake (Stage 1.4), updated as tickets decompose.
     A requirement with no entry gets a ticket or an explicit "deferred" line —
     silence here is how an incomplete build finishes with every check green.
     The final report re-checks the spec against this map before declaring done. -->

| Spec § | Requirement (one line) | Delivered by |
|---|---|---|
| §1.1 | ... | T001, T002 |
| §5.2 | ... | phase 1 oracle check 3 |
| §9 | ... | deferred — spec marks it v2 |

## Caps

Live in `backlog.json` (`caps`, read by the scheduler): maxAttempts 3 · thrash 2.
No cap on total dispatches — the run goes to completion. Snapshot recorded in
the ledger run header.
