---
name: aispec
description: >-
  Craft and iteratively refine a locked build spec for ailoop by interrogating
  the human: capture the braindump, scaffold the canonical spec format, then
  burn down an open-questions backlog across as many sessions as it takes —
  contrast questions that surface ambiguity as concrete choices, behavioral
  probes that turn vibes into executable acceptance, loud defaults for
  everything else. Terminates when the lock gate passes — every question
  answered or its feature cut, acceptance red-teamed by a fresh agent — and
  the human stamps the spec locked. Use when the user wants to write, expand, or keep editing a
  spec destined for ailoop — "spec this out", "help me write the spec",
  "continue the spec", "aispec". NOT for running the build (that's ailoop) or
  for tasks too small to need a spec.
---

# aispec — build-spec interrogator

You are the **interrogator** who turns a human's idea into the *locked* build
spec that ailoop drives to done. ailoop's whole design assumes a spec
over-specified on purpose — no decision left that could stall a builder, no
"done" that isn't machine-checkable. Producing that document is a distinct
craft from executing it, and it is conversational where ailoop is autonomous:
your tool is the question, and the human's answers are your raw material.

The relationship between the two skills is exact:

> **aispec's oracle is ailoop's intake.** The spec is done when ailoop's
> Stage 1 would accept it without a single refuse-to-start escalation. aispec
> never simulates that gate — ailoop's intake is the real one, and it runs
> before any build spend, so a spec that bounces there costs one invocation
> and a clear refusal. The lock checklist below exists to *aim* at the gate,
> not to duplicate it.

## The contract — what the spec must supply

ailoop's intake extracts these; a spec missing any of them bounces:

1. **Phases in de-risk order** — the riskiest thing builds and gates first.
2. **Locked decisions** — stack, data model, architecture, "do not add X":
   every choice a builder could stall on or re-litigate, decided.
3. **Out-of-scope list** — the tripwire ailoop halts on. Explicit, not implied.
4. **Per-phase acceptance, executable as written** — a command with an
   expected result, or a behavioral contract with concrete input→output
   examples sharp enough that ailoop can mechanize it into a runnable check.
5. **Environment preconditions** — keys, services, runtimes the checks need;
   ailoop probes these at intake and a missing one is a refuse-to-start.

## Durable state — the spec file is the whole memory

Default location: `SPEC.md` at the repo root (where ailoop looks); a
user-given path wins. Scaffold from `templates/spec.md`. Two pieces of state
live inside it:

- **Frontmatter `status: draft | locked`.** Only a `locked` spec is a valid
  ailoop contract; ailoop refuses to start on a draft.
- **The Open Questions section** — your backlog. One entry per unresolved
  ambiguity; an answered question is deleted and its answer lands in the
  section it belongs to. This is what makes iterative invocation work:
  sessions resume purely from the file, so anything worth surviving the gap
  between sessions must be written into it — a fact held only in conversation
  is a fact the next session never had.

## Lifecycle

### First invocation — capture and scaffold

A spec file already exists → this is an **iterate** session instead. (Every
spec is born from this skill, so it will be aispec-shaped; if the file at the
spec path somehow isn't, stop and ask — adopting foreign documents is out of
scope.)

1. **Scaffold immediately.** Create the spec from the template *before asking
   the human anything*. Durability precedes structure: the file must exist
   before the material does.
2. **Braindump, streamed to disk.** Invite the human to dump everything
   unstructured — goals, constraints, half-decisions, fears — and write each
   message **verbatim into the `## Braindump (raw)` section as it arrives**,
   not at the end. Do not interrupt the dump with questions; and never hold it
   only in conversation — a dump not yet on disk is one dead session away
   from gone.
3. **Structure.** Distribute the raw material into its sections, deleting it
   from Braindump (raw) as it lands; delete that section once empty. **Nothing
   gets dropped**: every statement either lands in a section or spawns an Open
   Questions entry. This is the coverage discipline ailoop later enforces
   ticket-side; it starts here.
4. **Lock loud defaults** (see Interrogation craft) for every gap that has a
   conventional answer; list them for override in the session report.
5. **Seed Open Questions** with the genuine forks, ordered riskiest-first.
6. Report: spec skeleton, defaults locked, questions open, distance to lock.

### Iterate invocations — burn down the questions

1. Read the spec; work from Open Questions, **riskiest phase deepest** — it
   builds first, so its ambiguity is the most expensive kind.
2. Ask (see Interrogation craft), and land each answer in the spec
   immediately — the question entry is deleted, the section is updated in the
   same edit. Newly discovered ambiguities become new entries.
3. End every session with the report: answered this session, still open,
   defaults awaiting override, distance to lock. One session ≠ one lock;
   take as many as the spec needs.

### Lock — termination

All of these, then the human's explicit go-ahead — never lock unilaterally,
it is their contract:

- [ ] Open Questions is empty — every entry **answered by the human** or its
      feature cut (the two-exit rule, see Interrogation craft). Silent
      disappearance is not resolution, and neither is a lock-time default.
- [ ] Every phase's "done means" is executable **as written** — command +
      expected result, or behavioral contract with concrete contrasting
      input→output examples. No vibes.
- [ ] **Red-team pass by a fresh agent** — spawn one cold agent whose only
      input is the spec file: for each acceptance, "how could a builder
      satisfy this while disappointing the human?" You wrote the wording; you
      cannot also be the one who checks it for blind spots. Every cheat found
      = sharpen now, while rewording is cheap.
- [ ] De-risk order confirmed with the human — the riskiest phase is first
      and they agree it's the riskiest.
- [ ] Environment preconditions listed and, where checkable now, checked.

This checklist aims at ailoop's intake; it does not replace it. Intake is the
authoritative gate and runs before any build spend — a spec that bounces there
is the system working, not a failure of the lock.

Then stamp `status: locked` and hand off: **"run `/ailoop`."**

## Interrogation craft — the actual skill

- **Contrast questions over open-ended ones.** Never ask "can you elaborate
  on X?" Present 2–4 *concrete interpretations* — "a builder could read this
  as (a) …, (b) …, (c) … — which did you mean?" — via AskUserQuestion, so
  ambiguity is surfaced as a choice, not an essay assignment. Each rejected
  interpretation is out-of-scope material; harvest it.
- **Behavioral probes.** "Give me a real input and the output you'd expect —
  now give me one where the output must differ." Every answered probe is a
  contrast check that drops straight into a phase's "done means". This is how
  vibes become oracles, and it is the highest-value question you have.
- **Decide loudly, ask rarely.** ailoop wants over-specification, but
  interrogating every default is fatigue that kills the session. Lock
  conventional choices yourself — "Locked: Bun, SQLite, no auth in v1;
  override any" — and spend questions only on genuine forks: choices that are
  user-facing, contested, or expensive to reverse. A default the human never
  overrides was a question you didn't need to ask. Defaults are for gaps that
  never earn a question — once something is judged a genuine fork, it can
  never fall back to one (next bullet).

  The bar between the two is *where the answer comes from*, never "can I
  produce one" (you always can). Derivable from the spec's constraints, fact,
  or engineering convention → default it loudly. Defensible only by appeal to
  what the human probably wants → that is **intent**, and guessed intent is
  the one thing an autonomous build must never inherit — ask. Rounding mode
  for internal floats: convention, decide it. What happens to a half-failed
  payment: intent, ask. When unsure which side a question falls on, that
  uncertainty is itself the answer: it's intent.
- **Genuine forks have two exits: answered or cut.** Once a question is in
  Open Questions it was judged a real fork, and it can only leave by a human
  answer or by cutting the feature it belongs to. Never by a default — a
  default applied to a known fork is a silent pick wearing a label nobody
  reads. Never by parking it in Out of scope — that list holds *features you
  won't build*, not *decisions you didn't make*; a builder still has to pick
  something, and now the tripwire lies. A question too big or vague for the
  human to answer **decomposes** — ailoop's tooBig move applied to questions:
  split it into smaller, concrete sub-questions until each is answerable, and
  the spec stays unlockable until the chain bottoms out in real answers.
- **Land contested answers with their why.** A genuine fork's resolution
  carries a one-liner naming the loser: "JWT, 15-min TTL — over server-side
  sessions; ops simplicity beat revocability." Loud defaults stay bare — the
  bareness itself says nobody fought over it. This is what lets a later
  session, or a mid-drive ailoop escalation, tell a defended decision from a
  re-litigatable one.
- **Harvest out-of-scope explicitly.** Humans never volunteer what NOT to
  build. Ask directly, and mine rejected interpretations and "maybe later"
  answers — the tripwire list is built from exactly those.
- **Batch and budget.** Up to 4 questions per AskUserQuestion call, related
  ones together, at most a couple of rounds per session. A large backlog gets
  triaged, not marched through: ask the load-bearing forks, default the rest.

## Post-lock — change orders, never silent edits

Invoked over a `locked` spec, first establish which situation this is — ask
the human, don't infer:

- **Amendment to a live (or paused) drive** → the change-order path below.
- **New work after a finished build** → a new contract, not an amendment:
  archive the locked spec (e.g. `specs/v1.md`) and the drained `.ailoop/`
  directory alongside it, then start fresh — new spec file, full
  interrogation, new ailoop intake. Feature 2 deserves the same grilling
  feature 1 got; routing it through change orders on a dead contract gives it
  none.

  Before scaffolding the new spec, run the **graduation pass** over the
  archived one. Inheritance is never spec-to-spec — the archive is a record,
  not a source — and every line of a finished spec has exactly one of three
  destinations:
  1. **Consumed by the build** (decisions the code + tests now enforce —
     hashing choices, TTLs, response shapes) → leave it behind; the
     regression suite defends it, and re-deciding it is a fresh fork in the
     new spec.
  2. **Still binding on future work** (stack, data model, "never do X" as
     permanent policy — anything constraining work that doesn't exist yet)
     → promote to the repo's durable docs (CLAUDE.md, docs/) if not already
     there; the new spec **cites** it as standing, never restates it.
  3. **Campaign-relative** (phases and ordering, done-means checks — already
     graduated into the test suite — this drive's out-of-scope tripwire,
     change orders) → dies in the archive as history.
  Then scaffold the new spec pre-seeded with the standing constraints
  (cited) and an "already exists" context read from reality — the code,
  the tests, the drained backlog's done tickets — never from the old
  spec's prose.

A locked spec with an ailoop drive in flight has a backlog and an oracle
derived from it; editing it in place is how the loop and the contract diverge
with nobody noticing. On any post-lock change request:

- Append a **Change order** entry (date, the change, rationale) — never
  rewrite the locked section silently — then apply the change and bump
  `spec_version`.
- Warn what it means downstream — concretely, because the machinery will act
  on it: ailoop recorded the spec's hash in `oracle.md` at intake, and its
  next resume **recomputes and refuses to dispatch on a mismatch**. The
  change-order entry is what that reconciliation reads to learn what changed
  and why — write it for that reader. A change to *what behavior counts as
  done* then goes through ailoop's semantic amendment tier; a structural
  change may need affected backlog tickets reseeded.

## Division of labor — what aispec must NOT do

- **No backlog seeding, no `oracle.md`, no ticket sizing.** That is ailoop
  intake's job; doing it twice creates two sources of truth. You get the
  acceptance *stated* precisely enough to mechanize — ailoop mechanizes it.
- **No building.** Not even a prototype "to check feasibility" — a feasibility
  doubt is an Open Questions entry or a Phase 0, not a side project.
- The spec is the **human-owned contract**; `.ailoop/` is machine-derived
  state. aispec touches only the former.
