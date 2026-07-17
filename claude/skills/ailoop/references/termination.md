# Termination — closing a completed campaign

Read via SKILL.md's router when the scheduler reports `complete: true` and
every phase oracle is green. Never close a campaign — or report the build done
— without following this file.

**First, the coverage pass.** Re-read the spec against `oracle.md`'s coverage
map — every requirement must point at a `done` ticket or a green check, or sit
explicitly under Cut / deferred. An unmapped requirement means the build is
**not** done, whatever the backlog says: seed the missing tickets and keep
driving.

**Then the final report:**

- **Run audit + per-ticket dossier:** run
  `node .ailoop/run/report.mjs --out specs/<spec-basename>.run-report.md` and lead
  with its output. **The `--out` is mandatory and must point OUTSIDE
  `.ailoop/run/`** (the spec folder) — `.ailoop/run/` is deleted seconds later, so a
  report written inside it dies with it; this is the durable artifact that
  outlives the campaign. The audit half is the operational glimpse a long
  unattended run hides (wall-clock by phase active-vs-paused, the long poles,
  the work breakdown); the dossier half is the per-ticket breakdown from the
  sidecars (timing split, cost, findings). It is computed from the ledger
  stamps and the sidecars, not narrated by you; add a line or two reading
  where the time went, but the numbers are the script's. If the dossier is
  empty or the audit reports unmeasured gaps, say so — never paper over them
  with estimates (an empty dossier means the accept-time capture in 2.3b was
  skipped).
- **Shipped:** what was built, keyed by phase / ticket.
- **Oracle evidence:** the passing check output per phase (the proof, not
  your say-so).
- **Coverage:** the spec→delivery map, every requirement resolved as
  shipped or explicitly deferred.
- **Backlog history:** tickets completed, decomposed, repaired — the shape
  of the work, honestly.
- **Cut / deferred:** anything the spec deferred or you consciously left out.
- **Drift caught:** scope tripwires, retries, gamed tickets, gate-red
  bisections, oracle amendments, flake quarantines carried as residuals —
  plain, not smoothed over.

**Then harvest to `.ailoop/learnings/`** — before `.ailoop/run/` is deleted,
consolidate what this campaign learned so the next one starts smarter (SKILL.md
— Durable state). This is the write half of the learnings loop; intake's Prime
is the read half. The transcripts and `run/` state vanish seconds from now — this
is the last moment the evidence exists. Only proposals grounded in **this run's
evidence** belong here; a hunch is not a learning.

Two facets are keyed JSON merged by script; three are prose you author.

- **Keyed JSON (via `learn.mjs`).** Stage the run's confirmed facts into
  `.ailoop/run/harvest.json`:
  - `checks` — the fast/gate commands that ended green (from `backlog.json`'s
    `fastChecks` and `oracle.md`'s gate tier), each with any quirk worth carrying:
    `{ name, cmd, tier, note? }`.
  - `flakes` — every quarantine still open in `oracle.md`
    (`{ test, cmd, mode, discriminator }`); a flake this run proved stable gets
    `retire: true`.

  Then merge — keyed dedup, provenance stamp, retirement, never by hand:
  ```
  node .ailoop/run/learn.mjs merge --in .ailoop/run/harvest.json --campaign <spec-basename>
  ```
- **Prose (you author — prose can't be mechanically deduped).** Append to
  `.ailoop/learnings/{sizing,patterns,landmines}.md`, each entry stamped with its
  provenance: the campaign, the date (live `date` read), and a **durable**
  evidence anchor — a commit SHA or the run-report path, never a pointer into
  `run/evidence/`, which is about to be deleted.
  - **`sizing.md`** — areas that decomposed repeatedly or hit `tooBig`.
  - **`patterns.md`** — gaming shapes caught and instrument-blindness blind spots
    found (from the ledger's gaming/amend entries).
  - **`landmines.md`** — codebase surprises a worker hit (from findings sidecars).

  Reading each existing prose file, **retire what this run contradicted** — a
  landmine in code since rewritten, a sizing prior that proved wrong: the
  validate guard's write half. First campaign in a repo → `learn.mjs` creates the
  JSON files; you create the prose files fresh.

**Then close the campaign:** confirm the run report was written to the spec
folder (the `--out` above) — that is the only record that survives — tear down
any provisioned verify resources (`node .ailoop/run/verify.mjs
--teardown-resources`; skip when the backlog has no `resources` block), flip
the spec's frontmatter to `status: done`, and **delete `.ailoop/run/` only** —
never the `.ailoop/` container, and never its `.ailoop/learnings/` sibling,
which persists across campaigns. Deleting `run/` is what marks the campaign
closed; the next intake's spec lookup relies on that invariant. The `done` spec
and its `.run-report.md` stay on disk (untracked) until the next `/aispec`
session graduates and deletes them.
