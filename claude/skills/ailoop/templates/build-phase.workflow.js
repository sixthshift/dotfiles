export const meta = {
  name: 'ailoop-build-phase',
  description: 'Build a file-disjoint batch of ailoop tickets in parallel worktrees, independently verify each (checks + scope + gaming read), integrate the verified ones, and gate on the phase oracle',
  phases: [
    { title: 'Build', detail: 'one worker per ticket in its own git worktree', model: 'sonnet' },
    { title: 'Verify', detail: 'independent agent re-runs baseline + acceptance, diffs for undeclared files, reads the diff for gaming' },
    { title: 'Integrate', detail: 'merge only the verified worker branches; manifest conflicts resolved mechanically' },
    { title: 'Gate', detail: 'run the phase oracle on the merged tree' },
  ],
}

// Invoked by the coordinator (SKILL.md Stage 2.2) ONLY for a file-disjoint batch
// of READY tickets (the scheduler's batches[0]). For a single ticket or a coupled
// phase, the coordinator dispatches one Agent directly (and re-verifies it
// itself) — no fan-out.
//
// args: {
//   tickets: [{ id, title, context, acceptance, files: [], attempts: [] }],  // file-DISJOINT, all ready
//   lockedDecisions: string,   // frozen decisions block from oracle.md, verbatim
//   baseline: string,          // the baseline gate: type-check/build/lint/full-test-suite commands
//   phaseOracle: string,       // the phase's executable checks from oracle.md
// }
const { tickets, lockedDecisions, baseline, phaseOracle } = args

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

const VERIFY_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verified: { type: 'boolean' },
    failing: { type: 'array', items: { type: 'string' }, description: 'check → why it failed (empty when verified)' },
    regressedBaseline: { type: 'boolean', description: 'true if the baseline broke even though acceptance may pass' },
    outOfScopeFiles: { type: 'array', items: { type: 'string' }, description: 'touched paths not in the declared files nor the manifest allowlist (empty when clean)' },
    suspectedGaming: { type: 'string', description: 'why the diff looks like it games the acceptance rather than implementing the intent; empty string if clean' },
    evidence: { type: 'string', description: 'captured baseline + acceptance output, verbatim' },
  },
  required: ['verified', 'failing', 'outOfScopeFiles', 'evidence'],
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
      `Touch ONLY the DECLARED FILES below — plus the manifest allowlist (${MANIFEST_ALLOWLIST})`,
      'if you must add a dependency. Any other file you touch will fail independent',
      'verification. Do not re-litigate the frozen decisions.',
      '',
      'FROZEN DECISIONS (never violate; do not second-guess):',
      lockedDecisions,
      '',
      `TICKET ${t.id} — ${t.title}`,
      `DECLARED FILES: ${(t.files ?? []).join(', ') || '(none declared)'}`,
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
    // Workers run Sonnet: the locked spec + ticket constrain them, and the
    // independent Verify stage catches what they get wrong. Gates never downgrade.
    { label: `build:${t.id}`, phase: 'Build', isolation: 'worktree', schema: BUILD_RESULT, model: 'sonnet' }
  ).then(result => ({ ticket: t, result }))
))

const done = built.filter(b => b.result && b.result.done)
const notDone = built.filter(b => !b.result || !b.result.done) // tooBig / blocked → bubble up to coordinator

// ── Verify ───────────────────────────────────────────────────────────────
// Independent re-verify per ticket: a DIFFERENT agent re-runs baseline +
// acceptance on the worker's branch, diffs it for undeclared touches, and reads
// the diff for gaming. The builder's self-report does not count — this does.
// Verify/Integrate/Gate inherit the session model (no `model` override): a cheap
// judge rubber-stamping cheap workers is the failure mode the split exists to avoid.
phase('Verify')
const checked = await parallel(done.map(b => () =>
  agent(
    [
      'You are an INDEPENDENT verifier. You did not build this — do not trust the',
      "builder's report. Check out the branch below in a fresh worktree, then:",
      '',
      '(1) RE-RUN the BASELINE and the ACCEPTANCE yourself; capture real output.',
      '    Exit codes decide pass/fail — not the builder\'s transcript.',
      '(2) SCOPE CHECK: `git diff --name-only <merge-base>..<branch>` (merge-base',
      '    against the branch it forked from). Every touched path must be in the',
      `    DECLARED FILES or the manifest allowlist (${MANIFEST_ALLOWLIST}).`,
      '    List every violation in outOfScopeFiles.',
      '(3) GAMING READ: read the diff. Was the acceptance satisfied by implementing',
      '    the intent, or by gaming the check — hardcoded outputs, weakened or',
      '    deleted tests, special-cased inputs? If suspicious, say exactly why in',
      '    suspectedGaming (empty string if clean).',
      '',
      'Fix NOTHING — you only measure.',
      '',
      `TICKET ${b.ticket.id} — ${b.ticket.title}`,
      `BRANCH: ${b.result.branch || '(discover via git worktree list / git branch — the worktree for this ticket)'}`,
      `DECLARED FILES: ${(b.ticket.files ?? []).join(', ') || '(none declared)'}`,
      '',
      'BASELINE (must pass):',
      baseline,
      '',
      'ACCEPTANCE (must pass):',
      b.ticket.acceptance,
      '',
      'Return { verified, failing:[check → why], regressedBaseline, outOfScopeFiles,',
      '         suspectedGaming, evidence:<captured output> }.',
      'verified=true ONLY if baseline AND acceptance pass AND outOfScopeFiles is empty.',
    ].join('\n'),
    { label: `verify:${b.ticket.id}`, phase: 'Verify', schema: VERIFY_RESULT }
  ).then(v => ({ ...b, verify: v }))
))

// Gaming suspicion does not auto-fail, but a suspect is held OUT of integration:
// the coordinator reads the diff and judges before it can merge (SKILL.md 2.3).
const passed = checked.filter(b => b.verify?.verified && !b.verify.suspectedGaming)
const suspected = checked.filter(b => b.verify?.verified && b.verify.suspectedGaming)
const verifyFailed = checked.filter(b => !b.verify || !b.verify.verified) // re-dispatch by coordinator

// ── Integrate ────────────────────────────────────────────────────────────
// Merge ONLY independently-verified, unsuspected branches. Workflow scripts have
// no shell; a single integrator agent does the merge on the working tree.
phase('Integrate')
const merge = passed.length === 0
  ? { merged: [], conflicts: [] }
  : await agent(
      [
        'Integrate the VERIFIED ticket branches into the current working branch.',
        `Verified tickets to merge: ${passed.map(b => b.ticket.id).join(', ')}`,
        `Branches: ${passed.map(b => b.result.branch).filter(Boolean).join(', ') || '(discover via git)'}`,
        'Merge them into the current branch one at a time.',
        'Manifest conflicts are mechanical: take the union of package.json additions',
        "and REGENERATE the lockfile with the project's install command — never",
        'hand-merge a lockfile. Beyond that, resolve only trivial/obvious conflicts.',
        'Do NOT invent code to resolve a non-trivial conflict — report it.',
        'Return { merged:[ids], conflicts:[{ticket, files, detail}] }.',
      ].join('\n'),
      { label: 'integrate', phase: 'Integrate', schema: MERGE_RESULT }
    )

// ── Gate ─────────────────────────────────────────────────────────────────
// The phase oracle on the MERGED tree — the coarsest, final gate. Per-worktree
// green does not count. This agent only runs checks and captures output.
// If this comes back red after a clean merge, the coordinator bisects and
// spawns a repair ticket (SKILL.md 2.3) — the workflow does not improvise.
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
  notDone: notDone.map(b => ({ id: b.ticket.id, result: b.result })),          // tooBig / blocked
  verifyFailed: verifyFailed.map(b => ({ id: b.ticket.id, verify: b.verify })), // built but failed independent re-verify (incl. out-of-scope touches)
  suspectedGaming: suspected.map(b => ({ id: b.ticket.id, branch: b.result.branch, verify: b.verify })), // checks green but diff looks gamed — coordinator judges before these may merge
  merge,
  oracle,
}
