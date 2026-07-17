#!/usr/bin/env node
// ailoop per-ticket timing capture — parses a fresh subagent transcript into the
// activity split (deps / implementation / tests / reasoning / …) and writes a
// `<id>.timing.json` sidecar. This exists because transcripts are EPHEMERAL: the
// harness reaps them on its own clock, often mid-run, long before termination —
// so the split can only be captured AT ACCEPT, while the transcript is still on
// disk (SKILL.md 2.3). report.mjs then reads the sidecar, never the transcript.
// Dependency-free; Node >= 18.
//
// Usage:
//   node .ailoop/run/timing.mjs --ticket <id> [--out <path>] <transcript> [<transcript> ...]
//     <transcript>  one or more JSONL paths (a ticket may span build + verify +
//                   gaming + a resume — pass them all; they aggregate).
//     --out         default .ailoop/run/evidence/<id>.timing.json
//
// Attribution: each transcript event is charged the time delta to the next event.
// A Bash tool_use → its command category; an Edit/Write → implementation; a model
// turn (thinking/generation, incl. producing edit content) → reasoning. So
// "reasoning" is the model working, not idle; edits read near-0 because the write
// is instant once generated.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const opt = f => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1] }
const ticket = opt('--ticket')
const files = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--ticket' && argv[i - 1] !== '--out')
if (!ticket || files.length === 0) {
  console.error('usage: node .ailoop/run/timing.mjs --ticket <id> [--out <path>] <transcript.jsonl> [<transcript.jsonl> ...]')
  process.exit(2)
}
const out = opt('--out') ?? join('.ailoop/run/evidence', `${ticket}.timing.json`)

const classifyBash = (cmd) => {
  const c = (cmd ?? '').toLowerCase()
  if (/\bbun install\b|playwright install/.test(c)) return 'deps_install'
  if (/verify\.mjs/.test(c)) return 'verify'
  if (/run typecheck|\btsc\b/.test(c)) return 'typecheck'
  if (/test:e2e|playwright test/.test(c)) return 'e2e_test'
  if (/test:seam|test:schema|test:rls|test:integration/.test(c)) return 'integration_test'
  if (/run --filter.*\btest\b|run test\b|\bvitest\b/.test(c)) return 'unit_test'
  if (/run build|vite build/.test(c)) return 'build'
  if (/supabase |db:reset|db reset|db:up|status -o env/.test(c)) return 'db'
  if (/(^|[^a-z])git /.test(c)) return 'git'
  if (/curl|psql/.test(c)) return 'probe'
  if (/grep|(^| )ls |(^| )cat |find |head|tail|sed|awk|echo|node -e|wc /.test(c)) return 'exploration'
  return 'shell_other'
}
const classify = (name, input) => {
  if (name === 'Bash') return classifyBash(input?.command)
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'implementation'
  if (['Read', 'Grep', 'Glob'].includes(name)) return 'exploration'
  return 'reasoning'
}

const activities = {}
let wall_ms = 0, tool_calls = 0, nEvents = 0
let firstTs = Infinity, lastTs = 0

for (const file of files) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (e) {
    console.error(`skip ${file}: ${e.message}`); continue
  }
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o; try { o = JSON.parse(line) } catch { continue }
    if (!o.timestamp) continue
    const t = Date.parse(o.timestamp)
    if (Number.isNaN(t)) continue
    let action = 'reasoning'
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      const tu = o.message.content.find(c => c.type === 'tool_use')
      if (tu) { action = classify(tu.name, tu.input); tool_calls++ }
    }
    events.push({ t, action })
  }
  events.sort((a, b) => a.t - b.t)
  nEvents += events.length
  if (events.length) { firstTs = Math.min(firstTs, events[0].t); lastTs = Math.max(lastTs, events.at(-1).t) }
  for (let i = 0; i < events.length - 1; i++) {
    const dt = events[i + 1].t - events[i].t
    if (dt <= 0) continue
    activities[events[i].action] = (activities[events[i].action] ?? 0) + dt
    wall_ms += dt
  }
}
// wall = union span across the passed transcripts (a resume in the same file, or
// build+verify run back-to-back). Per-file gaps are already summed into wall_ms;
// the span is the honest outer bound.
const span_ms = lastTs > firstTs ? lastTs - firstTs : wall_ms

mkdirSync(dirname(out), { recursive: true })
const record = {
  ticket,
  wall_ms: span_ms,
  attributed_ms: wall_ms,
  tool_calls,
  events: nEvents,
  transcripts: files.length,
  activities, // ms per category — dominant one is usually `reasoning`
  captured_at: new Date().toISOString(),
}
writeFileSync(out, JSON.stringify(record, null, 2))
console.log(JSON.stringify({ wrote: out, ...record }, null, 2))
