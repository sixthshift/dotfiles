#!/usr/bin/env node
// jurisdiction.mjs — the mechanical half of recover's product-code boundary.
//
// Recover is the campaign's most privileged actor: full tools on the shared
// checkout. Its one hard rule — "never touch product code" — would otherwise
// live only in its prompt, and prose is the wrong enforcement layer for the one
// agent that can edit the thing every other arm is measured against. A worker's
// diff meets an adversarial reviewer and then a phase gate; recover's edit to
// the same file meets nobody.
//
// So the boundary is checked instead of asked for. Nothing else may touch the
// mainline checkout while recover runs (the coordinator dispatches no worker
// against it and settles no ticket into it), which is what makes the difference
// between the two snapshots attributable to recover alone.
//
// Usage:
//   node jurisdiction.mjs snapshot --out <file>     # before spawning recover
//   node jurisdiction.mjs revert --in <file>        # after it returns
//
// revert prints JSON: { paths, diff, reverted }. `paths: []` is the ordinary
// result. `reverted: false` means the breach is STANDING — the undo was refused,
// and the coordinator owes the human a park rather than a reassuring note.
//
// In bounds: untracked files (a scratch reproduction is how a fault gets
// diagnosed), manifests and lockfiles (an install IS a manifest edit), the
// campaign's own .ailoop/ state, and cleaning away dirt that was already there.
// Campaign-definition changes never appear here at all — those go through
// backlog-write.mjs, not git.
//
// Out of bounds: a tracked, non-manifest file whose content changed. The undo is
// what makes this enforcement rather than another note nobody acts on; the
// coordinator files the reverted diff as a repair ticket, so the intent survives
// and goes through worker → verify → review like any other change to the work.

import fs from 'node:fs';
import { execSync } from 'node:child_process';

const opts = {};
const argv = process.argv.slice(2);
const cmd = argv.shift();
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1] ?? true; i++; }

const CAMPAIGN = '.ailoop/';
const DIFF_CAP = 20_000; // the repair ticket carries this; a worker needs the shape, not every hunk
const MANIFESTS = new Set(['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);

const sh = c => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return e.stdout ?? ''; } };
const ok = c => { try { execSync(c, { stdio: 'ignore' }); return true; } catch { return false; } };
const lines = s => s.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
const quote = p => `'${p.replace(/'/g, `'\\''`)}'`;
const headSha = () => sh('git rev-parse HEAD').trim();
const porcelain = () => lines(sh('git status --porcelain'));
const isManifest = f => MANIFESTS.has(f.split('/').pop());

// `XY path`, `R  old -> new`, and git's quoting of paths with unusual bytes.
function porcelainPath(line) {
  const raw = line.slice(3).trim();
  const renamed = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
  return renamed.startsWith('"') && renamed.endsWith('"') ? renamed.slice(1, -1) : renamed;
}

if (cmd === 'snapshot') {
  if (!opts.out) { console.error('REFUSED: snapshot requires --out <file>'); process.exit(1); }
  fs.writeFileSync(opts.out, JSON.stringify({ sha: headSha(), dirt: porcelain() }, null, 2));
  console.log(`snapshot → ${opts.out}`);
} else if (cmd === 'revert') {
  if (!opts.in) { console.error('REFUSED: revert requires --in <snapshot file>'); process.exit(1); }
  console.log(JSON.stringify(revert(JSON.parse(fs.readFileSync(opts.in, 'utf8'))), null, 2));
} else {
  console.error(`REFUSED: unknown command ${cmd}. Commands: snapshot revert`);
  process.exit(1);
}

// Which paths the run put out of bounds. Working-tree lines are compared
// verbatim against the snapshot, so dirt that was already there stays its
// owner's (the dirty-mainline anomaly IS pre-existing dirt), and clearing dirt
// away — which only ever removes lines — is never a violation.
//
// Known limit: a file already modified when recover started and modified again
// by recover keeps the same `M path` line and slips through. The check is exact
// for every anomaly that arrives on a clean mainline, which is all of them
// except dirty-mainline.
function outOfBounds(before, committed) {
  const known = new Set(before);
  const staged = porcelain()
    .filter(l => !known.has(l) && !l.startsWith('??') && !l.startsWith('!!'))
    .map(porcelainPath);
  return [...new Set([...staged, ...committed])]
    .filter(p => p && !isManifest(p) && !p.startsWith(CAMPAIGN));
}

function revert(before) {
  const sha = headSha();
  const committed = sha === before.sha
    ? []
    : lines(sh(`git diff --name-only ${before.sha}..HEAD`));
  const paths = outOfBounds(before.dirt, committed);
  if (!paths.length) return { paths: [], diff: '', reverted: true };

  const spec = paths.map(quote).join(' ');
  // Captured before the undo: this diff is the only surviving account of what
  // recover was trying to do, and the repair ticket is written from it.
  const diff = [
    sha === before.sha ? '' : sh(`git diff ${before.sha}..HEAD -- ${spec}`),
    sh(`git diff -- ${spec}`),
  ].filter(t => t.trim()).join('\n').slice(0, DIFF_CAP);

  if (committed.length) {
    // A commit can't be undone path-by-path without authoring another commit in
    // recover's name, and nothing else has moved this checkout, so no one else's
    // work sits on top. The reset takes any allowed manifest change in the same
    // commit down with it — a mixed commit is itself out of bounds, and the diff
    // above preserves it.
    //
    // Unless the repository tracks .ailoop/. Then a reset would also roll the
    // campaign's own backlog and journal back to whatever they held when recover
    // started — silently undoing this run's bookkeeping to punish it. Refuse and
    // report the breach standing: an unreverted breach the human is told about
    // beats a revert that corrupts the ledger recording it.
    if (sh(`git ls-files -- ${CAMPAIGN}`).trim().length > 0) return { paths, diff, reverted: false };
    if (!ok(`git reset --hard ${before.sha}`)) return { paths, diff, reverted: false };
  } else {
    for (const p of paths) {
      // Tracked in HEAD → restore it. Otherwise recover staged a NEW file:
      // untrack it and leave it on disk, because untracked is in bounds and
      // destroying content nobody has read is not this script's call.
      if (ok(`git cat-file -e HEAD:${quote(p)}`)) ok(`git checkout -q HEAD -- ${quote(p)}`);
      else ok(`git rm -q --cached -- ${quote(p)}`);
    }
  }
  return { paths, diff, reverted: true };
}
