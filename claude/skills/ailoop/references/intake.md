# Stage 1 — Intake & Oracle Contract

Read via SKILL.md's router on the **first invocation only** (`.ailoop/` absent;
see **Resume** in SKILL.md for re-invocations). Produce `.ailoop/oracle.md`,
`.ailoop/backlog.json`, and `.ailoop/ledger.md` (templates in `templates/`),
copy `templates/schedule.mjs`, `templates/verify.mjs`, `templates/report.mjs`,
and `templates/timing.mjs` into `.ailoop/`, and create `.ailoop/evidence/` for
captured check output and per-ticket sidecars. This is the pre-flight; the
human sees it and the drive runs unattended after.

0. **Locate the spec.** Use the path the user gave, or look in `specs/` for
   `status: locked` frontmatter (`draft` specs are invisible here; `done` are
   retired legacy):
   - **exactly one locked** → that is the contract;
   - **several locked** → **ask which** (AskUserQuestion). Ideally only one
     spec is locked at a time — a spec queued behind another campaign goes
     stale waiting — and picking the campaign is intent, never defaulted.
     The `.ailoop/` created at intake is what marks the chosen one active
     from then on;
   - **none locked** (drafts only, nothing, or only a legacy root
     `SPEC.md`/`PLAN.md`) → **refuse to start** — a draft goes back to
     `/aispec` to finish; a legacy or ambiguous document is a stop-and-ask,
     never a guess. Also detect the project's own
   toolchain (type-check / test / build commands, package manager) from its
   manifest; the oracle's checks must use *this* project's commands, not
   assumed ones.

1. **Read the entire spec.** Extract, verbatim where possible:
   - **Build order / phases.** Respect the spec's own phasing and de-risk order
     — do not invent your own plan. (A good spec puts the riskiest phase first;
     honor that.)
   - **Locked decisions.** Stack, data model, architecture, "do not add X"
     lists. These are frozen — workers must never re-litigate them. Copy them
     into the oracle doc so every worker prompt can cite them.
   - **Out-of-scope list** → the scope tripwire.

2. **Derive the per-phase oracle.** For each phase, write the *executable*
   checks that mean "this phase is done." Each check is a command with an
   expected result, or a scripted acceptance test. Prefer, in order:
   - build/type-check passes (e.g. `bun run check`),
   - the service boots and a health endpoint responds,
   - a **behavioral** acceptance test the spec names explicitly (the sharpest
     kind — e.g. "given these 3 contrasting inputs, the output must differ in
     *this* way"). Write it as a runnable harness, not a vibe.

   Also record in `oracle.md`: the **baseline gate** — the type-check / build /
   lint / test commands (from step 0's toolchain detection) that *every*
   ticket must pass regardless of what it touches, classified into fast tier
   (per ticket) and gate tier (per phase close) per **Verification** in
   SKILL.md. Mirror the fast tier into `backlog.json` as `fastChecks`
   (`{name, cmd}` entries) — the machine copy `verify.mjs` runs; `oracle.md`
   stays the human-readable authority, and an amendment to one amends both
   — and the **contract identity**: the spec's path, its `spec_version` (if the
   frontmatter has one), and its sha256 content hash (`shasum -a 256`). Resume
   verifies this identity before every run; it is what makes a mid-drive spec
   change detectable instead of silent.

3. **The refuse-to-start gate.** Stop and ask the human if either:
   - a phase's oracle is not executable **as written** (hand-wavy / no runnable
     check) — a full autonomous run with a fuzzy oracle is the single most
     dangerous configuration this skill can be in; **or**
   - the oracle is well-defined but its **environment preconditions aren't
     met** — the checks can't actually run here. Probe these at intake: required
     API keys/secrets, network access, a git repo (worktree fan-out needs one),
     runtimes/toolchain, and any runtime discrepancy between the spec's locked
     stack and what's installed. A verifiable-in-principle oracle you cannot run
     *now* is not a green light.

4. **Seed the backlog.** Turn each phase into tickets in `.ailoop/backlog.json`,
   each sized to one focused subagent session and written cold-start runnable
   (full schema in SKILL.md), each tagged with its `phase` and a **non-empty**
   `files` declaration **anchored in evidence**: every declared path either
   exists and demonstrably hosts the behavior (grep for it; cite the anchor in
   `context`) or is an explicit create. Never infer what the codebase probably
   calls things — a guessed home is a wasted dispatch when the builder
   discovers the real one, and it is the single most repeated footprint bug in
   practice. Wire `depends_on` so the graph encodes the spec's
   de-risk order — the riskiest phase's tickets come first and downstream
   tickets depend on them. Err small; you will decompose further mid-flight
   anyway. Do **not** try to enumerate every ticket for late phases perfectly —
   seed them coarsely and refine as earlier tickets teach you the shape.
   Give every behavioral ticket its `acceptanceChecks` (the runnable mirror of
   `acceptance`); mark pure scaffold/config tickets `scaffold: true` (skips
   the gaming read); an obviously-mechanical ticket may carry
   `builderModel: "haiku"`.

   Then write the **coverage map** into `oracle.md`: every requirement/section
   of the spec → the ticket(s) or oracle check that delivers it. A requirement
   with no entry gets a ticket now or an explicit "deferred" line — silence in
   this map is how an under-derived intake finishes an incomplete build with
   every check green. Update the map as tickets decompose.

5. **Red-team the acceptance.** Before any build spend, fan out a few cheap
   agents (one per phase's tickets), each running the **two-lens pass defined
   in SKILL.md → When a check is wrong** — gaming, then instrument blindness.
   Each cheat or blind spot found = sharpen the check. Prefer
   input→output contrast checks ("these 3 JDs must flip the lede differently")
   over artifact-existence checks ("file exists", "function returns") —
   existence is the most gameable form. Record the pass in the ledger.

6. **Set the caps.** In `backlog.json`'s `caps`: per-ticket max attempts
   (default 3) and the thrash threshold (a ticket's failing set doesn't shrink
   across 2 attempts → escalate; the scheduler computes this from the
   `attempts` log). There is no cap on total dispatches — the run goes to
   completion. Snapshot the caps in the ledger run header.

7. **Keep the campaign out of git.** `.ailoop/` and `specs/` are untracked by
   design — campaign state, noise in the project's history. Ensure
   `.gitignore` covers both (add the entries if missing). The run's durable
   record is the merged code, its tests, and the workers' branch commits;
   the rare commit you author on the mainline yourself goes through the
   **`commit` skill**. Accepted cost, on the record: disk holds the
   campaign's only copy — a `git clean -fdx` mid-run wipes the loop's memory
   (worker branches survive; a re-intake reconciles).

Report the intake to the user as a short pre-flight: the phase→oracle map, the
seeded backlog (ticket count + the first few ready tickets + the dependency
spine), the caps, the red-team findings, and any oracle you had to ask them to
supply. Then drive (SKILL.md Stage 2).
