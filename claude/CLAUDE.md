# Personal Claude Instructions

Universal preferences and stances that apply across any project. Project-specific `CLAUDE.md` files layer on top of this.

## Response Style

- Lead with the recommendation or answer first, then provide supporting detail.
- Avoid walls of text; prefer concise rundowns and offer to expand on request.
- When asked a specific design question, answer it directly before pivoting to broader architecture.
- Label long-response sections so they're visibly skippable (e.g. `## Details`, `## Reference`). Decision-order, not thinking-order.
- Prefer shorter responses by default — expanding on request is cheap; re-reading walls of text is not.

## Code Elegance

Goal: the structure that makes code correct should also be what makes it readable. If readability has to be added back with comments or docs, the structure is wrong.

Apply when introducing or changing structure. Each rule carries its own check — apply the check, not just the rule:

- **Structure must come from the problem.** Before adding a boundary, layer, class, or abstraction, name the domain property it mirrors. If you can't name one — if the only justification is "cleaner," "more flexible," or "DRY" — remove it.
- **Put complexity where the problem is hard.** Inelegance is rarely too much total complexity; it's complexity in the wrong place — elaborate machinery around a trivial core, or a hard core smeared thin to look simple. Point to where the problem's hardness lives in the code. If it's everywhere, it's nowhere.
- **No comments explaining what.** Mentally delete the explanatory comment. If intent is no longer recoverable from structure alone, the structure is the bug — not the missing comment. Comments are for *why* only.
- **One abstraction level per unit.** Don't interleave domain logic and mechanism (e.g. business rules + buffer manipulation) in one function. Read the unit aloud as a sentence; if the abstraction level lurches mid-sentence, split it at the lurch.
- **Edges are part of the problem, not interruptions to it.** Errors, empties, and limits are the problem, not noise around it. The check: does the happy path carry scars from edge handling? If the normal case is deformed by the abnormal one, the decomposition is wrong.

Departures are fine when justified by a specific property of the problem. A departure justified only by convenience or taste is the thing these rules exist to catch.

**Self-test for the set:** if it lets two engineers who disagree both comfortably justify their positions, it's being used as an aesthetic. If it forces the disagreement into a concrete claim about the problem — its scope, its hardness, its real shape — it's working.

## Refactor Discipline

- When refactoring naming/structure, audit ALL identifiers (routes, installers, comments, docs) — don't rely on sed alone.
- Check sibling conventions (singular vs plural) BEFORE proposing a name.
- Apply changes consistently across all affected modules, not just the obvious ones — ask if scope is unclear.
- Don't introduce configurable settings unless explicitly requested; prefer ambient/implicit defaults.

## Workflow

**Design questions.** When asked an architecture or design question, answer the question concisely first. Do not launch into a refactoring plan or implementation unless asked.

**Refactor cascades.** When performing multi-file refactors, complete ALL cascading changes in one pass — update consumers, tests, and imports before stopping. After any refactor that changes exports, imports, or type signatures, run typecheck to catch stale references before reporting done.

**Documentation-driven exploration.** When exploring code to answer a question or understand a module, look for relevant documentation first (conventions, architecture, decision records), then read source. Documentation provides constraints, rationale, and boundaries that source alone does not reveal.

**Documentation gap identification.** When exploring an area and the ideal documentation is missing, say so explicitly. Once you've learned the answer from source, write that documentation in the appropriate location, following existing structure. The most valuable docs to create: conventions/patterns (invisible rules), decision rationale (rejected alternatives), and module boundaries — not implementation details or API references that can be read from source.

**Module entry-point docs.** Each package should have a short orientation doc (or a comment block at its entry point) answering three questions: (1) what does this module own, (2) what are its key boundaries/dependencies, (3) what will surprise you — the non-obvious constraint or design choice that trips people up. Create one if missing when entering a package.

## Documentation-Test Unity

Three layers:
- **Vision** — intent, philosophy, not testable
- **Contract** (types + tests) — source of truth, readable as spec
- **Implementation** — fulfills contracts, can change freely

Workflow:
1. Write the contract (types).
2. Write tests as specifications — test names ARE documentation.
3. Implementation follows.
4. Never write prose docs for runtime behavior.

When asked "how does X work?" — read the tests first. Test names should be complete sentences: `it('retries failed syncs up to 3 times with exponential backoff')`.

**Never:** write prose for runtime behavior, duplicate behavior docs, document implementation details.
**Always:** test descriptions as specifications, add tests (not comments) when unclear, reference test files by path:line.
