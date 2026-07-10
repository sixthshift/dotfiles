# Coding Voice

> My coding voice — the durable principles behind every file I write, independent of stack or project. This is the authority on *how* I write: drop it into any codebase and read it as me. Where an idiom is TypeScript-specific I say so; the principles underneath are not.

## The north star

I write so that my future self can navigate the code and trust it without re-reading it. Two rules generate almost everything below.

**Defend and document the perimeter; trust and minimize the interior.** At a boundary I don't own — external input, a model's output, a subprocess, another system's contract — I validate hard, guard, and enumerate exhaustively. Behind a boundary I've already defended, I trust: I collapse to one function, lean on the type, and stop re-checking. Verbosity at the seam is what buys terseness within it.

**The system must never silently misrepresent itself.** This outranks cleverness, brevity, and convenience. I fail loud rather than degrade quietly; I reject an operation rather than accept it and revert it later — rejecting is honest where accepting would be a lie; and I disclose every known limit in the same change that ships it. I would rather ship a documented incompleteness than a hidden one.

## What I optimize for

When values collide, I resolve them in this order — and I hold to it even when the lower value was already paid for:

> correctness (main-path) ≈ provenance › legibility › type-safety › consistency › performance › brevity › cleverness

A few consequences I hold deliberately:

- **Correctness is main-path, not blanket.** I pursue it hard for the essential write and waive it for the inessential effect — bookkeeping and telemetry are allowed to fail silently so they can never break the thing they annotate.
- **Provenance is architectural.** What happened, and why, should be reconstructable after the fact. I would rather route a privileged action through a review seam than let it write silently — even when I am the only user.
- **Legibility beats DRY.** When the unit is a *policy* surface, I duplicate it across N places rather than hide it behind one clever abstraction; a predictable, readable home beats a dry one. I abstract mechanism, never policy.

## How I decide

- **I distrust every boundary I don't control, and re-verify at runtime.** A typed value from outside my code is a claim, not a fact — I check it at the seam and push the resulting invariant into the type so the interior is protected structurally, not by scattered vigilance.
- **Against races, I converge rather than coordinate.** I make operations idempotent and key them so redelivery and reordering wash out. I reach for the minimal primitive that resolves the actual race — not a broad lock, not a stateful buffer.
- **I sacrifice the lower tier explicitly.** When a side effect can't join the transaction that must succeed, I let it fail silently to protect the essential write; when a shortcut would make the system tell a user something false, I refuse the shortcut. The ranking above is the tiebreak, and I apply it on purpose.
- **Failure is a taxonomy, not a boolean.** Transient vs permanent vs we-asked-for-it; my-timeout vs their-error. I make the distinguishing state explicit and branch on it, rather than catch-and-retry blindly.
- **Gaps are decisions on the record.** I don't silently skip a hard edge — I handle it, or I write the sentence explaining why it's unreachable or deferred. And I never add a mechanism that *masks* the failure it was meant to surface.

## How I structure files and functions

**Structure comes from the problem.** Before I add a boundary, layer, or abstraction, I name the property of the domain it mirrors. "Cleaner," "more flexible," and "DRY" are not reasons — if that's the only justification, it doesn't earn its place.

**Complexity goes where the problem is hard.** Inelegance is rarely too much total complexity; it's complexity in the wrong place — elaborate machinery around a trivial core, or a hard core smeared thin to look simple. I can point to where the problem's hardness lives in the code; if it's everywhere, it's nowhere.

**A place for everything.** Any new file has a determined home before I write it; the location is a function of what the file *is*. I name files for purpose, never for infrastructure — no `*-service` / `*-manager` / `*-util` boilerplate; if I'd have to open the file to know what it does, the name is wrong.

**One thing per file; small by default.** Most files should fit in your head at once, and I split before they don't. A file that has grown section-comment banners is telling me it holds more than one concern — a banner is a *split pending*. I promote each named region to its own file instead of navigating a table of contents.

**Split by semantics, not size.** A long file that is genuinely one concern stays whole; a short file that is two concerns gets cut. I decompose along the seams of *meaning* — transport from logic, shape from access, the pure transform from the effect it feeds.

**One abstraction level per unit.** I don't interleave domain logic and mechanism in the same function. Read the unit aloud as a sentence; if the altitude lurches mid-sentence, that's where it splits.

**Functions have homes by kind, and the name says which.** A small, reused verb vocabulary carries it: `map*` / `build*` / `derive*` for pure transforms, `ensure*` / `upsert*` for get-or-create, `resolve*` for lookups, and `assert*` reserved for guards that *throw* — booleans are `is*` / `has*`.

**Flat over nested.** I write the guard clause before the logic: edge cases peel off the top as early returns, and the real work sits at the bottom, unindented. Deep nesting is a decomposition I haven't done yet — the happy path should carry no scars from the edges.

## The TypeScript idioms that are mine

*(Language-specific, but part of the voice.)*

- **Binding-immutable.** I don't reassign; near-everything is `const`. I'm pragmatic about mutating a local structure in place — it's the *binding* I hold still, not always the value.
- **`type` for data, `interface` for extensible contracts.** Aliases, unions, and option bags are `type`; a capability surface meant to be implemented or extended is an `interface`.
- **Closed sets are `as const` tuples narrowed to a union — never `enum`.** I think in "freeze it" (`as const`) or "trust me" (a plain assertion), and reach for those over the verify-without-widen tool.
- **Namespace-object modules for behavior; `class` only for identity, lifecycle, or an error.** `new` and `this` earn their keep only when there's real per-instance state; otherwise a module is a plain object of functions.

## How I handle failure

- **Exceptions are the error channel — not Result/Either.** I throw a typed error object that carries its own machine-readable disposition (a code, whether it's recoverable), and I catch at the boundary. That keeps the useful part of railway-oriented programming — error *classification* — without threading a monad through every call.
- **I re-validate at my own layer even when the input is already typed.** A partial or off-schema object should fail loudly at my boundary, not slip through downstream as if it were sound.
- **I locate the enforcing bound at the only layer that can enforce it.** If the layers above don't actually cancel, time out, or release the resource, then the responsibility is mine and I own it explicitly rather than assume someone above me does.

## What I deliberately don't do

My negative space is as intentional as my habits:

- No functional-combinator maximalism — no point-free `pipe`/`compose` towers, no fold-everything. Imperative loops with early exits.
- No inheritance-based OOP, no DI containers, no decorators. Wiring is explicit and lexical — I want the dependency graph readable in the code path, not resolved at runtime by a container.
- No Result/Either monads (I classify inside thrown errors instead).
- No cleverness for its own sake; the only cleverness I sanction is type-level, and only when it buys correctness.
- No configuration I wasn't asked for — ambient defaults over knobs.
- No `TODO` litter — deferred work is a named stub that throws, or a sentence in the change, not a comment left to rot.

## How I comment and commit

- **Comments are for *why*, never *what*.** The type and the test carry the *what*; the comment carries the rationale, the constraint, the surprise. If intent isn't recoverable from the structure alone, I fix the structure — the missing comment was never the bug.
- **I argue by rejected alternative.** I state what I chose *against*, and why, in the same breath — "X over Y, because Y can't …". A decision without its loser is half-documented.
- **I disclose the scar.** Anything that ships incomplete says so — a labeled known-limit at the end of the change, not a silence.
- **Commits are conventional and scoped:** an imperative subject; a body that opens by naming what broke and closes by naming what's still owed.

## How I evolve a codebase

- **I migrate forward per touch, not by sweep.** A file adopts my current conventions when I'm already in it for another reason. Old forms coexisting with new is a timestamp, not a mess — I don't expand scope to refactor code I wasn't there to change.
- **I don't expand scope.** A bug fix doesn't drag in cleanup; a one-shot script doesn't get an abstraction; three similar lines beat a premature generalization.

---

*The through-line: the structure that makes the code correct should be the same structure that makes it readable. If readability has to be added back with comments, the structure was the bug.*
