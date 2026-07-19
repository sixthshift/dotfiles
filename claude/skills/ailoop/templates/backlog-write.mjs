#!/usr/bin/env node
// backlog-write.mjs — the SOLE writer of backlog.json. Every mutation is a
// command; each success appends a stamped entry to journal.jsonl. The
// coordinator never edits state files by hand.
//
// Usage:
//   node backlog-write.mjs init --project <name> [--dir .ailoop/run]
//   node backlog-write.mjs seed <config.json|-> [--amend --note "why"]
//       config: { fastChecks?: [{name,cmd}], phases?: [{id, delivers, gate: [{name,cmd}]}], outOfScope?: [string] }
//       seed freely before the first ticket; after that every change is an
//       amendment — --amend with a mandatory --note rationale, journaled
//   node backlog-write.mjs add <tickets.json|-> [--dir ...]        # array or single ticket
//   node backlog-write.mjs update <id> <patch.json|-> [--note "..."]  # contract fields only; a vetted ticket demotes to draft (re-vet)
//   node backlog-write.mjs vet <id> [--note "..."]
//   node backlog-write.mjs set-status <id> <status> [--note "..."]
//   node backlog-write.mjs attempt <id> --failed a,b --hypothesis "..." --fix "..."
//   node backlog-write.mjs close <id> --evidence <path> [--note "..."]
//   node backlog-write.mjs decompose <id> <children.json|-> [--note "..."]
//   node backlog-write.mjs note --kind <kind> --subject <subj> --body "..."   # journal-only
//
// Exit non-zero on any refused mutation, with the reason on stderr.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const cmd = args.shift();
const opts = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const next = args[i + 1];
    opts[args[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  } else pos.push(args[i]);
}
const DIR = opts.dir || '.ailoop/run';
const BACKLOG = path.join(DIR, 'backlog.json');
const JOURNAL = path.join(DIR, 'journal.jsonl');

const STATUSES = ['draft', 'vetted', 'in-flight', 'closed', 'blocked', 'decomposed', 'failed-wall'];
const LEGAL = { // from -> allowed to
  'draft': ['vetted', 'decomposed'],
  'vetted': ['in-flight', 'draft', 'decomposed', 'blocked', 'failed-wall'],
  'in-flight': ['closed', 'vetted', 'blocked', 'decomposed', 'failed-wall'],
  'blocked': ['vetted', 'draft', 'decomposed'],
  'closed': [], 'decomposed': [], 'failed-wall': ['vetted'],
};

function die(msg) { console.error(`REFUSED: ${msg}`); process.exit(1); }
function load() {
  if (!fs.existsSync(BACKLOG)) die(`${BACKLOG} not found — run init first`);
  return JSON.parse(fs.readFileSync(BACKLOG, 'utf8'));
}
function save(b) { fs.writeFileSync(BACKLOG, JSON.stringify(b, null, 2) + '\n'); }
function journal(kind, subject, body, data) {
  const seq = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
  fs.appendFileSync(JOURNAL, JSON.stringify({ seq, ts: new Date().toISOString(), kind, subject, body, ...(data ? { data } : {}) }) + '\n');
}
// --data '<json>' rides along on any journaled mutation — telemetry for the
// post-mortem (worker tokens, durations), never load-bearing state.
function parseData() {
  if (!opts.data) return undefined;
  try { return JSON.parse(opts.data); } catch { die('--data must be valid JSON'); }
}
function readInput(src) {
  const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}
function validateTicket(t, existingIds) {
  const errs = [];
  if (!t.id || !/^T\d+$/.test(t.id)) errs.push(`bad or missing id: ${t.id}`);
  if (existingIds.has(t.id)) errs.push(`duplicate id: ${t.id}`);
  if (!t.title) errs.push(`${t.id}: missing title`);
  if (!t.phase) errs.push(`${t.id}: missing phase`);
  if (!Array.isArray(t.files) || t.files.length === 0) errs.push(`${t.id}: files must be a NON-EMPTY array (unknown footprint is unbatchable and unverifiable)`);
  if (!t.context || t.context.length < 40) errs.push(`${t.id}: context too thin to cold-start a worker`);
  if (!t.acceptance) errs.push(`${t.id}: missing acceptance`);
  if (!Array.isArray(t.acceptanceChecks) || t.acceptanceChecks.length === 0) errs.push(`${t.id}: acceptanceChecks must be a non-empty array of {name, cmd}`);
  (t.acceptanceChecks || []).forEach(c => { if (!c.name || !c.cmd) errs.push(`${t.id}: acceptanceCheck missing name or cmd`); });
  if (t.resources !== undefined && !Array.isArray(t.resources)) errs.push(`${t.id}: resources must be an array of shared-resource names`);
  if (!t.origin) errs.push(`${t.id}: missing origin (spec §, decomposed-from, or repair)`);
  return errs;
}
function findTicket(b, id) {
  const t = b.tickets.find(x => x.id === id);
  if (!t) die(`no ticket ${id}`);
  return t;
}
function transition(t, to) {
  if (!STATUSES.includes(to)) die(`unknown status ${to}`);
  if (!(LEGAL[t.status] || []).includes(to)) die(`illegal transition ${t.id}: ${t.status} → ${to}`);
  t.status = to;
}

switch (cmd) {
  case 'init': {
    if (fs.existsSync(BACKLOG)) die(`${BACKLOG} already exists — a campaign is in flight`);
    fs.mkdirSync(path.join(DIR, 'evidence'), { recursive: true });
    save({
      project: opts.project || 'unnamed',
      caps: { maxAttempts: 3, thrash: 2 },
      fastChecks: [], phases: [], outOfScope: [], tickets: [],
    });
    journal('init', 'campaign', `campaign initialized for project ${opts.project || 'unnamed'}`);
    console.log(`initialized ${BACKLOG}`);
    break;
  }
  case 'seed': {
    const b = load();
    if (b.tickets.length && !opts.amend) die('config is seeded before the first ticket exists — after that, re-run with --amend --note "why" (a journaled amendment)');
    if (opts.amend && !opts.note) die('--amend requires --note — the rationale is the record');
    const input = readInput(pos[0] || '-');
    if (input.length !== 1) die('seed takes a single config object {fastChecks?, phases?, outOfScope?}');
    const cfg = input[0];
    const errs = [];
    for (const k of Object.keys(cfg)) if (!['fastChecks', 'phases', 'outOfScope'].includes(k)) errs.push(`unknown key ${k} (seed takes fastChecks, phases, outOfScope)`);
    (cfg.fastChecks || []).forEach(c => { if (!c.name || !c.cmd) errs.push(`fastCheck missing name or cmd: ${JSON.stringify(c)}`); });
    (cfg.phases || []).forEach(p => {
      if (!p.id) errs.push(`phase missing id: ${JSON.stringify(p)}`);
      (p.gate || []).forEach(g => { if (!g.name || !g.cmd) errs.push(`${p.id}: gate command missing name or cmd`); });
    });
    (cfg.outOfScope || []).forEach(o => { if (typeof o !== 'string') errs.push(`outOfScope entries are strings: ${JSON.stringify(o)}`); });
    if (errs.length) die(errs.join('\n'));
    for (const k of ['fastChecks', 'phases', 'outOfScope']) if (cfg[k] !== undefined) b[k] = cfg[k];
    journal(opts.amend ? 'amend-config' : 'seed', 'campaign',
      `${opts.amend ? 'amended' : 'seeded'} ${Object.keys(cfg).join(', ')}${opts.note ? ` — ${opts.note}` : ''}`);
    save(b);
    console.log(`${opts.amend ? 'amended' : 'seeded'} ${Object.keys(cfg).join(', ')}`);
    break;
  }
  case 'update': {
    const b = load();
    const t = findTicket(b, pos[0]);
    if (!['draft', 'vetted'].includes(t.status)) die(`${t.id} is ${t.status} — only draft or vetted tickets can be updated (in-flight work would diverge from its contract)`);
    const input = readInput(pos[1] || '-');
    if (input.length !== 1) die('update takes a single patch object');
    const patch = input[0];
    const MUTABLE = ['title', 'phase', 'depends_on', 'files', 'resources', 'model', 'context', 'acceptance', 'acceptanceChecks'];
    const illegal = Object.keys(patch).filter(k => !MUTABLE.includes(k));
    if (illegal.length) die(`immutable or unknown field(s): ${illegal.join(', ')} — mutable: ${MUTABLE.join(', ')}`);
    Object.assign(t, patch);
    const errs = validateTicket(t, new Set()).filter(e => !e.includes('duplicate'));
    if (errs.length) die(`patch leaves ${t.id} invalid:\n${errs.join('\n')}`); // die before save — file untouched
    const demoted = t.status === 'vetted';
    if (demoted) { transition(t, 'draft'); t.redTeamed = false; } // contract changed → re-earn the vet
    journal('update', t.id, `fields [${Object.keys(patch).join(', ')}]${demoted ? '; vetted → draft, re-vet required' : ''}${opts.note ? ` — ${opts.note}` : ''}`);
    save(b);
    console.log(`${t.id} updated${demoted ? ' (vetted → draft: contract changed, re-vet)' : ''}`);
    break;
  }
  case 'add': {
    const b = load();
    const ids = new Set(b.tickets.map(t => t.id));
    const incoming = readInput(pos[0] || '-');
    const errs = incoming.flatMap(t => validateTicket(t, ids));
    if (errs.length) die(errs.join('\n'));
    for (const t of incoming) {
      b.tickets.push({
        depends_on: [], resources: [], model: 'opus', redTeamed: false, attempts: [], evidence: null,
        ...t, status: 'draft', // status is not caller-settable at birth
      });
      ids.add(t.id);
      journal('add', t.id, `${t.title} (origin: ${t.origin})`);
    }
    save(b);
    console.log(`added ${incoming.length} draft ticket(s)`);
    break;
  }
  case 'vet': {
    const b = load();
    const t = findTicket(b, pos[0]);
    if (t.status !== 'draft') die(`${t.id} is ${t.status}, only draft tickets can be vetted`);
    const errs = validateTicket(t, new Set());
    const real = errs.filter(e => !e.includes('duplicate'));
    if (real.length) die(`cannot vet with schema problems:\n${real.join('\n')}`);
    t.redTeamed = true;
    transition(t, 'vetted');
    journal('vet', t.id, opts.note || 'critic pass complete');
    save(b);
    console.log(`${t.id} vetted`);
    break;
  }
  case 'set-status': {
    const b = load();
    const t = findTicket(b, pos[0]);
    const to = pos[1];
    if (to === 'closed') die(`use the close command (evidence is mandatory)`);
    if (to === 'vetted' && t.status === 'draft') die(`use the vet command (red-team is mandatory)`);
    if (to === 'decomposed') die(`use the decompose command (children are mandatory)`);
    transition(t, to);
    journal('status', t.id, `→ ${to}${opts.note ? ` — ${opts.note}` : ''}`, parseData());
    save(b);
    console.log(`${t.id} → ${to}`);
    break;
  }
  case 'attempt': {
    const b = load();
    const t = findTicket(b, pos[0]);
    if (!opts.failed) die('attempt requires --failed <comma-separated check names>');
    if (!opts.hypothesis) die('attempt requires --hypothesis');
    const entry = {
      n: t.attempts.length + 1,
      failed: String(opts.failed).split(',').map(s => s.trim()).filter(Boolean),
      hypothesis: opts.hypothesis,
      fixNote: opts.fix || '',
      ts: new Date().toISOString(),
    };
    t.attempts.push(entry);
    if (t.status === 'in-flight') transition(t, 'vetted'); // back in the queue for re-dispatch
    journal('attempt', t.id, `attempt ${entry.n} failed [${entry.failed.join(', ')}]: ${entry.hypothesis}`, parseData());
    save(b);
    console.log(`${t.id} attempt ${entry.n} logged`);
    break;
  }
  case 'close': {
    const b = load();
    const t = findTicket(b, pos[0]);
    if (!opts.evidence) die('close requires --evidence <path> (independent re-verify output)');
    if (!fs.existsSync(opts.evidence)) die(`evidence file not found: ${opts.evidence}`);
    transition(t, 'closed');
    t.evidence = opts.evidence;
    journal('close', t.id, opts.note || `closed with evidence ${opts.evidence}`, parseData());
    save(b);
    console.log(`${t.id} closed`);
    break;
  }
  case 'decompose': {
    const b = load();
    const t = findTicket(b, pos[0]);
    const ids = new Set(b.tickets.map(x => x.id));
    const children = readInput(pos[1] || '-');
    if (!children.length) die('decompose requires child tickets');
    const errs = children.flatMap(c => validateTicket(c, ids));
    if (errs.length) die(errs.join('\n'));
    transition(t, 'decomposed');
    const childIds = children.map(c => c.id);
    for (const c of children) {
      b.tickets.push({
        depends_on: [], resources: [], model: t.model || 'opus', redTeamed: false, attempts: [], evidence: null,
        phase: c.phase || t.phase, origin: c.origin || `decomposed from ${t.id}`,
        ...c, status: 'draft',
      });
      ids.add(c.id);
    }
    // rewire dependents of the parent onto ALL children (coordinator may narrow after)
    let rewired = 0;
    for (const other of b.tickets) {
      const i = (other.depends_on || []).indexOf(t.id);
      if (i >= 0 && other.status !== 'closed' && other.status !== 'decomposed') {
        other.depends_on.splice(i, 1, ...childIds);
        rewired++;
      }
    }
    journal('decompose', t.id, `→ [${childIds.join(', ')}]; ${rewired} dependent(s) rewired onto children (narrow the edges if too broad)`);
    save(b);
    console.log(`${t.id} decomposed into ${childIds.join(', ')}; ${rewired} dependents rewired`);
    break;
  }
  case 'note': {
    if (!fs.existsSync(JOURNAL) && !fs.existsSync(BACKLOG)) die('no campaign here');
    if (!opts.kind || !opts.subject || !opts.body) die('note requires --kind --subject --body');
    journal(opts.kind, opts.subject, opts.body, parseData());
    console.log('journaled');
    break;
  }
  default:
    die(`unknown command: ${cmd}. Commands: init seed add update vet set-status attempt close decompose note`);
}
