#!/usr/bin/env node
// frontier.mjs — read-only gate. Computes everything the loop needs to KNOW
// about the backlog; never mutates it. The coordinator acts on this output,
// never on its own reading of backlog.json.
//
// Usage: node frontier.mjs [--dir .ailoop/run]
// Prints JSON: { problems, cycles, ready, dispatchable, capBreaches,
//                thrashBreaches, phasesDrained, inFlight, complete }
// inFlight is a fact, not a diagnosis: staleness = an entry you have no live
// worker for (all of them, on resume) — that judgment is the coordinator's.
// dispatchable ⊆ ready: safe to spawn NOW — file- and resource-disjoint from
// every in-flight ticket and from each other. Streaming, re-run after each
// worker returns; never a pre-baked batch to drain.

import fs from 'node:fs';
import path from 'node:path';

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1] ?? true; i++; }
const DIR = opts.dir || '.ailoop/run';
const b = JSON.parse(fs.readFileSync(path.join(DIR, 'backlog.json'), 'utf8'));
const byId = Object.fromEntries(b.tickets.map(t => [t.id, t]));

const problems = [];
const live = t => !['closed', 'decomposed'].includes(t.status);

// --- structural problems
for (const t of b.tickets) {
  for (const d of t.depends_on || []) {
    if (!byId[d]) problems.push({ ticket: t.id, issue: `dangling dependency ${d}` });
    else if (byId[d].status === 'decomposed' && live(t))
      problems.push({ ticket: t.id, issue: `stranded on decomposed ${d} — rewire onto its children` });
  }
  if (live(t) && (!Array.isArray(t.files) || t.files.length === 0))
    problems.push({ ticket: t.id, issue: 'empty files declaration — unknown footprint' });
  if (t.status === 'vetted' && !t.redTeamed)
    problems.push({ ticket: t.id, issue: 'vetted without redTeamed flag — state corruption, backlog-write should have prevented this' });
}
const seen = new Set();
for (const t of b.tickets) {
  if (seen.has(t.id)) problems.push({ ticket: t.id, issue: 'duplicate id' });
  seen.add(t.id);
}

// --- cycle detection (iterative DFS over live tickets)
const cycles = [];
{
  const state = {}; // 0 unvisited, 1 in-stack, 2 done
  for (const start of b.tickets) {
    if (state[start.id]) continue;
    const stack = [[start.id, 0, [start.id]]];
    while (stack.length) {
      const [id, i, trail] = stack[stack.length - 1];
      if (i === 0) state[id] = 1;
      const deps = (byId[id]?.depends_on || []).filter(d => byId[d]);
      if (i < deps.length) {
        stack[stack.length - 1][1]++;
        const d = deps[i];
        if (state[d] === 1) cycles.push([...trail.slice(trail.indexOf(d) >= 0 ? trail.indexOf(d) : 0), d]);
        else if (!state[d]) stack.push([d, 0, [...trail, d]]);
      } else { state[id] = 2; stack.pop(); }
    }
  }
}

// --- ready: deps closed AND status vetted (draft/blocked/in-flight never ready)
const ready = b.tickets
  .filter(t => t.status === 'vetted')
  .filter(t => (t.depends_on || []).every(d => byId[d]?.status === 'closed'))
  .map(t => t.id);

// --- cap & thrash breaches (checked over READY tickets, before re-dispatch)
const caps = b.caps || { maxAttempts: 3, thrash: 2 };
const capBreaches = [];
const thrashBreaches = [];
for (const id of ready) {
  const t = byId[id];
  const a = t.attempts || [];
  if (a.length >= caps.maxAttempts) capBreaches.push({ ticket: id, attempts: a.length });
  if (a.length >= caps.thrash) {
    const recent = a.slice(-caps.thrash).map(x => new Set(x.failed || []));
    // thrash: failing set not shrinking across the window
    let shrinking = false;
    for (let i = 1; i < recent.length; i++) if (recent[i].size < recent[i - 1].size) shrinking = true;
    if (!shrinking && recent.every(s => s.size > 0)) thrashBreaches.push({ ticket: id, window: caps.thrash });
  }
}
const walls = new Set([...capBreaches, ...thrashBreaches].map(x => x.ticket));
const notWalled = ready.filter(id => !walls.has(id));

// --- dispatchable: the subset safe to spawn RIGHT NOW — file- AND resource-
//     disjoint from every in-flight ticket and from each other. Streaming, not
//     batched: seed the occupied sets with what is already running, then greedily
//     admit ready tickets that don't collide (manifest/lockfiles allowlisted).
const ALLOW = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
const declaredFiles = t => (t.files || []).filter(f => !ALLOW.has(path.basename(f)));
const inFlight = b.tickets.filter(t => t.status === 'in-flight');
const occupiedFiles = new Set(inFlight.flatMap(declaredFiles));
const occupiedResources = new Set(inFlight.flatMap(t => t.resources || []));
const dispatchable = [];
for (const id of notWalled) {
  const files = declaredFiles(byId[id]);
  const resources = byId[id].resources || [];
  if (files.some(f => occupiedFiles.has(f))) continue;
  if (resources.some(r => occupiedResources.has(r))) continue;
  dispatchable.push(id);
  files.forEach(f => occupiedFiles.add(f));
  resources.forEach(r => occupiedResources.add(r));
}

// --- phase drain: phases whose live tickets are all gone (and had at least one ticket)
const phasesDrained = [];
for (const p of b.phases || []) {
  const ts = b.tickets.filter(t => t.phase === p.id);
  if (ts.length && ts.every(t => !live(t) )) phasesDrained.push(p.id);
}

// --- in-flight & completion
const inFlightIds = inFlight.map(t => t.id);
const complete = b.tickets.length > 0 && b.tickets.every(t =>
  ['closed', 'decomposed'].includes(t.status));
// blocked/draft/vetted/failed-wall tickets all block completion, deliberately

console.log(JSON.stringify({
  problems, cycles,
  ready, dispatchable,
  capBreaches, thrashBreaches,
  phasesDrained, inFlight: inFlightIds, complete,
  counts: b.tickets.reduce((m, t) => ((m[t.status] = (m[t.status] || 0) + 1), m), {}),
}, null, 2));
