export const meta = {
  name: 'ailoop-build-phase',
  description: 'Build a file-disjoint batch of ailoop tickets in parallel worktrees, integrate, and gate on the phase oracle',
  phases: [
    { title: 'Build', detail: 'one worker per ticket in its own git worktree' },
    { title: 'Integrate', detail: 'merge completed worker branches, report conflicts' },
    { title: 'Gate', detail: 'run the phase oracle on the merged tree' },
  ],
}

// Invoked by the coordinator (SKILL.md Stage 2.2) ONLY for a file-disjoint batch
// of READY tickets. For a single ticket or a coupled phase, the coordinator
// dispatches one Agent directly — no fan-out, no merge — and skips this workflow.
//
// args: {
//   tickets: [{ id, title, context, acceptance, files: [] }],  // file-DISJOINT, all ready
//   lockedDecisions: string,   // frozen decisions block from oracle.md, verbatim
//   phaseOracle: string,       // the phase's executable checks from oracle.md
// }
const { tickets, lockedDecisions, phaseOracle } = args

// Every worker returns exactly one of these shapes — no half-built states.
const BUILD_RESULT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    done: { type: 'boolean' },
    evidence: { type: 'string', description: 'acceptance-check output the worker ran; required when done' },
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
// cannot collide. Workers verify their OWN acceptance before returning done.
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
      'ACCEPTANCE (run these yourself; capture the real output):',
      t.acceptance,
      '',
      'Return exactly one shape:',
      '- { done:true, evidence } when acceptance passes (evidence = the output you ran).',
      '- { done:false, tooBig:true, proposedTickets:[...] } if this is bigger than one focused',
      '  session — propose a split and STOP. Do NOT leave a half-built change.',
      '- { done:false, blocked:true, reason } if a real dependency is missing or the spec contradicts itself.',
    ].join('\n'),
    { label: `build:${t.id}`, phase: 'Build', isolation: 'worktree', schema: BUILD_RESULT }
  ).then(result => ({ ticket: t, result }))
))

const done = built.filter(b => b.result && b.result.done)
const notDone = built.filter(b => !b.result || !b.result.done)

// ── Integrate ────────────────────────────────────────────────────────────
// Workflow scripts have no shell/git; a single integrator agent does the merge
// on the working tree. tooBig/blocked workers are NOT integrated — they bubble
// up to the coordinator to decompose or unblock.
phase('Integrate')
const merge = done.length === 0
  ? { merged: [], conflicts: [] }
  : await agent(
      [
        'Integrate the COMPLETED ticket worktrees into the current working branch.',
        `Completed tickets to merge: ${done.map(d => d.ticket.id).join(', ')}`,
        'Use git to locate each worker branch/worktree (`git worktree list`, `git branch`),',
        'merge them into the current branch one at a time in the given order, and resolve',
        'only trivial/obvious conflicts. Do NOT invent code to resolve a non-trivial conflict —',
        'report it instead.',
        'Return { merged:[ids], conflicts:[{ticket, files, detail}] }.',
      ].join('\n'),
      { label: 'integrate', phase: 'Integrate', schema: MERGE_RESULT }
    )

// ── Gate ─────────────────────────────────────────────────────────────────
// The phase oracle on the MERGED tree. Per-worktree green does not count.
// This agent only runs checks and captures output — it fixes nothing.
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
  notDone: notDone.map(b => ({ id: b.ticket.id, result: b.result })),
  merge,
  oracle,
}
