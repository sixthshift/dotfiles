export const meta = {
  name: 'ailoop-build-phase',
  description: 'Build a file-disjoint batch of ailoop tickets in parallel worktrees, mechanically verify each via verify.mjs, gaming-read the diffs, integrate the verified ones, and gate on the phase oracle',
  phases: [
    { title: 'Build', detail: 'one worker per ticket in its own git worktree — sonnet natively, or a haiku relay driving `codex exec` when builderEngine=codex', model: 'sonnet' },
    { title: 'Verify', detail: 'a relay runs verify.mjs — full fast tier + acceptance checks, scope diff, dirty-tree; exit codes decide', model: 'haiku' },
    { title: 'Gaming read', detail: 'session-model judgment over the dumped diff — skipped for scaffold tickets' },
    { title: 'Integrate', detail: 'merge only the verified worker branches; manifest conflicts resolved mechanically' },
    { title: 'Gate', detail: 'run the phase oracle on the merged tree (skipped when nothing merged)' },
  ],
}

// Invoked by the coordinator (SKILL.md Stage 2.2) ONLY for a file-disjoint batch
// of READY tickets (the scheduler's batches[0]). For a single ticket or a coupled
// phase, the coordinator dispatches one Agent directly (and runs verify.mjs +
// the gaming read itself) — no fan-out.
//
// Model tiering (SKILL.md 2.2): judgment never downgrades, measurement is
// scripted. Builders default to sonnet (per-ticket haiku opt-in for
// obviously-mechanical tickets); the Verify stage is a haiku RELAY because the
// determinism lives in verify.mjs, not the agent; the gaming read inherits the
// session model.
//
// args: {
//   tickets: [{ id, title, context, acceptance, acceptanceChecks: [], files: [],
//               attempts: [], builderModel?, scaffold? }],  // file-DISJOINT, all ready, files NON-EMPTY
//   baseSha: string,           // `git rev-parse HEAD`, captured by the coordinator IMMEDIATELY
//                              // before invoking: the commit the worktrees fork from and the
//                              // scope check's diff base — verify.mjs is handed it, never guesses
//   lockedDecisions: string,   // frozen decisions block from oracle.md, verbatim
//   baseline: string,          // the fast tier as prose, for the BUILDER's prompt; the verifier
//                              // runs the machine mirror (backlog.json fastChecks) via verify.mjs
//   phaseOracle: string,       // the phase's executable checks from oracle.md
//   builderEngine?: string,    // 'claude' (default) | 'codex'. codex swaps the Build stage's
//                              // native model agent for a haiku relay that drives `codex exec`
//                              // (gpt-5.6-terra; mechanical tickets → gpt-5.6-luna). EVERYTHING
//                              // downstream — verify relay, gaming read, integrate, gate — stays
//                              // Claude: builder is codex, judge is Claude, on purpose.
//   codexSchemaPath?: string,  // ABSOLUTE path to .ailoop/codex-build-schema.json (the coordinator
//                              // wrote it at Stage 0). Handed to `codex exec --output-schema` so
//                              // codex's final message is validated to BUILD_RESULT's shape.
// }
const { tickets, baseSha, lockedDecisions, baseline, phaseOracle,
        builderEngine = 'claude', codexSchemaPath } = args

const MANIFEST_ALLOWLIST =
  'package.json, package-lock.json, bun.lock, bun.lockb, yarn.lock, pnpm-lock.yaml'

// codex tiers mirror the Claude tiers they replace: terra≈sonnet (the default
// builder), luna≈haiku (the mechanical opt-down). Reasoning effort per OpenAI's
// recommendation for each tier. Only the Build stage uses these — the judging
// path never leaves Claude.
const CODEX_MODEL = { builder: 'gpt-5.6-terra', mechanical: 'gpt-5.6-luna' }
const CODEX_EFFORT = { 'gpt-5.6-terra': 'high', 'gpt-5.6-luna': 'medium' }

// Every worker returns exactly one of these shapes — no half-built states.
const BUILD_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    done: { type: 'boolean' },
    branch: { type: 'string', description: 'the worktree branch the work is on; required when done, so Verify can re-check it' },
    evidence: { type: 'string', description: 'baseline + acceptance output the worker ran; required when done' },
    tooBig: { type: 'boolean' },
    proposedTickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          context: { type: 'string' },
          acceptance: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'context', 'acceptance'],
      },
    },
    blocked: { type: 'boolean' },
    reason: { type: 'string' },
    // Set ONLY by a codex relay when `codex exec` COULD NOT RUN — nonzero exit,
    // crash, timeout, auth failure, or no parseable final message. An INFRA
    // failure: the coordinator hard-exits the whole loop on any engineError
    // (SKILL.md Stage 0), never falling back to sonnet. NOT for a codex that ran
    // and produced a bad/incomplete result — a red build, an out-of-scope touch,
    // or a clean exit that left the tree DIRTY are all normal reds (done:false
    // with a reason), re-dispatched like any Claude build. engineError means
    // "codex is unavailable," full stop.
    engineError: { type: 'string' },
    // Best-effort token usage parsed from the codex `--json` event stream, so the
    // per-ticket cost dossier reflects codex's real spend and not just the haiku
    // relay's (SKILL.md 2.3b). Absent on native builds and when the stream had no
    // usage event.
    codexUsage: {
      type: 'object',
      additionalProperties: true,
      properties: {
        inputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
        totalTokens: { type: 'number' },
      },
    },
  },
  required: ['done'],
}

// verify.mjs's JSON output, relayed verbatim by the Verify runner.
const VERIFY_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ticket: { type: 'string' },
    verified: { type: 'boolean' },
    dirty: { type: 'boolean', description: 'worktree had uncommitted changes — only committed work verifies' },
    failing: { type: 'array', items: { type: 'string' }, description: "failed check NAMES — becomes the attempts entry's failed set, verbatim" },
    outOfScopeFiles: { type: 'array', items: { type: 'string' }, description: 'touched paths not in the declared files nor the manifest allowlist' },
    touched: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string', description: 'path to the captured check output under .ailoop/evidence/' },
    diff: { type: 'string', description: 'path to the dumped diff patch — the gaming read input' },
    scriptError: { type: 'string', description: 'set ONLY when verify.mjs itself failed to run (exit 2 / crash)' },
  },
  required: ['verified'],
}

const GAMING_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suspectedGaming: { type: 'string', description: 'why the diff looks like it games the acceptance rather than implementing the intent; empty string if clean' },
  },
  required: ['suspectedGaming'],
}

const MERGE_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merged: { type: 'array', items: { type: 'string' } },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticket: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          detail: { type: 'string' },
        },
        required: ['ticket', 'detail'],
      },
    },
  },
  required: ['merged', 'conflicts'],
}

const ORACLE_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    passed: { type: 'boolean' },
    failing: { type: 'array', items: { type: 'string' }, description: 'check → why it failed' },
    evidence: { type: 'string', description: 'captured command/test output, verbatim' },
  },
  required: ['passed', 'failing', 'evidence'],
}

// The BUILD BRIEF — what the builder is told, engine-independent. It is the
// native builder's prompt verbatim; the codex relay hands this SAME text to
// `codex exec` as the task. One brief, two engines: the ticket's contract does
// not change with who executes it.
const buildBrief = t => [
  'You are building ONE ticket inside an isolated git worktree. Build ONLY this ticket.',
  `Touch ONLY the DECLARED FILES below — plus the manifest allowlist (${MANIFEST_ALLOWLIST})`,
  'if you must add a dependency. Any other file you touch will fail independent',
  'verification. Do not re-litigate the frozen decisions.',
  '',
  'FROZEN DECISIONS (never violate; do not second-guess):',
  lockedDecisions,
  '',
  `TICKET ${t.id} — ${t.title}`,
  `DECLARED FILES: ${(t.files ?? []).join(', ')}`,
  'CONTEXT:',
  t.context,
  ...(t.attempts?.length ? [
    '',
    'PRIOR FAILED ATTEMPTS (do not repeat these mistakes; apply the fix notes):',
    JSON.stringify(t.attempts, null, 2),
  ] : []),
  '',
  'BASELINE (every ticket must pass this, regardless of what it touches):',
  baseline,
  '',
  "ACCEPTANCE (this ticket's own behavioral checks):",
  t.acceptance,
  '',
  'Do, in order: (1) build only this ticket; (2) add tests covering the new',
  'behavior (skip only for pure scaffold/config with nothing to test — say so);',
  "(3) run the BASELINE — you may scope its full-test-suite step to the tests",
  'your change affects; the independent verifier runs it in full — and the',
  'ACCEPTANCE; capture their real output; (4) commit your work on your branch',
  'in conventional format — `type(scope): subject`, imperative mood, why-focused',
  'body when there is rationale worth keeping. These commits merge into the',
  "mainline's permanent history. Leave NOTHING uncommitted — the verifier",
  'fails a dirty tree.',
  '',
  'Return exactly one shape:',
  '- { done:true, branch:"<your worktree branch>", evidence } when baseline AND',
  '  acceptance pass (evidence = the captured output). Report your branch so it',
  '  can be independently re-verified.',
  '- { done:false, tooBig:true, proposedTickets:[...] } if this is bigger than one',
  '  focused session — propose a split and STOP. Do NOT leave a half-built change.',
  '- { done:false, blocked:true, reason } if a real dependency is missing or the spec contradicts itself.',
].join('\n')

// codex relay: a cheap Claude agent (haiku — it only shells out and relays, no
// judgment) running INSIDE a Workflow-managed worktree, driving `codex exec` to
// do the actual build there. Why a relay at all: Workflow scripts have no shell,
// so codex can only be reached through an agent that has Bash. Why haiku: the
// relay's judgment budget is zero; terra/luna do the thinking inside codex.
const codexRelay = (t, model) => [
  'You are a RELAY that runs the external `codex` coding agent to build ONE ticket.',
  'You do NOT build it yourself and you do NOT judge the result — you drive codex',
  'and report exactly what it returns. You are inside a fresh, isolated git worktree;',
  'your current directory IS that worktree.',
  '',
  'CRITICAL: keep ALL your own scratch files OUTSIDE the worktree — the verifier',
  'fails a dirty tree, and an untracked brief/result file left in the worktree is a',
  'dirty tree. Use /tmp for them.',
  '',
  `Step 1 — Write the BUILD BRIEF at the very bottom of this message VERBATIM to`,
  `\`/tmp/codex-brief-${t.id}.md\` (use the Write tool — do not paraphrase or trim it).`,
  '',
  'Step 2 — Run codex, feeding the brief on stdin. `--json` streams events (incl.',
  'token usage) to stdout — capture them to a file; `-o` writes the final',
  'schema-validated message separately (single command):',
  '```',
  `codex exec -C "$(pwd)" -m ${model} \\`,
  `  -c model_reasoning_effort=${CODEX_EFFORT[model]} \\`,
  '  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral --json \\',
  `  --output-schema ${codexSchemaPath} \\`,
  `  -o /tmp/codex-result-${t.id}.json - < /tmp/codex-brief-${t.id}.md \\`,
  `  > /tmp/codex-events-${t.id}.jsonl 2> /tmp/codex-err-${t.id}.log`,
  '```',
  'codex will edit files and MUST commit its work on the current branch (the brief',
  'tells it to). Sandbox is bypassed on purpose — this loop runs in an isolated',
  'container — so its commits land in the worktree normally. `--ephemeral` keeps',
  'codex from persisting session files into the tree.',
  '',
  'Step 3 — Classify the outcome. Two DISTINCT failure kinds — do not conflate:',
  `- **codex could not run** — nonzero exit, timeout, crash, an auth error in`,
  `  \`/tmp/codex-err-${t.id}.log\`, or no parseable \`/tmp/codex-result-${t.id}.json\`.`,
  '  Return { done:false, engineError:"<tail of the err log, ~500 chars>" }. This is',
  '  an INFRA stop the coordinator owns — do NOT retry, do NOT build it yourself.',
  `- **codex ran but the build is incomplete** — it exited 0 and produced a result,`,
  '  but `git status --porcelain` is non-empty (it left the tree dirty). This is a',
  '  NORMAL red, not an engine failure: return the result object with { done:false,',
  '  reason:"codex exited cleanly but left an uncommitted tree" } so the coordinator',
  '  re-dispatches it like any failed build. Do NOT set engineError here.',
  '- **success** — exited 0, result parseable, tree clean. Continue.',
  '',
  'Step 4 — On success, read the result object from the result file. From',
  `\`/tmp/codex-events-${t.id}.jsonl\` find the token-usage event (the final usage /`,
  'token_count event; fields vary by codex version) and read input/output/total',
  'tokens if present. Capture your branch: `git rev-parse --abbrev-ref HEAD`.',
  '',
  'Step 5 — Return the result object VERBATIM, with `branch` set to your branch and',
  '`codexUsage:{ inputTokens, outputTokens, totalTokens }` added (omit codexUsage if',
  'the stream had no usage event). Add nothing else, judge nothing.',
  '',
  '════════════════════ BUILD BRIEF (write verbatim to the brief file) ════════════════════',
  buildBrief(t),
].join('\n')

// Engine dispatch: native Claude model agent, or the codex relay. Both run in a
// Workflow-managed worktree (isolation:'worktree'), both return BUILD_RESULT on a
// branch — everything downstream is identical.
const dispatchBuild = t => builderEngine === 'codex'
  ? agent(
      codexRelay(t, t.builderModel === 'haiku' ? CODEX_MODEL.mechanical : CODEX_MODEL.builder),
      { label: `build:${t.id}`, phase: 'Build', isolation: 'worktree', schema: BUILD_RESULT, model: 'haiku' }
    ).then(result => ({ ticket: t, result }))
  : agent(
      buildBrief(t),
      // Builders default to Sonnet: the locked spec + ticket constrain them, and
      // independent verification catches what they get wrong. A ticket the
      // coordinator marked obviously-mechanical opts down via builderModel.
      { label: `build:${t.id}`, phase: 'Build', isolation: 'worktree', schema: BUILD_RESULT, model: t.builderModel ?? 'sonnet' }
    ).then(result => ({ ticket: t, result }))

// ── Build → Verify → Gaming read (pipelined) ─────────────────────────────
// pipeline, not a barrier: each ticket's verify starts the moment its own
// build finishes — fast tickets never wait for the batch's slowest build.
// Workers run in isolated worktrees so parallel file writes cannot collide;
// they add tests for new behavior and run the gate themselves — but their
// result is only a claim; verify.mjs is what counts.
phase('Build')
const results = (await pipeline(
  tickets,

  t => dispatchBuild(t),

  // Mechanical verify: a RELAY agent runs verify.mjs and reports its JSON.
  // haiku on purpose — the determinism lives in the script (full fast tier +
  // acceptanceChecks, scope diff from baseSha, dirty-tree check, evidence +
  // diff dump); the agent only locates the worktree and pipes. The builder's
  // self-report does not count — the script's exit codes do.
  // tooBig/blocked/dead builds skip straight through to the partition below.
  b => !b.result?.done ? b : agent(
    [
      'You are a RELAY, not a judge. Do exactly this and report the output.',
      '',
      `1. Locate the worktree for branch ${b.result.branch || `(the worktree for ticket ${b.ticket.id} — find it via \`git worktree list\`)`}:`,
      '   `git worktree list` from the repo root — the line whose branch matches.',
      `   If no worktree lists it, create one: \`git worktree add .ailoop/wt-verify-${b.ticket.id} ${b.result.branch || '<branch>'}\``,
      '   and use that path (leave it in place — the coordinator prunes at phase close).',
      "2. If the checks need dependencies installed in that worktree, install them",
      "   with the project's own install command.",
      '3. From the repo root (the main tree), run:',
      `   node .ailoop/verify.mjs --ticket ${b.ticket.id} --dir <worktree path> --base ${baseSha}`,
      '4. Relay its JSON output as your result, VERBATIM — do not reinterpret it,',
      '   re-run checks selectively, or fix anything. If the script itself fails to',
      '   run (exit 2 or crash), return { verified:false, scriptError:"<its stderr>" }.',
    ].join('\n'),
    { label: `verify:${b.ticket.id}`, phase: 'Verify', schema: VERIFY_RESULT, model: 'haiku' }
  ).then(v => ({ ...b, verify: v })),

  // Gaming read: the one judgment verification keeps. No model override —
  // it inherits the session model; judgment never downgrades. Skipped for
  // scaffold tickets (nothing behavioral to game) and for anything that
  // already failed mechanically (no point judging a red).
  b => (!b.verify?.verified || b.ticket.scaffold) ? b : agent(
    [
      'You are the GAMING READ over an already-mechanically-verified ticket.',
      'The checks passed; your question is whether they passed HONESTLY.',
      '',
      `Read the diff at ${b.verify.diff} (a patch file dumped by the verifier).`,
      'Was the acceptance satisfied by implementing the intent, or by gaming the',
      'check — hardcoded outputs, weakened or deleted tests, special-cased inputs?',
      '',
      `TICKET ${b.ticket.id} — ${b.ticket.title}`,
      'ACCEPTANCE (what the checks were supposed to pin):',
      b.ticket.acceptance,
      '',
      'Fix NOTHING — you only judge. Suspicion does not need proof: say exactly',
      'why in suspectedGaming and the coordinator judges against the spec.',
      'Return { suspectedGaming } — empty string if clean.',
    ].join('\n'),
    { label: `gaming:${b.ticket.id}`, phase: 'Gaming read', schema: GAMING_RESULT }
  ).then(g => ({ ...b, gaming: g }))
)).filter(Boolean) // a stage that threw drops its ticket to null

// engineError (codex couldn't run) is an infra failure, not a build outcome —
// pulled out so the coordinator can hard-exit the loop (SKILL.md Stage 0). The
// in-flight batch still finishes verify/merge/gate for whatever DID build, so no
// completed work is thrown away before the stop; the coordinator simply dispatches
// nothing further.
const engineErrors = results.filter(b => b.result?.engineError)
const notDone = results.filter(b => !b.result?.done && !b.result?.engineError) // tooBig / blocked / dead worker → coordinator
const verifyFailed = results.filter(b => b.result?.done && !b.verify?.verified) // re-dispatch by coordinator (incl. scriptError — inspect before blaming the build)
// Gaming suspicion does not auto-fail, but a suspect is held OUT of integration:
// the coordinator reads the diff and judges before it can merge (SKILL.md 2.3).
const suspected = results.filter(b => b.verify?.verified && b.gaming?.suspectedGaming)
const passed = results.filter(b => b.verify?.verified && !b.gaming?.suspectedGaming)

// ── Integrate ────────────────────────────────────────────────────────────
// Merge ONLY independently-verified, unsuspected branches. Workflow scripts have
// no shell; a single integrator agent does the merge on the working tree.
phase('Integrate')
const merge = passed.length === 0
  ? { merged: [], conflicts: [] }
  : (await agent(
      [
        'Integrate the VERIFIED ticket branches into the current working branch.',
        `Verified tickets to merge: ${passed.map(b => b.ticket.id).join(', ')}`,
        `Branches: ${passed.map(b => b.result.branch).filter(Boolean).join(', ') || '(discover via git)'}`,
        'Merge them into the current branch one at a time.',
        'Manifest conflicts are mechanical: take the union of package.json additions',
        "and REGENERATE the lockfile with the project's install command — never",
        'hand-merge a lockfile. Beyond that, resolve only trivial/obvious conflicts.',
        'Do NOT invent code to resolve a non-trivial conflict — report it.',
        'Do NOT delete the merged branches — the coordinator prunes them only after',
        'the phase oracle is green (a gate-red bisection needs them intact).',
        'Return { merged:[ids], conflicts:[{ticket, files, detail}] }.',
      ].join('\n'),
      { label: 'integrate', phase: 'Integrate', schema: MERGE_RESULT }
    )) ?? { merged: [], conflicts: [{ ticket: '(batch)', detail: 'integrator agent died — merge state unknown; coordinator must inspect the tree' }] }

// ── Gate ─────────────────────────────────────────────────────────────────
// The phase oracle on the MERGED tree — the coarsest, final gate. Per-worktree
// green does not count. Nothing merged → nothing new to gate: oracle stays
// null and the coordinator knows phase state is unchanged. This agent only
// runs checks and captures output. If it comes back red after a clean merge,
// the coordinator bisects and spawns a repair ticket (SKILL.md 2.3) — the
// workflow does not improvise.
phase('Gate')
const oracle = merge.merged.length === 0 ? null : await agent(
  [
    'Run the phase oracle on the current (merged) working tree. Run each check,',
    'capture its real output, and report. Fix NOTHING — you only measure.',
    '',
    'PHASE ORACLE:',
    phaseOracle,
    '',
    'Return { passed, failing:[check → why], evidence:<captured output, verbatim> }.',
  ].join('\n'),
  { label: 'gate', phase: 'Gate', schema: ORACLE_RESULT }
)

return {
  built: results.map(b => ({ id: b.ticket.id, result: b.result })),
  engineError: engineErrors.map(b => ({ id: b.ticket.id, reason: b.result.engineError })), // codex unavailable → coordinator HARD-EXITS the loop (no fall-back to sonnet)
  notDone: notDone.map(b => ({ id: b.ticket.id, result: b.result })),          // tooBig / blocked / dead worker
  verifyFailed: verifyFailed.map(b => ({ id: b.ticket.id, verify: b.verify })), // built but failed verify.mjs (checks, scope, dirty tree — or scriptError)
  suspectedGaming: suspected.map(b => ({ id: b.ticket.id, branch: b.result.branch, verify: b.verify, gaming: b.gaming })), // mechanically green but diff looks gamed — coordinator judges before these may merge
  merge,
  oracle, // null when nothing merged (phase state unchanged)
}
