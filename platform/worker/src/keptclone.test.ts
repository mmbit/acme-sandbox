// node --test src/keptclone.test.ts   (A new session in its job's kept clone: after a hand-up, and after HQ ended a dead
// session, it goes on from the clone's files as the last session left them, told why.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFresh, keptCloneLines } from './keptclone.ts';

const RESTARTED = 'HQ ended your last session on this job: it had done nothing for 1 h and waited on nothing.';

// A job's clone with a commit and an uncommitted edit, and its home, as a session left them
function folders() {
  const root = mkdtempSync(join(tmpdir(), 'keptclone-')),
    dir = join(root, 'job'),
    home = join(root, 'home');
  mkdirSync(home);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'a.txt'), 'committed\n');
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
  writeFileSync(join(dir, 'a.txt'), 'edited, not committed\n');
  return { root, dir, home, status: () => String(git('status', '--porcelain')) };
}

test('a run after HQ ended its dead session keeps its clone, uncommitted edits too, and starts a new home', () => {
  const f = folders();
  clearFresh({ session: null, restarted: RESTARTED }, f.dir, f.home);
  assert.equal(readFileSync(join(f.dir, 'a.txt'), 'utf8'), 'edited, not committed\n');
  assert.equal(f.status(), ' M a.txt\n');
  assert.equal(existsSync(f.home), false, 'its session went with its home');
  rmSync(f.root, { recursive: true });
});

test('a fresh run with no hand-up or restart starts clean; one in its own session keeps both folders', () => {
  const fresh = folders();
  clearFresh({ session: null }, fresh.dir, fresh.home);
  assert.deepEqual([existsSync(fresh.dir), existsSync(fresh.home)], [false, false]);
  rmSync(fresh.root, { recursive: true });
  const own = folders();
  clearFresh({ session: 'its-own' }, own.dir, own.home);
  assert.deepEqual([existsSync(own.dir), existsSync(own.home)], [true, true]);
  rmSync(own.root, { recursive: true });
});

test("a restart's briefing says why it started in its kept clone; a hand-up's gives its note", () => {
  assert.equal(keptCloneLines({ restarted: RESTARTED }, false), `\n\n${RESTARTED}`);
  assert.equal(keptCloneLines({ restarted: RESTARTED }, true), `\n\n${RESTARTED}`, "a review's too");
  assert.match(
    keptCloneLines({ handedUp: { from: 'Sonnet 5.5', note: 'Bigger.' } }, false),
    /^\n\nThis job ran first on Sonnet 5\.5/,
  );
  assert.equal(keptCloneLines({}, false), '');
});
