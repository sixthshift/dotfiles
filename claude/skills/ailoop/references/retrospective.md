# Termination & retrospective

Runs only when frontier.mjs reports `complete: true` AND every phase gate has
been run green (check the journal for each phase-close entry — never your
memory).

## 1. Coverage pass

Walk the spec section by section against closed tickets and phase-gate
evidence. Every requirement maps to delivered, verified work — or the build
is **not done**: spawn the missing tickets (draft → critic pass → drive
resumes). An unmapped requirement discovered here is also a learnings
candidate: the decomposition missed it once and could again.

## 2. Final report

To the human: what was built per phase, gate evidence pointers, check
amendments made (typo-level self-served; meaning-level escalations and their
resolutions), quarantined flakes as explicit residuals, escaped bugs and
which checks got strengthened, walls hit. Computed from the journal and
evidence files — never narrated from memory.

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
