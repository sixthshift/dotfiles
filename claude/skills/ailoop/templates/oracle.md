# Oracle — <project>

The frozen definition of done. Written once at intake, before any build. Workers
cite it; the coordinator gates against it. If a phase's checks below are not
executable as written, the loop must **not** start — ask the human to supply the
missing check.

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

## Caps

- Max attempts per ticket: 3
- Thrash threshold: failing acceptance set doesn't shrink across 2 attempts → escalate
- Whole-run token budget: <ceiling>
