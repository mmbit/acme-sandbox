// node --test src/copyback.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handOut, masked, type Files, type Folders, type Snap } from './copyback.ts';

const INDEX = '# Memory index\n\n- [A](a.md) — a\n';
const SHARED = { 'MEMORY.md': INDEX, 'a.md': 'a\n', 'b.md': 'b\n' };

// The worker's two folders, in memory: the shared memory and one job's copy.
function folders(shared: Record<string, string>) {
  const f = { shared: new Map(Object.entries(shared)) as Files, copy: undefined as Files | undefined, notes: [] as string[] };
  const snap = (m: Files): Snap => ({ files: new Map(m), names: new Set(m.keys()) });
  const io: Folders = {
    shared: () => snap(f.shared),
    copy: () => f.copy && snap(f.copy),
    setCopy: files => { f.copy = files ? new Map(files) : undefined; },
    log: note => f.notes.push(note),
  };
  return { f, io };
}

// What a job wrote down after reading a care case (fictional details).
const read = (copy: Files) => { copy.set('a.md', 'a, with the case\'s address\n'); copy.set('case.md', 'Jan Jansen, Kerkstraat 1\n'); copy.delete('b.md'); };

test('a job with no copy yet is handed the shared memory', () => {
  const { f, io } = folders(SHARED);
  handOut(io);
  assert.deepEqual(Object.fromEntries(f.copy!), SHARED);
});

test("what a job writes in its memory stays with it when it resumes: another job's hand-out never reads it", () => {
  const { f, io } = folders(SHARED);
  handOut(io);
  read(f.copy!);
  const mine = Object.fromEntries(f.copy!);
  handOut(io);                                         // the job resumes (after a pause, a restart cut off its run, a fix round)
  assert.deepEqual(Object.fromEntries(f.copy!), mine);
  assert.deepEqual(Object.fromEntries(f.shared), SHARED);
  const other = folders(Object.fromEntries(f.shared));  // an unrelated job, handed the shared memory now
  handOut(other.io);
  assert.deepEqual(Object.fromEntries(other.f.copy!), SHARED);
});

test('a hand-out cut short leaves the shared memory as it was', () => {
  const { f, io } = folders(SHARED);
  io.setCopy = () => { throw new Error('No space left on device'); };
  assert.throws(() => handOut(io), /No space/);        // prepareHome logs it and the job runs anyway
  assert.deepEqual(Object.fromEntries(f.shared), SHARED);
});

// A key's value written into the shared memory before it was saved as a key: the coordinator's mask, played here.
const KEY = 'sk-live-0123456789abcdef';
const mask = async (text: string) => text.replaceAll(KEY, '[STRIPE_SECRET_KEY]');

test("a job with no copy yet is handed the shared memory masked: a key's value in it reaches the job only as its name", async () => {
  const { f, io } = folders({ 'MEMORY.md': INDEX, 'a.md': `stripe: ${KEY}\n` });
  handOut((await masked(io, mask))!);
  assert.equal(f.copy!.get('a.md'), 'stripe: [STRIPE_SECRET_KEY]\n');
  assert.equal(f.shared.get('a.md'), `stripe: ${KEY}\n`);
});

test('a shared file another job changes while the memory is being masked is left out of the hand-out, never handed out unmasked', async () => {
  const { f, io } = folders({ 'a.md': 'a\n', 'b.md': 'b\n' });
  const out = (await masked(io, mask))!;
  f.shared.set('b.md', `b, and ${KEY}\n`);
  handOut(out);
  assert.deepEqual(Object.fromEntries(f.copy!), { 'a.md': 'a\n' });
});

test("a job's own copy holding a value saved as a key since is written again, masked, as the job resumes; an unchanged one isn't", async () => {
  const { f, io } = folders(SHARED);
  handOut(io);
  f.copy!.set('a.md', `stripe: ${KEY}\n`);                // the job wrote it down before the board saved it as a key
  let writes = 0;
  const setCopy = io.setCopy;
  io.setCopy = files => { writes++; setCopy(files); };
  handOut((await masked(io, mask))!);
  assert.equal(f.copy!.get('a.md'), 'stripe: [STRIPE_SECRET_KEY]\n');
  assert.equal(f.copy!.get('b.md'), 'b\n');
  assert.equal(writes, 1);
  handOut((await masked(io, mask))!);                    // nothing left to mask: the copy on disk is left alone
  assert.equal(writes, 1);
});

test("a resumed job's copy holding a value saved as a key since is removed when the mask fails: the job starts with none", async () => {
  const { f, io } = folders(SHARED);
  handOut(io);
  f.copy!.set('a.md', `stripe: ${KEY}\n`);
  assert.equal(await masked(io, async () => { throw new Error('coordinator 502'); }), null);
  assert.equal(f.copy, undefined);
});

test("a copy the failed mask can't remove throws, so the job doesn't start with it", async () => {
  const { f, io } = folders(SHARED);
  handOut(io);
  f.copy!.set('a.md', `stripe: ${KEY}\n`);
  io.setCopy = () => { throw new Error('Permission denied'); };
  await assert.rejects(masked(io, async () => { throw new Error('coordinator 502'); }), /Permission denied/);
});
