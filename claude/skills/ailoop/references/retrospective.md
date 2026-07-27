# Termination & retrospective

Runs only when frontier.mjs reports `complete: true`, no phase sits in
`gateParked`, and every phase gate has been run green (check the journal for each
phase-close entry — never your memory).

## 1. Coverage pass

The arithmetic is already done: `coverage` in the frontier's output says which
requirement ids every claiming ticket closed (`proven`) and which nobody claimed
(`unmapped`). Don't re-count it. Spend this pass on the two questions counting
can't answer:

1. **Did each requirement's checks observe the boundary its clause names?** A
   `proven` clause only means the claiming tickets' own checks went green where
   they looked. A check reading through an admin connection didn't prove the
   grant; one reading the app's echo didn't prove persistence. Walk each clause
   against the acceptance checks that closed it and the phase-gate evidence.
2. **What did the enumeration itself miss?** Re-read the spec against
   `requirements`. A normative clause that never became an id is an *enumeration
   gap* — the one failure mode the join is structurally blind to, because
   `unmapped` can only count ids that exist.

Anything unproven or missing becomes a new ticket (draft → critic pass → the
drive resumes; the phase gates it re-opens must go green again). Both findings
are learnings candidates: the decomposition missed it once and could again.

## 2. Final report

To the human: what was built per phase, requirement coverage clause by clause,
gate evidence pointers, check amendments made (typo-level self-served;
meaning-level parked and how they were answered), gate replacements with the
command each displaced, quarantined flakes as explicit residuals, escaped bugs
and which checks got strengthened, every park and how it resolved, and the
recover log — each anomaly kind, how often it fired, and any kind that fired
enough to deserve a real arm in SKILL.md. Computed from the journal and evidence
files — never narrated from memory.

Alongside the prose report, render the post-mortem:

```
node .ailoop/campaign/postmortem.mjs --out specs/<spec>.postmortem.html
```

It lives next to the run report and embeds the raw journal, so the timeline,
per-ticket costs, and every journaled event survive the run-directory
deletion in step 4. This must run before that deletion — there is no
second chance.

## 3. Retrospective harvest → learnings

Read the full journal (this is real reasoning — thinking on). Distill
**candidates** per facet:

- `checks.json` — commands that worked, quirks discovered ("build needs env X")
- `flakes.json` — flakes met + their discriminator results
- `sizing.md` — what proved too big ("tickets spanning schema+UI always split")
- `gaming.md` — cheat shapes the gaming check caught (feed next campaign's critics)
- `landmines.md` — codebase surprises that cost a dispatch

Then **merge, never append** — split by facet:

The two keyed-JSON facets (`checks`, `flakes`) are pure arithmetic. Stage your
candidates as a harvest file and let the script do it — never by hand:

```
node .ailoop/campaign/learn.mjs merge --in <harvest.json> --campaign <name>
```

It upserts by key (`name` for checks, `test` for flakes), bumps evidence on a
match, ages every entry not re-confirmed this campaign, evicts entries stale
for 3 campaigns, and caps each facet at ~30 (lowest evidence first). `retire:
true` on a candidate flips its status so intake's Prime skips it.

The three prose facets (`sizing.md`, `gaming.md`, `landmines.md`) can't be
mechanically deduped — merge those by hand: matching candidate → sharpen and
note the re-confirmation; contradiction → resolve now (which is right, given
both campaigns' evidence?), never keep both; new → add.

- **Graduate**: an entry confirmed across many campaigns is no longer a
  learning, it's policy — propose the corresponding SKILL.md edit to the
  human instead of re-injecting it forever.

Single-campaign generalizations are often wrong. That's what the evidence
count is for — one campaign's lesson enters as a hypothesis and earns rule
status by surviving.

## 4. Close the campaign

Journal the close, flip the spec's frontmatter to `status: done` (aispec
treats `done` specs as retired records — this flip is what tells it the
contract is spent), then delete `.ailoop/campaign/` (learnings/ remains, tracked;
the journal survives inside the post-mortem HTML from step 2). The campaign
is over when — and only when — the human has the report and the post-mortem,
the spec reads `done`, and the run directory is gone.
