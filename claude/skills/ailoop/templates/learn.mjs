#!/usr/bin/env node
// ailoop cross-campaign learning merge — the arithmetic half of harvest. The
// coordinator decides WHAT generalizes into a durable learning (judgment); this
// script merges those proposals into .ailoop/learnings/ with keyed dedup,
// provenance stamping, and retirement — one right answer, so it is never
// eyeballed (Prime directive 6). Prose facets (sizing/patterns/landmines) can't
// be mechanically deduped and stay coordinator-authored; this touches only the
// two keyed JSON facets: checks and flakes.
//
// Harvest runs at termination BEFORE .ailoop/run/ is deleted; .ailoop/learnings/
// is its sibling and survives (SKILL.md — Durable state; references/termination.md).
// Dependency-free; Node >= 18.
//
// Usage:
//   node .ailoop/run/learn.mjs merge --in <harvest.json> --campaign <name>
//     [--dir .ailoop/learnings]
//
// <harvest.json> — coordinator-authored, staged under run/, grounded in THIS
// run's evidence (a hunch is not a learning):
//   { "checks": [ { name, cmd, tier, note? } ],       // ended green this run
//     "flakes": [ { test, cmd, mode, discriminator,   // quarantine still open
//                   retire? } ] }                      // retire:true when the run
//                                                      // proved it stable
// A check is keyed by `name`, a flake by `test`. Present → upsert the mutable
// fields + bump last_confirmed. retire:true → status flips to retired/resolved
// (kept for history, filtered out by intake's Prime). Nothing is ever deleted —
// the store is append-mostly, like the backlog.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = f => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1] }

if (argv[0] !== 'merge') {
  console.error('usage: node .ailoop/run/learn.mjs merge --in <harvest.json> --campaign <name> [--dir .ailoop/learnings]')
  process.exit(2)
}
const inPath = opt('--in'), campaign = opt('--campaign')
const dir = opt('--dir') ?? '.ailoop/learnings'
if (!inPath || !campaign) {
  console.error('merge requires --in <harvest.json> and --campaign <name>')
  process.exit(2)
}

const now = new Date().toISOString()
const harvest = JSON.parse(readFileSync(inPath, 'utf8'))
mkdirSync(dir, { recursive: true })

// The $doc header is rewritten on every merge so the format stays self-describing
// even as the store is committed and read by hand between campaigns.
const DOC = {
  checks: [
    "Verified toolchain commands carried across campaigns. Intake's Prime seeds",
    "toolchain detection and the baseline gate from the `active` entries, then",
    "RE-PROBES them — a prior is a hypothesis, not a fact. Keyed by `name`.",
  ],
  flakes: [
    "Known flaky tests + their discriminators. Intake's Prime seeds oracle.md's",
    "quarantine from the `quarantined` entries so verify applies them from turn",
    "one; status flips to `resolved` when a run proves the test stable. Keyed by `test`.",
  ],
}

const load = name => {
  const p = join(dir, `${name}.json`)
  const o = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  o[name] ??= []
  o.$doc = DOC[name]
  return o
}
// $doc first so the committed file reads top-down like backlog.json.
const save = (name, o) => writeFileSync(join(dir, `${name}.json`), JSON.stringify({ $doc: o.$doc, [name]: o[name] }, null, 2) + '\n')

const mergeFacet = (name, key, incoming, fields, retiredStatus, activeStatus) => {
  const store = load(name)
  const index = new Map(store[name].map(e => [e[key], e]))
  const counts = { added: 0, updated: 0, retired: 0 }
  for (const item of incoming ?? []) {
    if (!item[key]) { console.error(`skip ${name} entry missing "${key}": ${JSON.stringify(item)}`); continue }
    const status = item.retire ? retiredStatus : activeStatus
    const existing = index.get(item[key])
    if (existing) {
      for (const f of fields) if (item[f] !== undefined) existing[f] = item[f]
      existing.status = status
      existing.last_confirmed = campaign
      existing.last_confirmed_at = now
      if (item.retire) { existing.retired_at = now; counts.retired++ } else counts.updated++
    } else {
      const entry = { [key]: item[key] }
      for (const f of fields) if (item[f] !== undefined) entry[f] = item[f]
      entry.status = status
      entry.first_seen = campaign
      entry.last_confirmed = campaign
      entry.last_confirmed_at = now
      if (item.retire) entry.retired_at = now
      store[name].push(entry)
      counts.added++
    }
  }
  save(name, store)
  return counts
}

const checks = mergeFacet('checks', 'name', harvest.checks, ['cmd', 'tier', 'note'], 'retired', 'active')
const flakes = mergeFacet('flakes', 'test', harvest.flakes, ['cmd', 'mode', 'discriminator'], 'resolved', 'quarantined')

console.log(JSON.stringify({ campaign, dir, checks, flakes }, null, 2))
