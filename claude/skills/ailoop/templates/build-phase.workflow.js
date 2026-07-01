export const meta = {
  name: 'ailoop-build-phase',
  description: 'Build a file-disjoint batch of ailoop tickets in parallel worktrees, independently verify each, integrate the verified ones, and gate on the phase oracle',
  phases: [
    { title: 'Build', detail: 'one worker per ticket in its own git worktree' },
    { title: 'Verify', detail: 'independent agent re-runs baseline + acceptance per ticket' },
    { title: 'Integrate', detail: 'merge only the verified worker branches; report conflicts' },
    { title: 'Gate', detail: 'run the phase oracle on the merged tree' },
  ],
}

// Invoked by the coordinator (SKILL.md Stage 2.2) ONLY for a file-disjoint batch
// of READY tickets. For a single ticket or a coupled phase, the coordinator
// dispatches one Agent directly (and re-verifies it itself) — no fan-out.
//
// args: {
//   tickets: [{ id, title, context, acceptance, files: [] }],  // file-DISJOINT, all ready
//   lockedDecisions: string,   // frozen decisions block from oracle.md, verbatim
//   baseline: string,          // the baseline gate: type-check/build/lint/full-test-suite commands
//   phaseOracle: string,       // the phase's executable checks from oracle.md
// }
const { tickets, lockedDecisions, baseline, phaseOracle } = args

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

const VERIFY_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verified: { type: 'boolean' },
    failing: { type: 'array', items: { type: 'string' }, description: 'check → why it failed (empty when verified)' },
    regressedBaseline: { type: 'boolean', description: 'true if the baseline broke even though acceptance may pass' },
    evidence: { type: 'string', description: 'captured baseline + acceptance output, verbatim' },
  },
  required: ['verified', 'failing', 'evidence'],
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

// ── Build ────────────────────────────────────────────────────────────────
// One worker per ticket, each in its own worktree so parallel file writes
// cannot collide. Workers add tests for new behavior and run the FULL gate
// (baseline + acceptance) themselves — but their result is only a claim; the
// Verify stage below is what actually counts.
phase('Build')
const built = await parallel(tickets.map(t => () =>
  agent(
    [
      'You are building ONE ticket inside an isolated git worktree. Build ONLY this ticket.',
      'Do not touch files outside its scope. Do not re-litigate the frozen decisions.',
      '',
      'FROZEN DECISIONS (never violate; do not second-guess):',
      lockedDecisions,
      '',
      `TICKET ${t.id} — ${t.title}`,
      'CONTEXT:',
      t.context,
      '',
      'BASELINE (every ticket must pass this, regardless of what it touches):',
      baseline,
      '',
      "ACCEPTANCE (this ticket's own behavioral checks):",
      t.acceptance,
      '',
      'Do, in order: (1) build only this ticket; (2) add tests covering the new',
      'behavior (skip only for pure scaffold/config with nothing to test — say so);',
      '(3) run the BASELINE and the ACCEPTANCE; capture their real output.',
      '',
      'Return exactly one shape:',
      '- { done:true, branch:"<your worktree branch>", evidence } when baseline AND',
      '  acceptance pass (evidence = the captured output). Report your branch so it',
      '  can be independently re-verified.',
      '- { done:false, tooBig:true, proposedTickets:[...] } if this is bigger than one',
      '  focused session — propose a split and STOP. Do NOT leave a half-built change.',
      '- { done:false, blocked:true, reason } if a real dependency is missing or the spec contradicts itself.',
    ].join('\n'),
    { label: `build:${t.id}`, phase: 'Build', isolation: 'worktree', schema: BUILD_RESULT }
  ).then(result => ({ ticket: t, result }))
))

const done = built.filter(b => b.result && b.result.done)
const notDone = built.filter(b => !b.result || !b.result.done) // tooBig / blocked → bubble up to coordinator

// ── Verify ───────────────────────────────────────────────────────────────
// Independent re-verify per ticket: a DIFFERENT agent re-runs baseline +
// acceptance on the worker's branch. The builder's self-report does not count —
// this does. A ticket that regressed the baseline fails even if acceptance passes.
phase('Verify')
const verified = await parallel(done.map(b => () =>
  agent(
    [
      'You are an INDEPENDENT verifier. You did not build this — do not trust the',
      "builder's report. Check out the branch below in a fresh worktree, then re-run",
      'the baseline and the acceptance yourself and report what you observe.',
      'Fix NOTHING — you only measure.',
      '',
      `TICKET ${b.ticket.id} — ${b.ticket.title}`,
      `BRANCH: ${b.result.branch || '(discover via git worktree list / git branch — the worktree for this ticket)'}`,
      '',
      'BASELINE (must pass):',
      baseline,
      '',
      'ACCEPTANCE (must pass):',
      b.ticket.acceptance,
      '',
      'Return { verified, failing:[check → why], regressedBaseline, evidence:<captured output> }.',
      'verified=true only if BOTH baseline and acceptance pass on this branch.',
    ].join('\n'),
    { label: `verify:${b.ticket.id}`, phase: 'Verify', schema: VERIFY_RESULT }
  ).then(v => ({ ...b, verify: v }))
))

const passed = verified.filter(b => b.verify && b.verify.verified)
const verifyFailed = verified.filter(b => !b.verify || !b.verify.verified) // re-dispatch by coordinator

// ── Integrate ────────────────────────────────────────────────────────────
// Merge ONLY independently-verified branches. Workflow scripts have no shell;
// a single integrator agent does the merge on the working tree.
phase('Integrate')
const merge = passed.length === 0
  ? { merged: [], conflicts: [] }
  : await agent(
      [
        'Integrate the VERIFIED ticket branches into the current working branch.',
        `Verified tickets to merge: ${passed.map(b => b.ticket.id).join(', ')}`,
        `Branches: ${passed.map(b => b.result.branch).filter(Boolean).join(', ') || '(discover via git)'}`,
        'Merge them into the current branch one at a time, resolving only trivial/obvious',
        'conflicts. Do NOT invent code to resolve a non-trivial conflict — report it.',
        'Return { merged:[ids], conflicts:[{ticket, files, detail}] }.',
      ].join('\n'),
      { label: 'integrate', phase: 'Integrate', schema: MERGE_RESULT }
    )

// ── Gate ─────────────────────────────────────────────────────────────────
// The phase oracle on the MERGED tree — the coarsest, final gate. Per-worktree
// green does not count. This agent only runs checks and captures output.
phase('Gate')
const oracle = await agent(
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
  built: built.map(b => ({ id: b.ticket.id, result: b.result })),
  notDone: notDone.map(b => ({ id: b.ticket.id, result: b.result })),      // tooBig / blocked
  verifyFailed: verifyFailed.map(b => ({ id: b.ticket.id, verify: b.verify })), // built but failed independent re-verify
  merge,
  oracle,
}
