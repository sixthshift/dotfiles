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
//   node .ailoop/verify.mjs --teardown-resources   # at termination: stop every
//     provisioned resource instance (runs each resource's teardown per slot)
//
// Default mode runs the backlog's fastChecks + the ticket's acceptanceChecks.
// The flake discriminator (SKILL.md — Flaky checks) is this script in ad-hoc
// mode: --cmd "<single-file test command>" --repeat 5.
//
// Shared verify resources (SKILL.md — Verification): a ticket whose checks
// mutate a shared external resource (a dev DB the suite resets, a queue)
// declares it (ticket.resources: ["db"]); the backlog's top-level `resources`
// block defines each name ({ pool, provision, teardown }). Before running any
// check — ad-hoc and flake probes included — this script leases one slot per
// declared resource, provisions it lazily (provision prints KEY=VAL lines;
// values may contain {dir}, substituted with the worktree under verification
// at injection time), injects that env into every check subprocess, and
// releases on exit. No provision command → pool of 1 with no env: the ambient
// shared instance, with leases serializing access mechanically.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Same allowlist as schedule.mjs: any ticket may add a dependency.
const MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'bun.lock', 'bun.lockb',
  'yarn.lock', 'pnpm-lock.yaml',
])
// A hung check must not hang the loop; 30 min is beyond any sane fast-tier run.
const CHECK_TIMEOUT_MS = 30 * 60 * 1000
// A full pool queues rather than collides; a wait this long means the pool is
// sized wrong or a holder hung — either way, surface it, don't spin forever.
const LEASE_TIMEOUT_MS = 30 * 60 * 1000
const LEASE_POLL_MS = 3000
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const argv = process.argv.slice(2)
const opt = flag => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
const ticketId = opt('--ticket'), dir = opt('--dir'), base = opt('--base')
const only = opt('--only'), adhoc = opt('--cmd')
const repeat = Number(opt('--repeat') ?? 1)
const backlogPath = opt('--backlog') ?? '.ailoop/backlog.json'
const evidenceDir = opt('--evidence-dir') ?? '.ailoop/evidence'
const resourcesDir = opt('--resources-dir') ?? '.ailoop/resources'

const backlog = JSON.parse(readFileSync(backlogPath, 'utf8'))
const resourceDefs = backlog.resources ?? {}

// Termination mode: stop every provisioned instance. A slot's .env file is the
// proof it was provisioned; a failed teardown keeps its .env so a retry still
// sees it — the directory is only removed once every teardown succeeded.
if (argv.includes('--teardown-resources')) {
  let failed = false
  for (const [name, def] of Object.entries(resourceDefs)) {
    const baseDir = join(resourcesDir, name)
    if (!existsSync(baseDir)) continue
    for (const f of readdirSync(baseDir)) {
      const slot = f.match(/^(\d+)\.env$/)?.[1]
      if (slot === undefined) continue
      if (!def.teardown) { console.log(`${name}#${slot}: no teardown command — left running`); continue }
      const r = spawnSync(`${def.teardown} ${slot}`, {
        shell: true, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS,
        env: { ...process.env, AILOOP_RESOURCE_SLOT: slot },
      })
      console.log(`${name}#${slot}: teardown → ${r.status === 0 ? 'ok' : `exit ${r.status}`}`)
      if (r.status !== 0) { failed = true; console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`) }
      else rmSync(join(baseDir, f), { force: true })
    }
  }
  if (!failed) rmSync(resourcesDir, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

if (!ticketId || !dir || !base) {
  console.error('usage: node .ailoop/verify.mjs --ticket <id> --dir <worktree> --base <sha> [--only <check>] [--cmd "<command>" [--name <label>]] [--repeat N] [--backlog <path>] [--evidence-dir <path>] [--out <path>] | --teardown-resources')
  process.exit(2)
}
const out = opt('--out') ?? join(evidenceDir, `${ticketId}.txt`)

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

// ── Shared resource leases ────────────────────────────────────────────────
// One slot per declared resource, acquired before any check runs. The lock is
// a mkdir (atomic) under .ailoop/resources/<name>/<slot>.lock holding the
// leaseholder's pid — a dead holder's lock is stolen, so a killed verify never
// wedges the pool. Slots provision lazily: first lease runs the provision
// command (from the repo root) and caches its KEY=VAL stdout as <slot>.env.
const leases = []
process.on('exit', () => { for (const l of leases) rmSync(l.lock, { recursive: true, force: true }) })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(2))

const acquireSlot = (name, def) => {
  const pool = def.pool ?? 1
  const baseDir = join(resourcesDir, name)
  mkdirSync(baseDir, { recursive: true })
  const deadline = Date.now() + LEASE_TIMEOUT_MS
  while (true) {
    for (let slot = 0; slot < pool; slot++) {
      const lock = join(baseDir, `${slot}.lock`)
      try { mkdirSync(lock) } catch {
        let holder
        try { holder = Number(readFileSync(join(lock, 'pid'), 'utf8')) } catch { continue } // mid-acquisition — held
        try { process.kill(holder, 0); continue } catch {} // holder alive — held
        try { rmSync(lock, { recursive: true, force: true }); mkdirSync(lock) } catch { continue } // lost the steal race
      }
      writeFileSync(join(lock, 'pid'), String(process.pid))
      return { name, def, slot, lock, baseDir }
    }
    if (Date.now() > deadline) {
      console.error(`resource ${name}: no free slot in ${LEASE_TIMEOUT_MS / 60000} min — pool too small, or a holder hung`)
      process.exit(2)
    }
    sleep(LEASE_POLL_MS)
  }
}

const provisionEnv = lease => {
  if (!lease.def.provision) return {}
  const envPath = join(lease.baseDir, `${lease.slot}.env`)
  if (!existsSync(envPath)) {
    const r = spawnSync(`${lease.def.provision} ${lease.slot}`, {
      shell: true, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS,
      env: { ...process.env, AILOOP_RESOURCE_SLOT: String(lease.slot) },
    })
    if (r.status !== 0) {
      console.error(`resource ${lease.name}: provision failed for slot ${lease.slot}\n${r.stdout ?? ''}${r.stderr ?? ''}`)
      process.exit(2)
    }
    // Only KEY=VAL lines are the contract; progress chatter on stdout is ignored.
    writeFileSync(envPath, (r.stdout ?? '').split('\n').filter(l => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).join('\n'))
  }
  return Object.fromEntries(readFileSync(envPath, 'utf8').split('\n').filter(Boolean)
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)] }))
}

const leaseEnv = {}
for (const name of [...(ticket.resources ?? [])].sort()) { // sorted: two multi-resource tickets can't deadlock
  const def = resourceDefs[name]
  if (!def) { console.error(`ticket ${ticketId} declares unknown resource "${name}" — define it in ${backlogPath}'s resources block`); process.exit(2) }
  if ((def.pool ?? 1) > 1 && !def.provision) { console.error(`resource ${name}: pool > 1 without a provision command — every slot would be the same shared instance`); process.exit(2) }
  const lease = acquireSlot(name, def)
  leases.push(lease)
  Object.assign(leaseEnv, provisionEnv(lease))
}
// {dir} in an env value resolves to the tree under verification — this is how
// a pooled instance reads config/migrations from the branch being verified.
const checkEnv = { ...process.env, ...Object.fromEntries(Object.entries(leaseEnv).map(([k, v]) => [k, v.replaceAll('{dir}', dir)])) }

// Run every check even after a failure — thrash detection compares complete
// failing SETS across attempts, so a truncated set corrupts the signal.
const failing = []
const transcript = []
for (const c of checks) {
  let fails = 0
  for (let run = 1; run <= repeat; run++) {
    const r = spawnSync(c.cmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, env: checkEnv })
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
  `resources: ${leases.map(l => `${l.name}#${l.slot}`).join(', ') || '(none)'}`,
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
