#!/usr/bin/env node
// ailoop run audit + per-ticket dossier — the termination report. schedule.mjs
// answers "where IS the loop?"; this answers "where did the TIME go, and what
// happened inside each ticket?" Two sources, both durable through the run and
// gone only at close (so this must run BEFORE .ailoop/run/ is deleted, writing to a
// path OUTSIDE it — see SKILL.md Termination):
//   1. ledger.md  — the timestamped entry headers (wall-clock, phases, work mix).
//   2. evidence/<id>.*.json — per-ticket sidecars captured AT ACCEPT (timing,
//      cost, verify, findings, …), because the transcripts they derive from are
//      ephemeral and reap mid-run. report.mjs never reads a transcript itself.
// Pure arithmetic / merge over recorded data — never an estimate. Runnable any
// time. Dependency-free; Node >= 18.
//
// Usage:
//   node .ailoop/run/report.mjs [--ledger <p>] [--backlog <p>] [--evidence <dir>] [--out <file>]
//     --out  write the full report to <file> (e.g. specs/<spec>.run-report.md)
//            AND still print it; omit to only print.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const argv = process.argv.slice(2)
const flag = f => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1] }
// Back-compat: first two bare args are still [ledger] [backlog].
const bare = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'))
const ledgerPath = flag('--ledger') ?? bare[0] ?? '.ailoop/run/ledger.md'
const backlogPath = flag('--backlog') ?? bare[1] ?? '.ailoop/run/backlog.json'
const evidenceDir = flag('--evidence') ?? '.ailoop/run/evidence'
const outPath = flag('--out')

const HEADER = /^\[\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^\]]+?)\s*\]/

const lines = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n') : []
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

let tickets = []
const phaseOf = new Map()
const statusCounts = {}
if (existsSync(backlogPath)) {
  ;({ tickets = [] } = JSON.parse(readFileSync(backlogPath, 'utf8')))
  for (const t of tickets) {
    phaseOf.set(t.id, t.phase ?? '(none)')
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1
  }
}

// A pause is the span between an escalate (loop hit a wall, handed back to the
// human) and the next resume — real elapsed time, but not loop work, so subtract
// it from "active". An escalate with no resume is an open pause, left out.
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
  if (ms == null || Number.isNaN(ms) || ms < 0) return '—'
  const m = Math.round(ms / 60000)
  const h = Math.floor(m / 60)
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}
const fmtShort = ms => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const tok = t => (t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : String(t))

// ── Per-ticket dossier: glob evidence/<id>.*.json and merge ──────────────────
// The naming is a contract, not a schema lock: a facet is `<id>.<kind>.json`, and
// report globs `<id>.*.json` and merges whatever it finds. Add a new facet later
// by dropping a new file kind — no change here. Known kinds get a tuned line;
// unknown kinds are dumped compact so nothing is silently lost.
const sidecarsFor = (id) => {
  if (!existsSync(evidenceDir)) return {}
  const out = {}
  for (const f of readdirSync(evidenceDir)) {
    if (!f.startsWith(`${id}.`) || !f.endsWith('.json')) continue
    const kind = f.slice(id.length + 1, -'.json'.length)
    try { out[kind] = JSON.parse(readFileSync(join(evidenceDir, f), 'utf8')) } catch { /* skip unreadable */ }
  }
  return out
}
const renderFacet = (kind, v) => {
  if (kind === 'timing' && v && typeof v === 'object') {
    const acts = Object.entries(v.activities ?? {}).sort((a, b) => b[1] - a[1])
      .slice(0, 4).map(([k, ms]) => `${k} ${fmtShort(ms)}`).join(' · ')
    return `- timing: ${fmtShort(v.wall_ms ?? 0)} wall${acts ? ` — ${acts}` : ''}${v.tool_calls ? ` · ${v.tool_calls} tool calls` : ''}`
  }
  if (kind === 'cost' && v && typeof v === 'object') {
    const bits = []
    if (v.tokens != null) bits.push(`~${tok(v.tokens)} tokens`)
    if (v.agents != null) bits.push(`${v.agents} agent${v.agents === 1 ? '' : 's'}`)
    if (v.dispatches != null) bits.push(`${v.dispatches} dispatch${v.dispatches === 1 ? '' : 'es'}`)
    return `- cost: ${bits.join(' · ') || '(empty)'}`
  }
  if (kind === 'findings' && v && typeof v === 'object') {
    const rows = []
    if (v.worker) rows.push(`- findings (worker): ${v.worker}`)
    if (v.rationale) rows.push(`- rationale: ${v.rationale}`)
    for (const a of v.amendments ?? []) rows.push(`- amendment: ${a}`)
    for (const b of v.escaped_bugs ?? []) rows.push(`- escaped bug: ${b}`)
    return rows.join('\n') || '- findings: (empty)'
  }
  if (kind === 'verify' && v && typeof v === 'object') {
    const bits = []
    if (v.verdict) bits.push(v.verdict)
    if (v.gaming) bits.push(`gaming: ${v.gaming}`)
    if (v.scope) bits.push(`scope: ${v.scope}`)
    if (v.flakes) bits.push(`flakes: ${v.flakes}`)
    return `- verify: ${bits.join(' · ') || JSON.stringify(v)}`
  }
  // Unknown kind — dump compact so it is never silently dropped.
  const s = JSON.stringify(v)
  return `- ${kind}: ${s.length > 200 ? s.slice(0, 200) + '…' : s}`
}

const out = ['## Run audit', '']
if (!events.length) {
  out.push('_No timestamped ledger entries found — wall-clock cannot be reconstructed ' +
    '(this run predates timing capture, or entries lack the machine header). ' +
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

// Dossier — the per-ticket "inside the black box", from the sidecars.
const dossier = []
for (const t of tickets) {
  const sc = sidecarsFor(t.id)
  const kinds = Object.keys(sc)
  if (kinds.length === 0) continue
  dossier.push('', `#### ${t.id} — ${t.title ?? ''} (${t.status})${t.phase ? ` · ${t.phase}` : ''}`)
  const orderK = ['timing', 'cost', 'verify', 'findings']
  for (const k of [...orderK.filter(k => k in sc), ...kinds.filter(k => !orderK.includes(k))]) {
    dossier.push(renderFacet(k, sc[k]))
  }
}
if (dossier.length) {
  out.push('', '## Per-ticket dossier',
    '<!-- from evidence/<id>.*.json sidecars captured at accept-time -->', ...dossier)
} else if (tickets.length) {
  out.push('', '## Per-ticket dossier', '',
    '_No per-ticket sidecars found (evidence/<id>.*.json). This run predates ' +
    'accept-time capture, or none were written._')
}

const report = out.join('\n')
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, report + '\n')
  console.error(`wrote ${outPath}`)
}
console.log(report)
