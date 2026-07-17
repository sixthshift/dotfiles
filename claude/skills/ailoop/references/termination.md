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
  `node .ailoop/report.mjs --out specs/<spec-basename>.run-report.md` and lead
  with its output. **The `--out` is mandatory and must point OUTSIDE
  `.ailoop/`** (the spec folder) — `.ailoop/` is deleted seconds later, so a
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

**Then close the campaign:** confirm the run report was written to the spec
folder (the `--out` above) — that is the only record that survives — flip the
spec's frontmatter to `status: done`, and **delete `.ailoop/`**. Its presence
is what marks a campaign in flight, and the next intake's spec lookup relies
on that invariant. The `done` spec and its `.run-report.md` stay on disk
(untracked) until the next `/aispec` session graduates and deletes them.
