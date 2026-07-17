#!/usr/bin/env node
// ailoop scheduler — the deterministic half of the loop. The coordinator never
// computes readiness, batches, breaches, thrash, phase drain, or completion by
// eye; it runs this and judges only what the output MEANS. Dependency-free;
// Node >= 18.
// Usage: node .ailoop/run/schedule.mjs [path-to-backlog.json]
import { readFileSync, existsSync } from 'node:fs'

// Allowlisted for every ticket (dependency adds) and excluded from the
// disjointness key — integration resolves them mechanically (union
// package.json, regenerate lockfile), so they don't serialize batches.
const MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'bun.lock', 'bun.lockb',
  'yarn.lock', 'pnpm-lock.yaml',
])

// Statuses that will never become dispatchable again. 'done' satisfies
// dependents; 'decomposed' does NOT — its children do.
const TERMINAL = new Set(['done', 'decomposed'])

const path = process.argv[2] ?? '.ailoop/run/backlog.json'
const { tickets = [], caps = {}, resources = {} } = JSON.parse(readFileSync(path, 'utf8'))
const maxAttempts = caps.maxAttempts ?? 3
const thrashWindow = caps.thrash ?? 2

const byId = new Map()
const problems = []
for (const t of tickets) {
  if (byId.has(t.id)) problems.push(`duplicate ticket id ${t.id}`)
  byId.set(t.id, t)
}
for (const t of tickets) {
  for (const d of t.depends_on ?? []) {
    if (!byId.has(d)) { problems.push(`${t.id} depends on unknown ticket ${d}`); continue }
    // A decomposed parent never becomes done, so a live dependent pointing at
    // it is stranded until the edge is rewired to the parent's children.
    if (!TERMINAL.has(t.status) && byId.get(d).status === 'decomposed')
      problems.push(`${t.id} depends on decomposed ${d} — rewire the edge to ${d}'s children`)
  }
  // No declared files = unknown footprint: unbatchable (disjointness has no
  // key) and unverifiable (the scope check would fail every touch).
  if (!TERMINAL.has(t.status) && (t.files ?? []).length === 0)
    problems.push(`${t.id} declares no files — declare its footprint or decompose it`)
  // Resources are verify-time leases; an undeclared name would fail at verify —
  // after a full dispatch was already spent. Catch it here.
  for (const r of t.resources ?? [])
    if (!TERMINAL.has(t.status) && !resources[r])
      problems.push(`${t.id} declares unknown resource "${r}" — define it in the backlog's resources block`)
}
for (const [name, def] of Object.entries(resources))
  if ((def.pool ?? 1) > 1 && !def.provision)
    problems.push(`resource "${name}": pool > 1 without a provision command — every slot would be the same shared instance`)

// Declared paths absent from disk. Not automatically a problem — a ticket may
// legitimately CREATE files — but an edit-intended path that's missing is the
// guessed-home footprint miss that costs a dispatch. The coordinator confirms
// each one is an intentional create before dispatching (SKILL.md 2.1).
const missingFiles = {}
for (const t of tickets) {
  if (TERMINAL.has(t.status)) continue
  const missing = (t.files ?? []).filter(f => !existsSync(f))
  if (missing.length) missingFiles[t.id] = missing
}

const color = new Map() // 1 = on current DFS path, 2 = fully explored
const cycles = []
const visit = (id, stack) => {
  if (color.get(id) === 2) return
  if (color.get(id) === 1) {
    cycles.push([...stack.slice(stack.indexOf(id)), id].join(' -> '))
    return
  }
  color.set(id, 1)
  for (const d of byId.get(id)?.depends_on ?? [])
    if (byId.has(d)) visit(d, [...stack, id])
  color.set(id, 2)
}
for (const t of tickets) visit(t.id, [])

const isDone = id => byId.get(id)?.status === 'done'
const breached = t => (t.attempts?.length ?? 0) >= maxAttempts
// attempts[].failed is an array of check names (legacy freeform string
// tolerated as a set of one). Thrash = across the last `thrash` attempts the
// failing set never strictly shrank: the loop is grinding a wall, not
// converging — same escalation as an attempt-cap breach.
const failCount = a => Array.isArray(a.failed) ? a.failed.length : a.failed ? 1 : 0
const thrashed = t => {
  const tail = (t.attempts ?? []).slice(-thrashWindow)
  return tail.length >= thrashWindow &&
    tail.every((a, i) => i === 0 || failCount(a) >= failCount(tail[i - 1]))
}

// Breached/thrashed tickets are walls awaiting escalation — never
// dispatchable, so they are excluded from ready/batches (they still surface
// in capBreaches/thrashBreaches). Tickets with no declared files are already
// problems above and are likewise undispatchable.
const ready = tickets.filter(t =>
  t.status === 'todo' && !breached(t) && !thrashed(t) &&
  (t.files ?? []).length > 0 && (t.depends_on ?? []).every(isDone))

// Greedy file-disjoint grouping over the ready set, in backlog (dependency)
// order. batches[0] is the next fan-out candidate; later batches wait.
const keyFiles = t => (t.files ?? []).filter(f => !MANIFESTS.has(f.split('/').pop()))
const batches = []
for (const t of ready) {
  const mine = new Set(keyFiles(t))
  const slot = batches.find(b => !b.some(o => keyFiles(o).some(f => mine.has(f))))
  if (slot) slot.push(t)
  else batches.push([t])
}

// Per-phase drain state: a phase with no non-terminal tickets left is drained
// — its oracle is due (the coordinator checks the ledger for whether it ran).
const phases = {}
for (const t of tickets) {
  const p = t.phase ?? '(none)'
  phases[p] ??= { done: 0, remaining: 0 }
  if (t.status === 'done') phases[p].done++
  else if (!TERMINAL.has(t.status)) phases[p].remaining++
}

const count = s => tickets.filter(t => t.status === s).length
const counts = {
  total: tickets.length,
  done: count('done'),
  todo: count('todo'),
  inProgress: count('in-progress'),
  blocked: count('blocked'),
  decomposed: count('decomposed'),
}
console.log(JSON.stringify({
  counts,
  // Done means NOTHING live remains — blocked tickets block completion too.
  complete: counts.todo + counts.inProgress + counts.blocked === 0,
  problems,
  cycles,
  staleInProgress: tickets.filter(t => t.status === 'in-progress').map(t => t.id),
  capBreaches: tickets
    .filter(t => !TERMINAL.has(t.status) && breached(t))
    .map(t => t.id),
  thrashBreaches: tickets
    .filter(t => !TERMINAL.has(t.status) && !breached(t) && thrashed(t))
    .map(t => t.id),
  missingFiles,
  phases,
  phasesDrained: Object.keys(phases).filter(p => phases[p].remaining === 0),
  ready: ready.map(t => ({ id: t.id, title: t.title, files: t.files ?? [] })),
  batches: batches.map(b => b.map(t => t.id)),
}, null, 2))
