---
status: draft            # draft | locked — ailoop refuses to start on a draft
spec_version: 1          # bumped by change orders after lock
---

# <Project> — Build Spec

<!-- One paragraph: what this is and why it's worth building. Vision, not
     mechanism — the sections below carry the mechanism. -->

## Locked decisions

<!-- Over-specified ON PURPOSE: every choice a builder could stall on or
     re-litigate gets decided here — stack, data model, architecture, naming,
     error behavior, "do not add X" lists. aispec locks conventional defaults
     loudly and lists them for override; the human decides the genuine forks.
     ailoop copies this block into oracle.md verbatim; workers cite it. -->

- Stack: ...
- Data model: ...
- Do not add: ...

## Out of scope

<!-- The tripwire list — ailoop halts if a build crosses it. Harvested
     explicitly (humans never volunteer what NOT to build) and from rejected
     interpretations and "maybe later" answers during interrogation. -->

- ...

## Phases (de-risk order)

<!-- Riskiest phase FIRST: the thing most likely to sink the project gets
     built and gated before anything depends on it. Each phase names its
     deliverable and its executable "done means" — a command with an expected
     result, or a behavioral contract with concrete contrasting input→output
     examples. Prefer contrast checks ("given A → X; given B → must differ in
     THIS way") over existence checks — existence is the most gameable form. -->

### Phase 0 — <the riskiest thing>

**Why first:** <the risk this retires>

**Deliverable:** ...

**Done means (executable):**
- `<command>` → <expected result>
- Behavioral: given <concrete input A> → <expected output>; given
  <contrasting input B> → output must differ: <how>

### Phase 1 — <name>

**Deliverable:** ...

**Done means (executable):**
- ...

## Environment & preconditions

<!-- What must exist for the checks to run: API keys/secrets, external
     services, runtimes, network access. ailoop probes these at intake — a
     missing one is a refuse-to-start, so surface them here, not mid-build. -->

- ...

## Open questions

<!-- aispec's working backlog — one entry per unresolved ambiguity, riskiest
     first. An answered question is DELETED and its answer lands in the
     section above where it belongs (contested forks carry a one-line why
     naming the rejected option; defaults stay bare). Two exits only: answered
     by the human, or the feature it belongs to is cut — never defaulted away,
     never parked in Out of scope. A question too big to answer decomposes
     into answerable sub-questions. Must be empty before status flips to
     locked. -->

- [ ] ...

## Change orders

<!-- Post-lock only. Never edit a locked section silently: append the change
     here (date · change · rationale), bump spec_version, then apply it above.
     ailoop's next resume detects the changed hash and stops to reconcile —
     this section is what that reconciliation reads, so say what changed and
     why. A change to what counts as done also goes through ailoop's semantic
     amendment tier if a drive is in flight. -->

## Braindump (raw)

<!-- First-session capture, written verbatim AS the human dumps — durability
     before structure. Structuring moves material into the sections above and
     deletes it from here; delete the whole section once it is empty. -->
