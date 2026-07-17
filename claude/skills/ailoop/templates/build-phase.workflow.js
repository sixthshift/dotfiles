export const meta = {
  name: 'ailoop-build-phase',
  description: 'Build a file-disjoint batch of ailoop tickets in parallel worktrees, mechanically verify each via verify.mjs, gaming-read the diffs, integrate the verified ones, and gate on the phase oracle',
  phases: [
    { title: 'Build', detail: 'one worker per ticket in its own git worktree', model: 'sonnet' },
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
// }
const { tickets, baseSha, lockedDecisions, baseline, phaseOracle } = args

const MANIFEST_ALLOWLIST =
  'package.json, package-lock.json, bun.lock, bun.lockb, yarn.lock, pnpm-lock.yaml'

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
    evidence: { type: 'string', description: 'path to the captured check output under .ailoop/run/evidence/' },
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

// ── Build → Verify → Gaming read (pipelined) ─────────────────────────────
// pipeline, not a barrier: each ticket's verify starts the moment its own
// build finishes — fast tickets never wait for the batch's slowest build.
// Workers run in isolated worktrees so parallel file writes cannot collide;
// they add tests for new behavior and run the gate themselves — but their
// result is only a claim; verify.mjs is what counts.
phase('Build')
const results = (await pipeline(
  tickets,

  t => agent(
    [
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
      ...(t.resources?.length ? [
        '',
        `SHARED RESOURCES: this ticket's checks mutate ${t.resources.join(', ')} — sibling`,
        'builders may contend with your own check runs against the shared dev instance.',
        'A resource-flavored failure in YOUR run can be contention, not your code:',
        're-run once before diagnosing deeply. The independent verifier runs your',
        'checks against a leased, isolated instance — that run is what counts.',
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
    ].join('\n'),
    // Builders default to Sonnet: the locked spec + ticket constrain them, and
    // independent verification catches what they get wrong. A ticket the
    // coordinator marked obviously-mechanical opts down via builderModel.
    { label: `build:${t.id}`, phase: 'Build', isolation: 'worktree', schema: BUILD_RESULT, model: t.builderModel ?? 'sonnet' }
  ).then(result => ({ ticket: t, result })),

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
      `   If no worktree lists it, create one: \`git worktree add .ailoop/run/wt-verify-${b.ticket.id} ${b.result.branch || '<branch>'}\``,
      '   and use that path (leave it in place — the coordinator prunes at phase close).',
      "2. If the checks need dependencies installed in that worktree, install them",
      "   with the project's own install command.",
      '3. From the repo root (the main tree), run:',
      `   node .ailoop/run/verify.mjs --ticket ${b.ticket.id} --dir <worktree path> --base ${baseSha}`,
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

const notDone = results.filter(b => !b.result?.done) // tooBig / blocked / dead worker → coordinator
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
  notDone: notDone.map(b => ({ id: b.ticket.id, result: b.result })),          // tooBig / blocked / dead worker
  verifyFailed: verifyFailed.map(b => ({ id: b.ticket.id, verify: b.verify })), // built but failed verify.mjs (checks, scope, dirty tree — or scriptError)
  suspectedGaming: suspected.map(b => ({ id: b.ticket.id, branch: b.result.branch, verify: b.verify, gaming: b.gaming })), // mechanically green but diff looks gamed — coordinator judges before these may merge
  merge,
  oracle, // null when nothing merged (phase state unchanged)
}
