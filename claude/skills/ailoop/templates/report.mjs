#!/usr/bin/env node
// ailoop run audit — the operational half of the termination report. schedule.mjs
// answers "where IS the loop?"; this answers "where did the TIME go?" It reads the
// ledger's timestamped entry headers (the loop's only timing record) plus
// backlog.json, and emits a scannable audit: wall-clock by phase, the long poles,
// the work breakdown. Pure arithmetic over recorded stamps — never an estimate:
// an unstamped or unparseable entry is reported as an unmeasured gap, never a
// guessed number (fictional numbers in the audit trail are worse than none — the
// same reason this skill refuses token budgeting). Runnable any time, not just at
// termination. Dependency-free; Node >= 18.
// Usage: node .ailoop/report.mjs [path-to-ledger.md] [path-to-backlog.json]
import { readFileSync, existsSync } from 'node:fs'

const ledgerPath = process.argv[2] ?? '.ailoop/ledger.md'
const backlogPath = process.argv[3] ?? '.ailoop/backlog.json'

// Entry header shape: [<seq> | <isoTs> | <kind> | <subject>] <human event text>
// Only the four machine fields are read here; the prose body below each header
// (decision / why / evidence) is for the human reader and is ignored. subject is
// a ticket id, a phase id, a comma-joined batch, or `run`.
const HEADER = /^\[\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^\]]+?)\s*\]/

const lines = readFileSync(ledgerPath, 'utf8').split('\n')
const events = []
let unstamped = 0
for (const line of lines) {
  const m = HEADER.exec(line)
  if (!m) continue
  const ts = Date.parse(m[2])
  if (Number.isNaN(ts)) { unstamped++; continue }
  events.push({ seq: Number(m[1]), ts, kind: m[3].trim(), subject: m[4].trim() })
}
events.sort((a, b) => a.ts - b.ts)

// backlog: ticket -> phase (to label long poles) and final status tally (the end
// state corroborates the ledger's event counts).
const phaseOf = new Map()
const statusCounts = {}
if (existsSync(backlogPath)) {
  const { tickets = [] } = JSON.parse(readFileSync(backlogPath, 'utf8'))
  for (const t of tickets) {
    phaseOf.set(t.id, t.phase ?? '(none)')
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1
  }
}

// A pause is the span between an escalate (loop hit a wall, handed back to the
// human) and the next resume. Real elapsed time, but not loop work — subtract it
// so "active" isn't inflated by a night spent awaiting a decision. An escalate
// with no following resume is an open pause and is left out entirely.
const pauses = []
for (let i = 0; i < events.length; i++) {
  if (events[i].kind !== 'escalate') continue
  const resume = events.slice(i + 1).find(e => e.kind === 'resume')
  if (resume) pauses.push([events[i].ts, resume.ts])
}
const pausedMs = pauses.reduce((s, [a, b]) => s + (b - a), 0)
const pausedWithin = (a, b) => pauses.reduce(
  (s, [pa, pb]) => s + Math.max(0, Math.min(b, pb) - Math.max(a, pa)), 0)

const t0 = events.length ? events[0].ts : NaN
const tN = events.length ? events[events.length - 1].ts : NaN
const total = tN - t0

// Time by phase: segment the timeline at phase-close stamps. Phases run largely
// in dependency order, so wall-clock between one close and the next is that
// phase's cost — including the coordinator's own judging, which is exactly what
// "where did the hours go" wants. Active = wall minus any pause inside the window.
const closes = events.filter(e => e.kind === 'phase-close')
const phaseRows = []
let cursor = t0
for (const c of closes) {
  phaseRows.push({ phase: c.subject, wall: c.ts - cursor, active: (c.ts - cursor) - pausedWithin(cursor, c.ts) })
  cursor = c.ts
}
if (!Number.isNaN(tN) && tN > cursor) {
  phaseRows.push({ phase: '(wrap-up)', wall: tN - cursor, active: (tN - cursor) - pausedWithin(cursor, tN) })
}

// Long poles: the largest ACTIVE gaps between consecutive stamped entries. A slow
// batch shows up as the gap between its dispatch and its judge — so the biggest
// gaps are the slowest single stretches of the run, labeled by the entry that
// opened them. This is the optimization signal.
const gaps = []
for (let i = 1; i < events.length; i++) {
  const a = events[i - 1], b = events[i]
  gaps.push({ after: a, span: (b.ts - a.ts) - pausedWithin(a.ts, b.ts) })
}
gaps.sort((x, y) => y.span - x.span)

const kindCounts = {}
for (const e of events) kindCounts[e.kind] = (kindCounts[e.kind] ?? 0) + 1
const n = k => kindCounts[k] ?? 0

const fmt = ms => {
  if (Number.isNaN(ms) || ms < 0) return '—'
  const m = Math.round(ms / 60000)
  const h = Math.floor(m / 60)
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const out = ['## Run audit', '']
if (!events.length) {
  out.push('_No timestamped ledger entries found — wall-clock cannot be reconstructed ' +
    '(this run predates timing capture, or entries were written without the machine header). ' +
    'Reporting end state from backlog only._', '')
  out.push('### End state (from backlog)')
  out.push(Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`).join(' · ') || '(no backlog found)')
} else {
  out.push(`- **Wall-clock:** ${fmt(total)} total` + (pausedMs
    ? ` — ${fmt(total - pausedMs)} active, ${fmt(pausedMs)} paused across ${pauses.length} escalation${pauses.length > 1 ? 's' : ''}`
    : ' (no escalation pauses)'))

  if (phaseRows.length) {
    out.push('', '### Time by phase', '| phase | active | wall |', '|---|---|---|')
    for (const r of phaseRows) out.push(`| ${r.phase} | ${fmt(r.active)} | ${fmt(r.wall)} |`)
  }

  out.push('', '### Long poles (largest active gaps)')
  for (const g of gaps.slice(0, 5)) {
    const ph = phaseOf.get(g.after.subject)
    out.push(`- ${fmt(g.span)} — after [${String(g.after.seq).padStart(4, '0')}] ${g.after.kind} ${g.after.subject}${ph ? ` (${ph})` : ''}`)
  }

  out.push('', '### Work breakdown',
    `- dispatches ${n('dispatch')} · accepts ${n('accept')} · retries ${n('retry')} · ` +
    `decompositions ${n('decompose')} · escalations ${n('escalate')} · flakes ${n('flake')} · amendments ${n('amend')}`,
    `- tickets (end state): ${Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`).join(' · ') || '—'}`)

  out.push('', `_Timing from ${events.length} stamped entries${unstamped ? `; ${unstamped} unstamped/unparseable and left as unmeasured gaps` : ''}._`)
}
console.log(out.join('\n'))
