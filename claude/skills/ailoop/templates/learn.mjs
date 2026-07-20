#!/usr/bin/env node
// learn.mjs — the arithmetic half of the retrospective harvest. The coordinator
// decides WHAT generalizes into a durable learning (judgment); this script merges
// those proposals into .ailoop/learnings/ with evidence counts, staleness
// eviction, and a size cap — one right answer, so it is never eyeballed. Touches
// only the two KEYED-JSON facets (checks, flakes); the prose facets (sizing,
// gaming, landmines) can't be mechanically deduped and stay coordinator-authored.
//
// Runs at termination, BEFORE .ailoop/campaign/ is deleted; learnings/ is a sibling
// that survives. Dependency-free; Node >= 18.
//
// Usage:
//   node .ailoop/campaign/learn.mjs merge --in <harvest.json> --campaign <name>
//     [--dir .ailoop/learnings] [--evict 3] [--cap 30]
//
// <harvest.json> — coordinator-authored, grounded in THIS run's evidence:
//   { "checks": [ { name, cmd, tier, note?, retire? } ],   // ended green this run
//     "flakes": [ { test, cmd, mode, discriminator, retire? } ] }
// Keyed by `name` (checks) / `test` (flakes). Present this campaign → bump
// evidence + reset staleness + refresh mutable fields; absent → staleness++.
// evidence never decreases; retire:true flips status so intake's Prime skips it.
// Entries stale for --evict campaigns are dropped; each facet is capped at --cap
// (lowest evidence first). A learning that still matters keeps getting
// re-confirmed — that is this store's own observe loop.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = f => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };
if (argv[0] !== 'merge') {
  console.error('usage: node learn.mjs merge --in <harvest.json> --campaign <name> [--dir .ailoop/learnings] [--evict 3] [--cap 30]');
  process.exit(2);
}
const inPath = opt('--in'), campaign = opt('--campaign');
const dir = opt('--dir') ?? '.ailoop/learnings';
const EVICT = parseInt(opt('--evict') ?? '3', 10);
const CAP = parseInt(opt('--cap') ?? '30', 10);
if (!inPath || !campaign) { console.error('merge requires --in <harvest.json> and --campaign <name>'); process.exit(2); }

const now = new Date().toISOString();
const harvest = JSON.parse(readFileSync(inPath, 'utf8'));
mkdirSync(dir, { recursive: true });

// $doc is rewritten each merge so the committed store stays self-describing.
const DOC = {
  checks: 'Verified toolchain commands carried across campaigns. Intake Primes toolchain detection + the baseline from active entries, then RE-PROBES them (a prior is a hypothesis, not a fact). Keyed by name.',
  flakes: "Known flaky tests + discriminators. Intake Primes verify's quarantine set from quarantined entries; status flips to resolved when a run proves the test stable. Keyed by test.",
};

const load = name => {
  const p = join(dir, `${name}.json`);
  const o = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  return Array.isArray(o[name]) ? o[name] : [];
};
const save = (name, entries) =>
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ $doc: DOC[name], [name]: entries }, null, 2) + '\n');

const mergeFacet = (name, key, fields, activeStatus, retiredStatus) => {
  let entries = load(name);
  const index = new Map(entries.map(e => [e[key], e]));
  const seen = new Set();
  const counts = { added: 0, confirmed: 0, retired: 0, evicted: 0, capped: 0 };
  for (const item of harvest[name] ?? []) {
    if (!item[key]) { console.error(`skip ${name} entry missing "${key}": ${JSON.stringify(item)}`); continue; }
    seen.add(item[key]);
    const status = item.retire ? retiredStatus : activeStatus;
    const e = index.get(item[key]);
    if (e) {
      for (const f of fields) if (item[f] !== undefined) e[f] = item[f];
      e.evidence = (e.evidence ?? 1) + 1;
      e.stale = 0;
      e.status = status;
      e.last_confirmed = campaign;
      e.last_confirmed_at = now;
      if (item.retire) { e.retired_at = now; counts.retired++; } else counts.confirmed++;
    } else {
      const entry = { [key]: item[key] };
      for (const f of fields) if (item[f] !== undefined) entry[f] = item[f];
      entry.evidence = 1;
      entry.stale = 0;
      entry.status = status;
      entry.first_seen = campaign;
      entry.last_confirmed = campaign;
      entry.last_confirmed_at = now;
      if (item.retire) entry.retired_at = now;
      entries.push(entry);
      counts.added++;
    }
  }
  // age entries not re-confirmed this campaign; evict once past the window
  for (const e of entries) if (!seen.has(e[key])) e.stale = (e.stale ?? 0) + 1;
  const kept = entries.filter(e => (e.stale ?? 0) < EVICT);
  counts.evicted = entries.length - kept.length;
  // cap: keep the highest-evidence entries (ties: freshest first)
  if (kept.length > CAP) {
    kept.sort((a, b) => (b.evidence - a.evidence) || ((a.stale ?? 0) - (b.stale ?? 0)));
    counts.capped = kept.length - CAP;
    entries = kept.slice(0, CAP);
  } else entries = kept;
  save(name, entries);
  return counts;
};

const result = {
  campaign, dir,
  checks: mergeFacet('checks', 'name', ['cmd', 'tier', 'note'], 'active', 'retired'),
  flakes: mergeFacet('flakes', 'test', ['cmd', 'mode', 'discriminator'], 'quarantined', 'resolved'),
};
console.log(JSON.stringify(result, null, 2));
