#!/usr/bin/env node
// ailoop mechanical verifier — the scriptable half of the independent
// re-verify. Exit codes and set arithmetic need no model: this script measures
// (checks, scope, dirty tree) and dumps the diff; the gaming read — the one
// judgment verification keeps — happens over that dump, elsewhere.
// Dependency-free; Node >= 18.
//
// Run from the repo root (the main tree, where .ailoop/ lives); --dir points
// at the branch's worktree.
//
// Usage:
//   node .ailoop/verify.mjs --ticket <id> --dir <worktree> --base <sha>
//     [--only <check name>]            # run just one named check
//     [--cmd "<command>" [--name <label>]]  # ad-hoc check instead of the backlog's
//     [--repeat N]                     # flake probe: run each check N times
//     [--backlog <path>] [--evidence-dir <path>] [--out <path>]
//
// Default mode runs the backlog's fastChecks + the ticket's acceptanceChecks.
// The flake discriminator (SKILL.md — Flaky checks) is this script in ad-hoc
// mode: --cmd "<single-file test command>" --repeat 5.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Same allowlist as schedule.mjs: any ticket may add a dependency.
const MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'bun.lock', 'bun.lockb',
  'yarn.lock', 'pnpm-lock.yaml',
])
// A hung check must not hang the loop; 30 min is beyond any sane fast-tier run.
const CHECK_TIMEOUT_MS = 30 * 60 * 1000

const argv = process.argv.slice(2)
const opt = flag => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
const ticketId = opt('--ticket'), dir = opt('--dir'), base = opt('--base')
const only = opt('--only'), adhoc = opt('--cmd')
const repeat = Number(opt('--repeat') ?? 1)
const backlogPath = opt('--backlog') ?? '.ailoop/backlog.json'
const evidenceDir = opt('--evidence-dir') ?? '.ailoop/evidence'
if (!ticketId || !dir || !base) {
  console.error('usage: node .ailoop/verify.mjs --ticket <id> --dir <worktree> --base <sha> [--only <check>] [--cmd "<command>" [--name <label>]] [--repeat N] [--backlog <path>] [--evidence-dir <path>] [--out <path>]')
  process.exit(2)
}
const out = opt('--out') ?? join(evidenceDir, `${ticketId}.txt`)

const backlog = JSON.parse(readFileSync(backlogPath, 'utf8'))
const ticket = (backlog.tickets ?? []).find(t => t.id === ticketId)
if (!ticket) { console.error(`unknown ticket ${ticketId} in ${backlogPath}`); process.exit(2) }

const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
if (git('rev-parse', 'HEAD').status !== 0) {
  console.error(`${dir} is not a git worktree`)
  process.exit(2)
}

// Only committed work can merge, so only committed work verifies: a check that
// passes on uncommitted changes proves nothing about the branch.
const dirty = git('status', '--porcelain').stdout.trim() !== ''

// Scope: every touched path must be declared on the ticket or be a manifest.
// This is what lets the parallelism scheduler trust `files`.
const touched = git('diff', '--name-only', `${base}..HEAD`).stdout.split('\n').filter(Boolean)
const declared = new Set(ticket.files ?? [])
const outOfScopeFiles = touched.filter(f => !declared.has(f) && !MANIFESTS.has(f.split('/').pop()))

// Dump the diff for the gaming read — verification's one remaining judgment.
mkdirSync(evidenceDir, { recursive: true })
const diffPath = join(evidenceDir, `${ticketId}-diff.patch`)
writeFileSync(diffPath, git('diff', `${base}..HEAD`).stdout)

// The check list: the run's fast tier + this ticket's acceptance, straight
// from the backlog — the same names the attempts log will carry.
const checks = adhoc
  ? [{ name: opt('--name') ?? adhoc, cmd: adhoc }]
  : [...(backlog.fastChecks ?? []), ...(ticket.acceptanceChecks ?? [])]
      .filter(c => !only || c.name === only)
if (checks.length === 0) {
  console.error(only ? `no check named "${only}"` : 'no checks: backlog has no fastChecks and ticket has no acceptanceChecks')
  process.exit(2)
}

// Run every check even after a failure — thrash detection compares complete
// failing SETS across attempts, so a truncated set corrupts the signal.
const failing = []
const transcript = []
for (const c of checks) {
  let fails = 0
  for (let run = 1; run <= repeat; run++) {
    const r = spawnSync(c.cmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS })
    const verdict = r.error?.code === 'ETIMEDOUT' ? 'timeout' : r.status === 0 ? 'pass' : `exit ${r.status}`
    if (verdict !== 'pass') fails++
    transcript.push(`### ${c.name}${repeat > 1 ? ` (run ${run}/${repeat})` : ''} — ${c.cmd} → ${verdict}\n${r.stdout ?? ''}${r.stderr ?? ''}`)
  }
  // The stable check NAME goes in failing — attempts[].failed compares these
  // sets across attempts; the why lives in the evidence file.
  if (fails > 0) failing.push(c.name)
  if (repeat > 1) transcript.push(`### ${c.name}: passed ${repeat - fails}/${repeat}`)
}

writeFileSync(out, [
  `ticket ${ticketId} · dir ${dir} · base ${base}`,
  `dirty: ${dirty}`,
  `touched: ${touched.join(', ') || '(none)'}`,
  `out of scope: ${outOfScopeFiles.join(', ') || '(none)'}`,
  '',
  ...transcript,
].join('\n'))

const verified = !dirty && failing.length === 0 && outOfScopeFiles.length === 0
console.log(JSON.stringify({
  ticket: ticketId, verified, dirty, failing, outOfScopeFiles, touched,
  evidence: out, diff: diffPath,
}, null, 2))
process.exit(verified ? 0 : 1)
