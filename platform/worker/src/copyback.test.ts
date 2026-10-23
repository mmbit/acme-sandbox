// node --test src/copyback.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyBack, giveBack, handOut, masked, union, type Files, type Folders, type Snap } from './copyback.ts';

// A folder snapshot; `unread` names are there but weren't read (past the first 500).
const files = (o: Record<string, string>, unread: string[] = []) => ({ files: new Map(Object.entries(o)), names: new Set([...Object.keys(o), ...unread]) });
const INDEX = '# Memory index\n\n- [A](a.md) — a\n';

test("an unchanged file doesn't go back, so it can't undo another job's edit", () => {
  const start = files({ 'MEMORY.md': INDEX, 'a.md': 'old\n' });
  const shared = files({ 'MEMORY.md': INDEX, 'a.md': 'edited by a later job\n' });
  const plan = copyBack(start, start, shared);
  assert.deepEqual([...plan.write], []);
  assert.deepEqual(plan.remove, []);
});

test('a changed or new file goes back when nobody else touched it', () => {
  const start = files({ 'a.md': 'old\n' });
  const plan = copyBack(start, files({ 'a.md': 'new\n', 'b.md': 'b\n' }), files({ 'a.md': 'old\n' }));
  assert.deepEqual(Object.fromEntries(plan.write), { 'a.md': 'new\n', 'b.md': 'b\n' });
});

test('index lines two jobs added at the same time are both kept', () => {
  const start = files({ 'MEMORY.md': INDEX });
  const mine = files({ 'MEMORY.md': `${INDEX}- [Mine](mine.md) — mine\n`, 'mine.md': 'm\n' });
  const shared = files({ 'MEMORY.md': `${INDEX}- [Theirs](theirs.md) — theirs\n`, 'theirs.md': 't\n' });
  const plan = copyBack(start, mine, shared);
  assert.equal(plan.write.get('MEMORY.md'), `${INDEX}- [Mine](mine.md) — mine\n- [Theirs](theirs.md) — theirs\n`);
  assert.equal(plan.write.get('mine.md'), 'm\n');
  assert.ok(!plan.write.has('theirs.md'));
});

test('edits to different parts of one file merge cleanly', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n';
  const plan = copyBack(files({ 'a.md': base }), files({ 'a.md': base.replace('one', 'ONE') }), files({ 'a.md': base.replace('five', 'FIVE') }));
  assert.equal(plan.write.get('a.md'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
});

test('a deletion carries over, only for a file the job started with and nobody changed since', () => {
  const start = files({ 'a.md': 'a\n', 'b.md': 'b\n', 'keep.md': 'k\n' });
  const shared = files({ 'a.md': 'a\n', 'b.md': 'b changed by another job\n', 'keep.md': 'k\n', 'later.md': 'l\n' });
  const plan = copyBack(start, files({ 'keep.md': 'k\n' }), shared);
  assert.deepEqual(plan.remove, ['a.md']);                 // not b.md (changed since), not later.md (not the job's)
  assert.match(plan.notes.join('\n'), /b\.md deleted here but changed by another job since: kept/);
});

test('a copy that is empty at the end deletes nothing', () => {
  const start = files({ 'a.md': 'a\n' });
  assert.deepEqual(copyBack(start, files({}), start).remove, []);
});

test('a copy that began empty gives back all it made, merged with what the shared memory has, and deletes nothing', () => {
  const plan = copyBack(files({}), files({ 'a.md': 'mine\n', 'b.md': 'b\n' }), files({ 'a.md': 'theirs\n', 'c.md': 'c\n' }));
  assert.deepEqual(Object.fromEntries(plan.write), { 'a.md': 'mine\ntheirs\n', 'b.md': 'b\n' });
  assert.deepEqual(plan.remove, []);
});

test('a file over 64,000 characters is not kept, and says so', () => {
  const plan = copyBack(files({}), files({ 'big.md': 'x'.repeat(64_001) }), files({}));
  assert.equal(plan.write.size, 0);
  assert.match(plan.notes[0], /big\.md not kept \(64001 characters, over 64,000\)/);
});

test('a merge that fails keeps both sides', () => {
  const plan = copyBack(files({ 'a.md': 'a\n' }), files({ 'a.md': 'mine\n' }), files({ 'a.md': 'theirs\n' }), () => { throw new Error('no git'); });
  assert.equal(plan.write.get('a.md'), 'theirs\n\nmine\n');
});

test('union: a clash keeps both lines, no conflict markers; a missing final newline is fine', () => {
  assert.equal(union('a\nmine', 'a\nbase\n', 'a\ntheirs\n'), 'a\nmine\ntheirs\n');
  assert.equal(union('x\n', '', 'y\n'), 'x\ny\n');
});

test("a shared file that wasn't read isn't taken for missing, so it isn't overwritten", () => {
  const plan = copyBack(files({ 'z.md': 'base\n' }), files({ 'z.md': 'mine\n' }), files({}, ['z.md']));
  assert.deepEqual([...plan.write], []);
  assert.match(plan.notes.join('\n'), /z\.md couldn't be read in the shared memory: not kept/);
});

test("a file unread at the start isn't taken for new, so it can't undo a later edit", () => {
  const plan = copyBack(files({}, ['z.md']), files({ 'z.md': 'old\n' }), files({ 'z.md': 'edited by a later job\n' }));
  assert.deepEqual([...plan.write], []);
  assert.match(plan.notes.join('\n'), /z\.md unknown at the start/);
});

test("files past the first 500 aren't taken for deleted, in the job's copy or the shared memory", () => {
  const start = files({ 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
  const plan = copyBack(start, files({ 'c.md': 'c\n' }, ['a.md']), files({ 'a.md': 'a\n', 'c.md': 'c\n' }, ['b.md']));
  assert.deepEqual(plan.remove, []);
  assert.match(plan.notes.join('\n'), /b\.md deleted here but couldn't be read in the shared memory: kept/);
  assert.match(plan.notes.join('\n'), /1 files in the copy past the first 500 or unreadable, not kept: a\.md/);
});

// The worker's three folders, in memory: `copy` is the job's, `start` the keeper's (it outlives a restart).
function folders(shared: Record<string, string>) {
  const f = { shared: new Map(Object.entries(shared)) as Files, copy: undefined as Files | undefined, start: undefined as Snap | undefined, notes: [] as string[] };
  const snap = (m: Files): Snap => ({ files: new Map(m), names: new Set(m.keys()) });
  const io: Folders = {
    shared: () => snap(f.shared),
    readShared: n => f.shared.get(n),
    copy: () => f.copy && snap(f.copy),
    start: () => f.start,
    keep: plan => { for (const [n, t] of plan.write) f.shared.set(n, t); for (const n of plan.remove) f.shared.delete(n); },
    setCopy: files => { f.copy = files ? new Map(files) : undefined; },
    setStart: s => { f.start = s ? snap(s.files) : undefined; },
    log: note => f.notes.push(note),
  };
  return { f, io };
}

test("a job's copy is written from the same read as its start", () => {
  const { f, io } = folders({ 'a.md': 'a\n' });
  handOut(io, false);
  assert.deepEqual(f.copy, f.start!.files);
  assert.deepEqual([...f.copy!], [['a.md', 'a\n']]);
});

test('a file kept in a paused copy and deleted from the shared memory meanwhile stays deleted', () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'old.md': 'o\n' });
  handOut(io, false);
  f.copy!.set('mine.md', 'm\n');
  giveBack(io, false);                                        // the run pauses (limited, waiting for the board)
  assert.equal(f.copy, undefined);
  f.shared.delete('old.md');                           // another job merges it away meanwhile
  handOut(io, false);                                         // the job resumes
  giveBack(io, false);
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a\n', 'mine.md': 'm\n' });
});

test('a run cut off by a restart gives back what it changed when it resumes, and nothing else', () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'old.md': 'o\n' });
  handOut(io, false);
  f.copy!.set('mine.md', 'm\n');                      // then a deploy: no end seen, the copy and its start stay
  f.shared.delete('old.md');
  f.shared.set('a.md', 'a edited by another job\n');
  handOut(io, false);
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a edited by another job\n', 'mine.md': 'm\n' });
  assert.deepEqual(Object.fromEntries(f.copy!), Object.fromEntries(f.shared));
});

test('a copy left with no start kept gives nothing back, so it brings nothing deleted back', () => {
  const { f, io } = folders({ 'a.md': 'a\n' });
  f.copy = new Map([['a.md', 'a\n'], ['old.md', 'o\n']]);   // from a worker that kept starts only in its memory
  handOut(io, false);
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a\n' });
  assert.deepEqual(Object.fromEntries(f.copy!), { 'a.md': 'a\n' });
  assert.match(f.notes.join('\n'), /no start kept/);
});

// A job handed a customer's own details.
const SHARED = { 'MEMORY.md': INDEX, 'a.md': 'a\n', 'b.md': 'b\n' };
const edit = (copy: Files) => { copy.set('a.md', 'a, with a customer\'s address\n'); copy.set('new.md', 'Jan Jansen, Kerkstraat 1\n'); copy.delete('b.md'); };

test("a job that holds a customer's details as it starts gives nothing back, changed, new or deleted, and keeps its copy for its next run", () => {
  const { f, io } = folders(SHARED);
  handOut(io, true);
  assert.deepEqual(Object.fromEntries(f.copy!), SHARED);
  edit(f.copy!);
  const mine = Object.fromEntries(f.copy!);
  giveBack(io, true);                                  // the run pauses (waiting for the board)
  handOut(io, true);                                   // and resumes
  giveBack(io, true);
  assert.deepEqual(Object.fromEntries(f.shared), SHARED);
  assert.deepEqual(Object.fromEntries(f.copy!), mine);
  assert.equal(f.start, undefined);
});

test("a job handed a customer's details while it runs gives nothing back at its end, nor at a later run", () => {
  const { f, io } = folders(SHARED);
  handOut(io, false);
  edit(f.copy!);                                       // then it reads a customer's mail
  giveBack(io, true);
  assert.equal(f.start, undefined);
  handOut(io, true);
  giveBack(io, true);
  assert.deepEqual(Object.fromEntries(f.shared), SHARED);
});

test("a run cut off by a restart gives nothing back when its job resumes holding a customer's details", () => {
  const { f, io } = folders(SHARED);
  handOut(io, false);
  edit(f.copy!);                                       // it reads a customer's mail, then a deploy: no end seen, the copy and its start stay
  handOut(io, true);
  giveBack(io, true);
  assert.deepEqual(Object.fromEntries(f.shared), SHARED);
});

// A hand-out that fails writing the copy: `after` files are written first (0: the copy is emptied, then the throw).
function failingCopy(io: Folders, after: number) {
  const setCopy = io.setCopy;
  io.setCopy = files => {
    if (!files) return setCopy(null);
    setCopy(new Map([...files].slice(0, after)));
    throw new Error('No space left on device');
  };
  return () => { io.setCopy = setCopy; };
}

for (const after of [0, 1]) test(`a hand-out cut short (${after} of 4 files copied) leaves no copy and an empty start, so the job's end deletes nothing`, () => {
  const { f, io } = folders({ 'MEMORY.md': INDEX, 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
  const restore = failingCopy(io, after);
  assert.throws(() => handOut(io, false), /No space/);        // prepareHome logs it and the job runs anyway
  restore();
  assert.equal(f.copy, undefined);
  assert.equal(f.start?.names.size, 0);
  (f.copy ??= new Map()).set('new.md', 'n\n');          // what the job writes in its memory folder
  giveBack(io, false);
  assert.deepEqual(Object.fromEntries(f.shared), { 'MEMORY.md': INDEX, 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n', 'new.md': 'n\n' });
  assert.equal(f.start, undefined);
});

test('a resumed run whose new copy fails gives back the old run, then deletes nothing at its end', () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'b.md': 'b\n' });
  handOut(io, false);
  f.copy!.set('mine.md', 'm\n');                      // then a restart: the copy and its start stay
  const restore = failingCopy(io, 0);
  assert.throws(() => handOut(io, false), /No space/);
  restore();
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a\n', 'b.md': 'b\n', 'mine.md': 'm\n' });
  (f.copy ??= new Map()).set('new.md', 'n\n');
  giveBack(io, false);
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a\n', 'b.md': 'b\n', 'mine.md': 'm\n', 'new.md': 'n\n' });
});

test('a leftover copy whose give-back fails partway is given back again at the end, and nothing is lost or undone', () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'b.md': 'b\n' });
  handOut(io, false);
  f.copy!.set('a.md', 'a mine\n');
  f.copy!.set('mine.md', 'm\n');                      // then a restart
  const keep = io.keep;
  io.keep = plan => { f.shared.set('a.md', plan.write.get('a.md')!); throw new Error('No space left on device'); };
  assert.throws(() => handOut(io, false), /No space/);        // a.md went back, mine.md didn't; the old copy and start stay
  io.keep = keep;
  f.shared.set('b.md', 'b edited by another job\n');
  giveBack(io, false);                                        // the run's end: the old copy again, against its old start
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a mine\n', 'b.md': 'b edited by another job\n', 'mine.md': 'm\n' });
  assert.equal(f.copy, undefined);
});

// A removal of the copy that fails partway: `left` files stay, then the throw (a restart, a folder the job locked).
// Writing a new copy removes the old one first, so it fails the same way.
function failingRemove(io: Folders, f: { copy?: Files }, left: number, times = 1) {
  const setCopy = io.setCopy;
  io.setCopy = files => {
    if (!f.copy || !times) return setCopy(files);
    times--;
    f.copy = new Map([...f.copy].slice(0, left));
    throw new Error('Permission denied');
  };
  return () => { io.setCopy = setCopy; };
}

test("a copy whose removal is cut short is never given back against its start, so nothing it lost is deleted", () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
  handOut(io, false);
  const restore = failingRemove(io, f, 1);
  assert.throws(() => giveBack(io, false), /Permission denied/);   // the job changed nothing; a.md stays in its copy
  restore();
  assert.equal(f.start, undefined);
  handOut(io, false);                                              // the next run: the leftover copy is replaced
  giveBack(io, false);
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
  assert.match(f.notes.join('\n'), /no start kept/);
});

test("a copy that can't be removed at all gives nothing back, so it brings back nothing another job deleted", () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
  handOut(io, false);
  failingRemove(io, f, 2, Infinity);                        // a folder the job locked: every removal throws, a.md, b.md stay
  assert.throws(() => giveBack(io, false), /Permission denied/);
  assert.equal(f.start, undefined);
  f.shared.delete('b.md');                                  // another job deletes it meanwhile (it held a secret, say)
  assert.throws(() => handOut(io, false), /Permission denied/);    // prepareHome logs it and the job runs with the old folder
  assert.equal(f.start, undefined);
  f.copy!.set('new.md', 'n\n');
  const plans: string[][] = [], keep = io.keep;
  io.keep = plan => { plans.push(plan.remove); keep(plan); };
  assert.throws(() => giveBack(io, false), /Permission denied/);
  assert.deepEqual(plans, []);
  assert.deepEqual(Object.fromEntries(f.shared), { 'a.md': 'a\n', 'c.md': 'c\n' });
  assert.match(f.notes.join('\n'), /no start kept for it: removed, nothing from it went back/);
});

// A key's value written into the shared memory before it was saved as a key: the coordinator's mask, played here.
const KEY = 'sk-live-0123456789abcdef';
const mask = async (text: string) => text.replaceAll(KEY, '[STRIPE_SECRET_KEY]');

test("a job with no copy yet is handed the shared memory masked: a key's value in it reaches the job only as its name", async () => {
  const { f, io } = folders({ 'MEMORY.md': INDEX, 'a.md': `stripe: ${KEY}\n` });
  handOut((await masked(io, mask))!, false);
  assert.equal(f.copy!.get('a.md'), 'stripe: [STRIPE_SECRET_KEY]\n');
  giveBack((await masked(io, mask))!, false);              // the job changed nothing: the shared file is left as it was
  assert.equal(f.shared.get('a.md'), `stripe: ${KEY}\n`);
});

test('a shared file another job changes while the memory is being masked is left out of the hand-out, never handed out unmasked', async () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'b.md': 'b\n' });
  const out = (await masked(io, mask))!;
  f.shared.set('b.md', `b, and ${KEY}\n`);
  handOut(out, false);
  assert.deepEqual(Object.fromEntries(f.copy!), { 'a.md': 'a\n' });
});

test("a customer job's own copy holding a value saved as a key since is written again, masked, as the job resumes; an unchanged one isn't", async () => {
  const { f, io } = folders(SHARED);
  handOut(io, true);
  f.copy!.set('a.md', `stripe: ${KEY}\n`);                // the job wrote it down before the board saved it as a key
  let writes = 0;
  const setCopy = io.setCopy;
  io.setCopy = files => { writes++; setCopy(files); };
  handOut((await masked(io, mask))!, true);
  assert.equal(f.copy!.get('a.md'), 'stripe: [STRIPE_SECRET_KEY]\n');
  assert.equal(f.copy!.get('b.md'), 'b\n');
  assert.equal(writes, 1);
  handOut((await masked(io, mask))!, true);              // nothing left to mask: the copy on disk is left alone
  assert.equal(writes, 1);
});

test("a resumed job's copy holding a value saved as a key since is removed when the mask fails: the job starts with none", async () => {
  const { f, io } = folders(SHARED);
  handOut(io, true);
  f.copy!.set('a.md', `stripe: ${KEY}\n`);
  assert.equal(await masked(io, async () => { throw new Error('coordinator 502'); }), null);
  assert.equal(f.copy, undefined);
  assert.equal(f.start, undefined);
});

test("a copy the failed mask can't remove throws, so the job doesn't start with it", async () => {
  const { f, io } = folders(SHARED);
  handOut(io, false);
  f.copy!.set('a.md', `stripe: ${KEY}\n`);
  io.setCopy = () => { throw new Error('Permission denied'); };
  await assert.rejects(masked(io, async () => { throw new Error('coordinator 502'); }), /Permission denied/);
});
