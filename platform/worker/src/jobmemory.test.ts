// node --test src/jobmemory.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remask, type Files, type Folders } from './jobmemory.ts';

// One job's memory folder, in memory, and how often the worker wrote it.
// An unlistable one (the job chmod'ed it 100) is there but reads as none.
function folder(copy?: Record<string, string>, { unlistable = false } = {}) {
  const f = { copy: copy && (new Map(Object.entries(copy)) as Files), writes: 0, notes: [] as string[] };
  const io: Folders = {
    copy: () => (unlistable ? undefined : f.copy && new Map(f.copy)),
    setCopy: files => {
      f.writes++;
      f.copy = files ? new Map(files) : undefined;
    },
    log: note => f.notes.push(note),
  };
  return { f, io };
}

// A key's value a job wrote down before it was saved as a key: the coordinator's mask, played here.
const KEY = 'sk-live-0123456789abcdef';
const mask = async (text: string) => text.replaceAll(KEY, '[STRIPE_SECRET_KEY]');

test('a job starts with no memory: nothing is handed out', async () => {
  const { f, io } = folder();
  await remask(io, mask);
  assert.equal(f.copy, undefined);
  assert.equal(f.writes, 1); // a removal of the folder that isn't there, so nothing changes
});

test("a resumed job's copy it can't list is removed, unmasked values with it: the job starts with none", async () => {
  const { f, io } = folder({ 'MEMORY.md': `stripe: ${KEY}\n` }, { unlistable: true });
  await remask(io, mask);
  assert.equal(f.copy, undefined);
  assert.equal(f.writes, 1);
});

test("a resumed job keeps its own copy as it was; an unchanged one isn't written again", async () => {
  const { f, io } = folder({ 'MEMORY.md': '# Memory index\n', 'a.md': 'a\n' });
  await remask(io, mask); // the job resumes (after a pause, a restart cut off its run, a fix round)
  assert.deepEqual(Object.fromEntries(f.copy!), { 'MEMORY.md': '# Memory index\n', 'a.md': 'a\n' });
  assert.equal(f.writes, 0);
});

test("a job's own copy holding a value saved as a key since is written again, masked, as the job resumes", async () => {
  const { f, io } = folder({ 'a.md': `stripe: ${KEY}\n`, 'b.md': 'b\n' });
  await remask(io, mask);
  assert.deepEqual(Object.fromEntries(f.copy!), { 'a.md': 'stripe: [STRIPE_SECRET_KEY]\n', 'b.md': 'b\n' });
  assert.equal(f.writes, 1);
  await remask(io, mask); // nothing left to mask: the copy on disk is left alone
  assert.equal(f.writes, 1);
});

test("a resumed job's copy is removed when the mask fails: the job starts with none", async () => {
  const { f, io } = folder({ 'a.md': `stripe: ${KEY}\n` });
  await remask(io, async () => {
    throw new Error('coordinator 502');
  });
  assert.equal(f.copy, undefined);
  assert.match(f.notes[0]!, /coordinator 502/);
});

test("a copy the failed mask can't remove throws, so the job doesn't start with it", async () => {
  const { io } = folder({ 'a.md': `stripe: ${KEY}\n` });
  io.setCopy = () => {
    throw new Error('Permission denied');
  };
  await assert.rejects(
    remask(io, async () => {
      throw new Error('coordinator 502');
    }),
    /Permission denied/,
  );
});
