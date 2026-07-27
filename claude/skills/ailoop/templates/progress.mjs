#!/usr/bin/env node
// progress.mjs — live human view of the campaign. Zero tokens, read-only.
// Usage: node progress.mjs [--dir .ailoop/campaign] [--watch]

import fs from 'node:fs';
import path from 'node:path';

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1] === undefined || argv[i + 1]?.startsWith('--') ? true : argv[++i]; }
const DIR = typeof opts.dir === 'string' ? opts.dir : '.ailoop/campaign';
const BACKLOG = path.join(DIR, 'backlog.json');

const GLYPH = { draft: '·', vetted: '○', 'in-flight': '◐', closed: '●', blocked: '✕', decomposed: '▽', parked: '■' };

function render() {
  const b = JSON.parse(fs.readFileSync(BACKLOG, 'utf8'));
  const lines = [];
  lines.push(`\n${b.project} — ${new Date().toLocaleTimeString()}`);
  const counts = b.tickets.reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {});
  lines.push(Object.entries(GLYPH).map(([s, g]) => `${g} ${s}:${counts[s] || 0}`).join('  '));
  // Two counts, because they answer different questions and can disagree: a
  // campaign can be 8/8 tickets closed with a spec clause no ticket ever claimed.
  const reqs = b.requirements || [];
  if (reqs.length) {
    // Same join frontier.mjs prints, so the two views can never disagree: a
    // clause is proven only when EVERY ticket claiming it closed.
    const claimants = new Map(reqs.map(r => [r.id, []]));
    for (const t of b.tickets) {
      if (t.status === 'decomposed') continue;
      for (const r of t.satisfies || []) claimants.get(r)?.push(t);
    }
    const unmapped = [...claimants].filter(([, ts]) => !ts.length).map(([id]) => id);
    const proven = [...claimants].filter(([, ts]) => ts.length && ts.every(t => t.status === 'closed'));
    lines.push(`spec  ${proven.length}/${reqs.length} clauses closed${unmapped.length ? `  ⚠ unclaimed: ${unmapped.join(', ')}` : ''}`);
  }
  lines.push('─'.repeat(72));
  const phases = [...new Set(b.tickets.map(t => t.phase))];
  for (const p of phases) {
    const ts = b.tickets.filter(t => t.phase === p);
    const done = ts.filter(t => t.status === 'closed').length;
    const liveN = ts.filter(t => !['closed', 'decomposed'].includes(t.status)).length;
    lines.push(`${p}  [${done}/${done + liveN} closed]${liveN === 0 && ts.length ? '  ← DRAINED' : ''}`);
    for (const t of ts) {
      const att = (t.attempts || []).length ? ` (a${t.attempts.length})` : '';
      const deps = (t.depends_on || []).length ? `  ⇐ ${t.depends_on.join(',')}` : '';
      lines.push(`  ${GLYPH[t.status] || '?'} ${t.id} ${t.title}${att}${deps}`);
    }
  }
  const out = lines.join('\n');
  if (opts.watch) console.clear();
  console.log(out);
}

render();
if (opts.watch) {
  let timer = null;
  fs.watch(DIR, () => { clearTimeout(timer); timer = setTimeout(render, 200); });
}
