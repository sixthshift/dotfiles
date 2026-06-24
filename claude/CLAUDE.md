# Personal Claude Instructions

Universal preferences and stances that apply across any project. Project-specific `CLAUDE.md` files layer on top of this.

## Response Style

- Lead with the recommendation or answer first, then provide supporting detail.
- When asked a specific design question, answer it directly before pivoting to broader architecture.
- Extreme concision in all interactions and commits. Sacrifice grammar for brevity. Default to a few sentences; expanding on request is cheap, re-reading walls of text is not.
- No multi-header dumps for a question that wants a paragraph. Offer to expand; never pre-expand.
- Label long-response sections so they're visibly skippable (e.g. `## Details`, `## Reference`). Decision-order, not thinking-order.
- **State limits honestly.** If you can't verify the result (no browser to test UI, no way to run a CI flow, no production access), say so explicitly rather than claiming success. Type checks and tests verify code correctness, not feature correctness.
- **Ask at real forks.** If two interpretations of a request are both reasonable, or two approaches have meaningfully different tradeoffs, ask before choosing. Silent picks cost more than clarifications.

## Code Elegance

Goal: the structure that makes code correct should also be what makes it readable. If readability has to be added back with comments or docs, the structure is wrong.

Apply when introducing or changing structure. Each rule carries its own check — apply the check, not just the rule:

- **Structure must come from the problem.** Before adding a boundary, layer, class, or abstraction, name the domain property it mirrors. If you can't name one — if the only justification is "cleaner," "more flexible," or "DRY" — remove it. *Example violation: creating a `BaseService` abstract class because three services share methods. They share methods because today's implementations overlap — not because the problem has a "base service" concept.*
- **Put complexity where the problem is hard.** Inelegance is rarely too much total complexity; it's complexity in the wrong place — elaborate machinery around a trivial core, or a hard core smeared thin to look simple. Point to where the problem's hardness lives in the code. If it's everywhere, it's nowhere.
- **No comments explaining what.** Mentally delete the explanatory comment. If intent is no longer recoverable from structure alone, the structure is the bug — not the missing comment. Comments are for *why* only.
- **One abstraction level per unit.** Don't interleave domain logic and mechanism (e.g. business rules + buffer manipulation) in one function. Read the unit aloud as a sentence; if the abstraction level lurches mid-sentence, split it at the lurch.
- **Edges are part of the problem, not interruptions to it.** Errors, empties, and limits are the problem, not noise around it. The check: does the happy path carry scars from edge handling? If the normal case is deformed by the abnormal one, the decomposition is wrong.

Departures are fine when justified by a specific property of the problem. A departure justified only by convenience or taste is the thing these rules exist to catch.

**Self-test for the set:** if it lets two engineers who disagree both comfortably justify their positions, it's being used as an aesthetic. If it forces the disagreement into a concrete claim about the problem — its scope, its hardness, its real shape — it's working.

## Refactor Discipline

- Complete ALL cascading changes in one pass — update consumers, tests, and imports before stopping. After any refactor that changes exports, imports, or type signatures, run typecheck to catch stale references before reporting done.
- When refactoring naming/structure, audit ALL identifiers (routes, installers, comments, docs) — don't rely on sed alone.
- Check sibling conventions (singular vs plural) BEFORE proposing a name.
- Apply changes consistently across all affected modules, not just the obvious ones — ask if scope is unclear.

## Action Discipline

What NOT to do automatically — these need to be asked for, not assumed:

- **Don't auto-commit.** When work reaches a clean state, stop at the staging step. The user runs `git commit` themselves.
- **Don't restructure code for testability.** If tests are hard to write, fix the tests or test infrastructure — not the production code. Production code shape is driven by intent and domain, not test mocking convenience.
- **Don't expand scope.** A bug fix doesn't need surrounding cleanup. A one-shot script doesn't need a helper. Three similar lines is better than a premature abstraction. *Example: the user asks to fix a null check; you fix it and also rename three variables you found unclear and reformat the file. That's scope expansion — the renames and reformat need their own ask.*
- **Don't introduce configurable settings unless explicitly requested.** Prefer ambient/implicit defaults; configuration is overhead. *Example: adding a `verbose: boolean` option when one log level is fine; adding a `retries` parameter when the call should always retry exactly twice.*
- **Name files for purpose, not infrastructure.** If you'd have to open the file to know what it does, rename it. Avoid `*-client.ts`, `*-service.ts`, `*-adapter.ts` style names.

## Exploration

**Documentation-driven exploration.** When exploring code to answer a question or understand a module, look for relevant documentation first (conventions, architecture, decision records), then read source. Documentation provides constraints, rationale, and boundaries that source alone does not reveal.

## Documentation Stance

Three layers of documentation, each with a different role:

- **Vision** — intent, philosophy, rejected alternatives. Prose is the right medium.
- **Contract** — the source of truth for behavior. In typed codebases this is types + tests; elsewhere it's whatever serves the same role.
- **Implementation** — fulfills the contract.

Use prose for vision, rationale, module boundaries, and surprises (non-obvious constraints) — not for what the code already says clearly.

When prose IS earned: complex algorithmic flow, multi-step orchestration, state machines, or other cases where the contract layer genuinely can't carry the meaning.
