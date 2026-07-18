#!/usr/bin/env node
// verify.mjs — the measurement. No model. Exit codes decide.
//
// Ticket mode:
//   node verify.mjs --ticket T017 --dir <worktree> --base <sha> [--run .ailoop/run]
//   1. refuses a dirty tree (only committed work verifies)
//   2. runs ALL fastChecks + the ticket's acceptanceChecks in the worktree
//   3. scope check: git diff --name-only <base>..HEAD must be ⊆ declared files
//      ∪ manifest allowlist — any overflow FAILS the ticket
//   4. writes evidence/<id>.txt (or <id>-aN.txt on failure) + evidence/<id>-diff.patch
//   Prints JSON { pass, failing: [names], scopeOverflow: [], evidence, diff }
//
// Flake probe mode:
//   node verify.mjs --cmd "<single test cmd>" --repeat 5 --dir <worktree>
//   Prints JSON { passes, fails, verdict: "real-red" | "flaky" }

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1] ?? true; i++; }
const RUN = opts.run || '.ailoop/run';
const EVID = path.join(RUN, 'evidence');
fs.mkdirSync(EVID, { recursive: true });

const ALLOW = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
const sh = (cmd, cwd) => spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });

// ---------- flake probe mode ----------
if (opts.cmd) {
  const n = parseInt(opts.repeat || '5', 10);
  let passes = 0;
  const outputs = [];
  for (let i = 0; i < n; i++) {
    const r = sh(opts.cmd, opts.dir || '.');
    if (r.status === 0) passes++;
    outputs.push(`--- run ${i + 1} exit=${r.status}\n${(r.stdout || '') + (r.stderr || '')}`);
  }
  const verdict = passes === 0 ? 'real-red' : (passes < n ? 'flaky' : 'flaky-under-full-run-only');
  const file = path.join(EVID, `flake-probe-${Date.now()}.txt`);
  fs.writeFileSync(file, outputs.join('\n'));
  console.log(JSON.stringify({ passes, fails: n - passes, verdict, evidence: file }, null, 2));
  process.exit(0);
}

// ---------- ticket mode ----------
const id = opts.ticket;
const dir = opts.dir;
const base = opts.base;
if (!id || !dir || !base) { console.error('need --ticket --dir --base (or --cmd for flake probe)'); process.exit(2); }

const backlog = JSON.parse(fs.readFileSync(path.join(RUN, 'backlog.json'), 'utf8'));
const t = backlog.tickets.find(x => x.id === id);
if (!t) { console.error(`no ticket ${id}`); process.exit(2); }

// 1. dirty tree refusal
const dirty = sh('git status --porcelain', dir).stdout.split('\n')
  .filter(l => l.trim() && !l.slice(3).startsWith('.ailoop/')).join('\n').trim();
if (dirty) {
  console.log(JSON.stringify({ pass: false, failing: ['dirty-tree'], scopeOverflow: [], note: 'uncommitted changes — only committed work verifies' }, null, 2));
  process.exit(1);
}

// 2. run checks
const checks = [...(backlog.fastChecks || []), ...(t.acceptanceChecks || [])];
const failing = [];
const log = [];
for (const c of checks) {
  const r = sh(c.cmd, dir);
  const ok = r.status === 0;
  if (!ok) failing.push(c.name);
  log.push(`### ${c.name} — ${ok ? 'PASS' : `FAIL (exit ${r.status})`}\n$ ${c.cmd}\n${(r.stdout || '') + (r.stderr || '')}`);
}

// 3. scope check
const diffNames = sh(`git diff --name-only ${base}..HEAD`, dir).stdout.trim().split('\n').filter(Boolean);
const declared = new Set(t.files || []);
const scopeOverflow = diffNames.filter(f => !declared.has(f) && !ALLOW.has(path.basename(f)));
if (scopeOverflow.length) failing.push('scope');
log.push(`### scope — ${scopeOverflow.length ? 'FAIL' : 'PASS'}\ndiff files: ${diffNames.join(', ') || '(none)'}\noverflow: ${scopeOverflow.join(', ') || '(none)'}`);

// 4. evidence + diff dump
const pass = failing.length === 0;
const attemptN = (t.attempts || []).length + 1;
const evidence = path.join(EVID, pass ? `${id}.txt` : `${id}-a${attemptN}.txt`);
fs.writeFileSync(evidence, log.join('\n\n'));
const diffFile = path.join(EVID, `${id}-diff.patch`);
fs.writeFileSync(diffFile, sh(`git diff ${base}..HEAD`, dir).stdout || '');

console.log(JSON.stringify({ pass, failing, scopeOverflow, evidence, diff: diffFile }, null, 2));
process.exit(pass ? 0 : 1);
