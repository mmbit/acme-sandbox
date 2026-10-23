// node --test src/seatmoves.test.ts
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { moveSeats, type MoveOps } from './seatmoves.ts';

const made: string[] = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
// A /seats with a login (a file naming the account) in each seat given.
const seats = (logins: Record<string, string>) => {
  const root = mkdtempSync(`${tmpdir()}/seatmoves-`); made.push(root);
  for (const [id, who] of Object.entries(logins)) { mkdirSync(`${root}/${id}`); writeFileSync(`${root}/${id}/login`, who); }
  return root;
};
const login = (root: string, id: string) => existsSync(`${root}/${id}/login`) ? readFileSync(`${root}/${id}/login`, 'utf8') : undefined;
const journal = (root: string) => existsSync(`${root}/moves-done`) ? readFileSync(`${root}/moves-done`, 'utf8') : undefined;
const ops = (o: { fail?: string; read?: MoveOps['read'] } = {}) => {
  const ran: string[] = [], logged: string[] = [];
  const it: MoveOps = {
    read: o.read ?? (p => readFileSync(p, 'utf8')),
    run: (cmd, args) => { ran.push(cmd); if (cmd === o.fail) throw new Error(`${cmd} failed`); return execFileSync(cmd, args); },
    log: (...a) => { logged.push(a.join(' ')); },
  };
  return { ...it, ran, logged };
};
const SPEC = 'b:a,c:b';

test('the logins move in order, each seat\'s own goes, and a second start moves nothing', () => {
  const root = seats({ a: 'personal', b: 'team-1', c: 'team-2' });
  assert.deepEqual(moveSeats(SPEC, root, ops()), []);
  assert.deepEqual([login(root, 'a'), login(root, 'b'), existsSync(`${root}/c`)], ['team-1', 'team-2', false]);
  assert.equal(journal(root), 'moving b:a\nb:a\nmoving c:b\nc:b\n');
  const again = ops();
  assert.deepEqual(moveSeats(SPEC, root, again), []);
  assert.deepEqual(again.ran, []);
  assert.deepEqual([login(root, 'a'), login(root, 'b')], ['team-1', 'team-2']);
});

test('a journal that\'s there but can\'t be read moves nothing and keeps every new seat off', () => {
  const root = seats({ a: 'personal', b: 'team-1', c: 'team-2' });
  moveSeats(SPEC, root, ops());
  // The state the review found: after a full migration b exists again (c's login), so a replay would delete a's.
  const o = ops({ read: () => undefined });
  assert.deepEqual(moveSeats(SPEC, root, o), ['a', 'b']);
  assert.deepEqual(o.ran, []);
  assert.deepEqual([login(root, 'a'), login(root, 'b')], ['team-1', 'team-2']);
  assert.match(o.logged.join('\n'), /can't be read, so nothing moves; off until the next start: a, b/);
});

test('a journal that ends mid-line moves nothing and keeps every new seat off', () => {
  const root = seats({ a: 'personal', b: 'team-1', c: 'team-2' });
  moveSeats('b:a', root, ops());
  // A start whose last write was cut short (disk full): b:a is done, but its line has no end, so the next one would be
  // glued to it ('b:amoving c:b') and a third start would move b:a again over the login it brought.
  writeFileSync(`${root}/moves-done`, 'moving b:a\nb:a');
  const o = ops();
  assert.deepEqual(moveSeats(SPEC, root, o), ['a', 'b']);
  assert.deepEqual(o.ran, []);
  assert.equal(journal(root), 'moving b:a\nb:a');
  assert.deepEqual([login(root, 'a'), login(root, 'c')], ['team-1', 'team-2']);
  assert.match(o.logged.join('\n'), /ends mid-line \(a write cut short\), so nothing moves; off until it's mended: a, b/);
});

test('no journal yet is a first start, not an unreadable one', () => {
  const root = seats({ a: 'personal', b: 'team-1' });
  assert.deepEqual(moveSeats('b:a', root, ops({ read: () => undefined })), []);
  assert.equal(login(root, 'a'), 'team-1');
});

test('an old seat that never was has no login to give, and the new one\'s own still goes', () => {
  const root = seats({ a: 'personal', c: 'team-2' });
  assert.deepEqual(moveSeats(SPEC, root, ops()), []);
  assert.deepEqual([existsSync(`${root}/a`), login(root, 'b')], [false, 'team-2']);
  assert.equal(journal(root), 'b:a\nmoving c:b\nc:b\n');
});

test('a start cut off after its move only writes the pair down, keeping the login it brought', () => {
  const root = seats({ a: 'team-1', c: 'team-2' });
  writeFileSync(`${root}/moves-done`, 'moving b:a\n');
  const o = ops();
  assert.deepEqual(moveSeats(SPEC, root, o), []);
  assert.deepEqual([login(root, 'a'), login(root, 'b')], ['team-1', 'team-2']);
  assert.equal(journal(root), 'moving b:a\nb:a\nmoving c:b\nc:b\n');
});

test('a move that fails stops the rest and keeps their seats off; the next start finishes it', () => {
  const root = seats({ a: 'personal', b: 'team-1', c: 'team-2' });
  const o = ops({ fail: 'mv' });
  assert.deepEqual(moveSeats(SPEC, root, o), ['a', 'b']);
  assert.match(o.logged.join('\n'), /seat move b:a failed; off until the next start: a, b/);
  // The rm ran before the mv failed: the personal login is gone, b still has its own.
  assert.deepEqual([existsSync(`${root}/a`), login(root, 'b'), login(root, 'c')], [false, 'team-1', 'team-2']);
  assert.deepEqual(moveSeats(SPEC, root, ops()), []);
  assert.deepEqual([login(root, 'a'), login(root, 'b')], ['team-1', 'team-2']);
});

test('a pair that isn\'t two seat ids is refused, and it and the ones after it stay off', () => {
  const root = seats({ a: 'personal', b: 'team-1' });
  for (const spec of ['b:shared', 'b:b', '../x:a', 'b:a:c', 'b']) {
    const o = ops();
    assert.equal(moveSeats(`${spec},b:a`, root, o).length, 2, spec);
    assert.deepEqual(o.ran, [], spec);
  }
  assert.equal(login(root, 'b'), 'team-1');
});
