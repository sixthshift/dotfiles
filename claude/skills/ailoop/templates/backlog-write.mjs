#!/usr/bin/env node
// backlog-write.mjs — the SOLE writer of backlog.json. Every mutation is a
// command; each success appends a stamped entry to journal.jsonl. The
// coordinator never edits state files by hand.
//
// Usage:
//   node backlog-write.mjs init --project <name> [--dir .ailoop/campaign]
//   node backlog-write.mjs seed <config.json|-> [--amend --note "why"]
//       config: { fastChecks?: [{name,cmd}], phases?: [{id, delivers, gate: [{name,cmd}]}],
//                 outOfScope?: [string], requirements?: [{id: "R1", clause}] }
//       seed freely before the first ticket; after that every change is an
//       amendment — --amend with a mandatory --note rationale, journaled
//   node backlog-write.mjs add <tickets.json|-> [--dir ...]        # array or single ticket
//   node backlog-write.mjs update <id> <patch.json|-> [--note "..."] [--reset-attempts]
//                                                  # contract fields only; a vetted ticket demotes to draft (re-vet)
//   node backlog-write.mjs vet <id> [--note "..."]
//   node backlog-write.mjs set-status <id> <status> [--note "..."]
//   node backlog-write.mjs attempt <id> --failed a,b --hypothesis "..." --fix "..."
//   node backlog-write.mjs close <id> --evidence <path> [--note "..."]
//   node backlog-write.mjs decompose <id> <children.json|-> [--note "..."]
//   node backlog-write.mjs park <id> --reason "..."                # defer ONE ticket to the human
//   node backlog-write.mjs park --phase <id> --reason "..."        # latch a phase gate for the human
//   node backlog-write.mjs unpark <id> --note "..."               # the human answered; back in the queue
//   node backlog-write.mjs gate <phaseId> <gates.json|-> --note "why" [--replace] [--release-latch]
//   node backlog-write.mjs note --kind <kind> --subject <subj> --body "..."   # journal-only
//
// Exit non-zero on any refused mutation, with the reason on stderr. One
// deliberate exception: `gate` classifies its own proposal by name (see below),
// applies the additions, and journals any refused replacement — the additions
// landing is not a refusal, and the refusal is on the record rather than in an
// exit code the caller would have to interpret against a partial write.

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
const DIR = opts.dir || '.ailoop/campaign';
const BACKLOG = path.join(DIR, 'backlog.json');
const JOURNAL = path.join(DIR, 'journal.jsonl');

// `parked` replaces the old `failed-wall`: they occupy the same slot — a ticket
// held out of dispatch — but name different things. A wall was a dead end that
// stopped the campaign; a park is a decision deferred to the human while the
// loop keeps driving everything else, and it is reached only after recover has
// spent its budget on the fault. `blocked` stays distinct and transient: a
// ticket waiting on a rewire the coordinator is about to perform itself.
const STATUSES = ['draft', 'vetted', 'in-flight', 'closed', 'blocked', 'decomposed', 'parked'];
const LEGAL = { // from -> allowed to
  'draft': ['vetted', 'decomposed', 'parked'],
  'vetted': ['in-flight', 'draft', 'decomposed', 'blocked', 'parked'],
  'in-flight': ['closed', 'vetted', 'blocked', 'decomposed', 'parked'],
  'blocked': ['vetted', 'draft', 'decomposed', 'parked'],
  'parked': ['vetted', 'draft', 'decomposed'],
  'closed': [], 'decomposed': [],
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
const requirementIds = b => new Set((b.requirements || []).map(r => r.id));

function validateTicket(t, existingIds, reqIds = null) {
  const errs = [];
  if (!t.id || !/^T\d+$/.test(t.id)) errs.push(`bad or missing id: ${t.id}`);
  if (existingIds.has(t.id)) errs.push(`duplicate id: ${t.id}`);
  if (!t.title) errs.push(`${t.id}: missing title`);
  if (!t.phase) errs.push(`${t.id}: missing phase`);
  // A claim on a requirement that doesn't exist is worse than no claim: the
  // coverage join counts the clause as unmapped while the ticket reads as
  // covering it, and nothing downstream would ever disagree out loud.
  if (t.satisfies !== undefined) {
    if (!Array.isArray(t.satisfies)) errs.push(`${t.id}: satisfies must be an array of requirement ids`);
    else if (reqIds) for (const r of t.satisfies) {
      if (!reqIds.has(r)) errs.push(`${t.id}: satisfies unknown requirement ${r} — seed it in the enumeration or drop the claim`);
    }
  }
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
      fastChecks: [], phases: [], outOfScope: [], requirements: [], tickets: [],
    });
    journal('init', 'campaign', `campaign initialized for project ${opts.project || 'unnamed'}`);
    console.log(`initialized ${BACKLOG}`);
    break;
  }
  case 'seed': {
    const b = load();
    if (b.tickets.length && !opts.amend) die('config is seeded before the first ticket exists — after that, re-run with --amend --note "why" (a journaled amendment)');
    if (opts.amend && !opts.note) die('--amend requires --note — the rationale is the record');
    const KEYS = ['fastChecks', 'phases', 'outOfScope', 'requirements'];
    const input = readInput(pos[0] || '-');
    if (input.length !== 1) die(`seed takes a single config object {${KEYS.map(k => `${k}?`).join(', ')}}`);
    const cfg = input[0];
    const errs = [];
    for (const k of Object.keys(cfg)) if (!KEYS.includes(k)) errs.push(`unknown key ${k} (seed takes ${KEYS.join(', ')})`);
    (cfg.fastChecks || []).forEach(c => { if (!c.name || !c.cmd) errs.push(`fastCheck missing name or cmd: ${JSON.stringify(c)}`); });
    (cfg.phases || []).forEach(p => {
      if (!p.id) errs.push(`phase missing id: ${JSON.stringify(p)}`);
      (p.gate || []).forEach(g => { if (!g.name || !g.cmd) errs.push(`${p.id}: gate command missing name or cmd`); });
    });
    (cfg.outOfScope || []).forEach(o => { if (typeof o !== 'string') errs.push(`outOfScope entries are strings: ${JSON.stringify(o)}`); });
    // The spec's normative clauses, enumerated once. Tickets claim these ids and
    // the coverage join is a join on them, so an id that vanishes takes every
    // claim on it with it — an amendment may add and reword, never orphan.
    if (cfg.requirements !== undefined) {
      const seenR = new Set();
      cfg.requirements.forEach(r => {
        if (!r.id || !/^R\d+$/.test(r.id)) errs.push(`requirement needs an id R1, R2, …: ${JSON.stringify(r)}`);
        else if (seenR.has(r.id)) errs.push(`duplicate requirement id ${r.id}`);
        else seenR.add(r.id);
        if (!r.clause || typeof r.clause !== 'string') errs.push(`${r.id}: clause must be the spec's normative text`);
      });
      const claimed = new Set(b.tickets.flatMap(t => t.satisfies || []));
      const dropped = [...claimed].filter(r => !seenR.has(r));
      if (dropped.length) errs.push(`requirements [${dropped.join(', ')}] are claimed by live tickets — reword a clause in place, never drop its id`);
    }
    if (errs.length) die(errs.join('\n'));
    for (const k of KEYS) if (cfg[k] !== undefined) b[k] = cfg[k];
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
    // `satisfies` is deliberately not mutable: a patch may reshape how a ticket
    // does its work, never which clause of the spec it answers — that is a
    // decomposition decision, and re-pointing it silently would move coverage.
    const MUTABLE = ['title', 'phase', 'depends_on', 'files', 'resources', 'model', 'context', 'acceptance', 'acceptanceChecks'];
    const illegal = Object.keys(patch).filter(k => !MUTABLE.includes(k));
    if (illegal.length) die(`immutable or unknown field(s): ${illegal.join(', ')} — mutable: ${MUTABLE.join(', ')}`);
    Object.assign(t, patch);
    const errs = validateTicket(t, new Set(), requirementIds(b)).filter(e => !e.includes('duplicate'));
    if (errs.length) die(`patch leaves ${t.id} invalid:\n${errs.join('\n')}`); // die before save — file untouched
    // The attempts log is evidence against the contract that produced it. A
    // materially changed contract makes it evidence about nothing, so recover
    // can clear it and hand the ticket a fresh budget — but only by saying so.
    if (opts['reset-attempts']) {
      if (!opts.note) die('--reset-attempts requires --note — erasing failure evidence is a claim that needs a reason');
      t.attempts = [];
    }
    const demoted = t.status === 'vetted';
    if (demoted) { transition(t, 'draft'); t.redTeamed = false; } // contract changed → re-earn the vet
    journal('update', t.id, `fields [${Object.keys(patch).join(', ')}]${opts['reset-attempts'] ? '; attempts reset' : ''}${demoted ? '; vetted → draft, re-vet required' : ''}${opts.note ? ` — ${opts.note}` : ''}`);
    save(b);
    console.log(`${t.id} updated${opts['reset-attempts'] ? ' (attempts reset)' : ''}${demoted ? ' (vetted → draft: contract changed, re-vet)' : ''}`);
    break;
  }
  case 'add': {
    const b = load();
    const ids = new Set(b.tickets.map(t => t.id));
    const incoming = readInput(pos[0] || '-');
    const errs = incoming.flatMap(t => validateTicket(t, ids, requirementIds(b)));
    if (errs.length) die(errs.join('\n'));
    for (const t of incoming) {
      b.tickets.push({
        depends_on: [], resources: [], satisfies: [], model: 'opus', redTeamed: false, attempts: [], evidence: null,
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
    const errs = validateTicket(t, new Set(), requirementIds(b));
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
    if (to === 'parked') die(`use the park command (a reason for the human is mandatory)`);
    if (t.status === 'parked') die(`${t.id} is parked for the human — use the unpark command (its answer is the record)`);
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
    const errs = children.flatMap(c => validateTicket(c, ids, requirementIds(b)));
    if (errs.length) die(errs.join('\n'));
    transition(t, 'decomposed');
    const childIds = children.map(c => c.id);
    for (const c of children) {
      // The parent's claims do NOT descend by default: a decomposed parent's
      // claim stops counting (coverage skips it), so children that don't restate
      // the clause leave it unmapped — visible, which is the point.
      b.tickets.push({
        depends_on: [], resources: [], satisfies: [], model: t.model || 'opus', redTeamed: false, attempts: [], evidence: null,
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
  // How the loop yields to the human WITHOUT stopping. A park takes one ticket
  // (or one phase's gate) out of the loop's hands and journals why; every other
  // ticket keeps driving, and the campaign only ends — gracefully, with a drain
  // report — once nothing autonomous is left. Reached after recover has spent
  // its budget on the fault, never as a first response.
  case 'park': {
    const b = load();
    if (!opts.reason) die('park requires --reason — a park the human cannot act on is just a stall');
    if (opts.phase) {
      const p = (b.phases || []).find(x => x.id === opts.phase);
      if (!p) die(`no phase ${opts.phase}`);
      p.parked = { reason: opts.reason, ts: new Date().toISOString() };
      journal('parked', p.id, `phase gate parked — ${opts.reason}`, parseData());
      save(b);
      console.log(`phase ${p.id} gate parked`);
      break;
    }
    if (!pos[0]) die('park takes a ticket id, or --phase <id> for a phase gate');
    const t = findTicket(b, pos[0]);
    if (t.status === 'parked') { console.log(`${t.id} already parked`); break; } // idempotent: re-parking is not an event
    transition(t, 'parked');
    // Stamped as well as journaled: the drain report and the dashboard read the
    // reason off the ticket, and making them scan the journal for it is how a
    // park degrades into an unexplained stall.
    t.parked = { reason: opts.reason, ts: new Date().toISOString() };
    journal('parked', t.id, opts.reason, parseData());
    save(b);
    console.log(`${t.id} parked — ${opts.reason}`);
    break;
  }
  case 'unpark': {
    const b = load();
    if (!opts.note) die('unpark requires --note — the human\'s answer IS the record');
    if (opts.phase) {
      const p = (b.phases || []).find(x => x.id === opts.phase);
      if (!p) die(`no phase ${opts.phase}`);
      if (!p.parked) die(`phase ${p.id} is not parked`);
      delete p.parked;
      journal('unparked', p.id, opts.note);
      save(b);
      console.log(`phase ${p.id} gate unparked`);
      break;
    }
    const t = findTicket(b, pos[0]);
    if (t.status !== 'parked') die(`${t.id} is ${t.status}, not parked`);
    transition(t, 'draft'); // the answer changed something — the contract re-earns its vet
    t.redTeamed = false;
    delete t.parked;
    journal('unparked', t.id, opts.note);
    save(b);
    console.log(`${t.id} unparked → draft (re-vet)`);
    break;
  }
  // Amending a phase gate — the one agent-proposed mutation that edits the
  // criteria deciding whether the product is correct. Upsert by name, and the
  // name is what splits the two acts: one not in force only ADDS coverage, so
  // any arm may propose it. Reusing a live name REPLACES the command deciding
  // correctness right now, which can turn a real escaped bug into a green phase
  // — and no comparison of two shell strings can prove a replacement is a
  // tightening. So authority comes from the caller: --replace is passed only for
  // a recover answering that gate's OWN red run, the one invocation that held
  // the failure and could re-run the correction green. Everyone else adds.
  // Either act is journaled with the command it displaced.
  case 'gate': {
    const b = load();
    const p = (b.phases || []).find(x => x.id === pos[0]);
    if (!p) die(`no phase ${pos[0]} — gate takes <phaseId> <gates.json|->`);
    if (!opts.note) die('gate requires --note — an amendment to the definition of correct is not self-explanatory');
    const proposed = readInput(pos[1] || '-');
    proposed.forEach(g => { if (!g.name || !g.cmd) die(`gate entry missing name or cmd: ${JSON.stringify(g)}`); });
    p.gate = p.gate || [];
    const applied = [];
    for (const g of proposed) {
      const inForce = p.gate.find(x => x.name === g.name);
      if (!inForce) {
        p.gate.push(g);
        applied.push(`+${g.name}`);
        journal('gate-added', g.name, `${p.id}: added ${g.name} — ${g.cmd} — ${opts.note}`);
        continue;
      }
      if (inForce.cmd === g.cmd) continue; // idempotent re-proposal is neither act
      if (!opts.replace) {
        applied.push(`✗${g.name}`);
        journal('gate-refused', g.name, `${p.id}: proposed replacing ${g.name} without the authority to — in force: ${inForce.cmd} — proposed: ${g.cmd} — ${opts.note}`);
        continue;
      }
      // Mechanical kind on purpose: whether this narrowed the gate is the
      // post-mortem reader's call, and it can only make it from the before.
      journal('gate-replaced', g.name, `${p.id}: replaced ${g.name} — was: ${inForce.cmd} — now: ${g.cmd} — ${opts.note}`);
      inForce.cmd = g.cmd;
      applied.push(`~${g.name}`);
    }
    // The authority to replace a gate command and the authority to answer its
    // park are the same fact about the caller. An arm that could only add a
    // check leaves the latch where the human left it.
    if (opts['release-latch'] && opts.replace && p.parked) {
      delete p.parked;
      journal('unparked', p.id, `gate amended by its own red run — ${opts.note}`);
    }
    save(b);
    console.log(`${p.id} gate [${applied.join(', ') || 'no change'}]`);
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
    die(`unknown command: ${cmd}. Commands: init seed add update vet set-status attempt close decompose park unpark gate note`);
}
