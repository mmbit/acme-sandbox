// node --test src/carryover.test.ts   (uses a throwaway DATA_DIR)
// A pull request's next job goes on in its author's session while it's warm on the claiming seat, and starts fresh from
// the author's closing reports once it has gone cold or the claim is another seat's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('carryover');
const { COLD_MS } = await import('./carryover.ts');
const { recordUsage } = await import('./usage.ts');
// A run's usage as the worker reports it, its model's last reply on the main thread at `lastTurn`
const usage = (lastTurn: number) => ({
  models: { 'claude-opus-5-5': { input: 10, cacheWrite: 1000, cacheRead: 5000, output: 100, cost: 0.1 } },
  cost: 0.1,
  lastTurn,
});

test("a fix within the hour of the author's last reply goes on in the author's session", async () => {
  const author = await h.start({ agent: 'kit', title: 'The checkout' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-1', pr: 77, branch, result: 'Built the checkout.' };
  await h.finish(author, { ...done, usage: usage(Date.now() - COLD_MS + 60_000) });

  const fix = await h.start({ agent: 'kit', title: 'Fixing review notes', pr: 77, branch }, { seat: 'claude-1' });
  assert.deepEqual(fix.resumes, { job: author.id, session: 's-1' });
  assert.equal(fix.closingReports, undefined);
});

test("a fix over an hour after the author's last reply starts fresh with the closing reports, though the report came later", async () => {
  // (its push's checks ran between the session's last reply and its report)
  const author = await h.start({ agent: 'kit', title: 'The basket' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-2', pr: 78, branch };
  await h.finish(author, { ...done, result: 'Built the basket.', usage: usage(Date.now() - COLD_MS - 60_000) });
  const first = await h.start({ agent: 'kit', title: 'Fixing review notes', pr: 78, branch }, { seat: 'claude-1' });
  await h.finish(first, { ...done, result: 'Fixed the notes.', usage: usage(Date.now() - COLD_MS - 30_000) });

  const fix = await h.start(
    { agent: 'kit', title: 'Fixing review notes (round 2)', pr: 78, branch },
    { seat: 'claude-1' },
  );
  assert.equal(fix.resumes, undefined);
  assert.deepEqual(fix.closingReports, {
    reports: [
      { job: author.id, report: 'Built the basket.' },
      { job: first.id, report: 'Fixed the notes.' },
    ],
  });
});

test("a fix within the hour claimed by another seat starts fresh with the closing reports: the cache is the seat's", async () => {
  const author = await h.start({ agent: 'kit', title: 'The gift note' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-3', pr: 79, branch, result: 'Built the gift note.' };
  await h.finish(author, { ...done, usage: usage(Date.now() - 60_000) });

  const fix = await h.start({ agent: 'kit', title: 'Fixing review notes', pr: 79, branch }, { seat: 'claude-2' });
  assert.equal(fix.resumes, undefined);
  assert.deepEqual(fix.closingReports, { reports: [{ job: author.id, report: 'Built the gift note.' }] });
});

test('the seat that counts is the one the session last replied on, whichever job ran it', async () => {
  const author = await h.start({ agent: 'kit', title: 'The wrapping' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-4', pr: 80, branch };
  await h.finish(author, { ...done, result: 'Built the wrapping.', usage: usage(Date.now() - 120_000) });
  // (the session went on on the second seat after the author's last reply: the newest last_turn row decides, not the author's)
  const first = await h.start({ agent: 'kit', title: 'Fixing review notes', pr: 80, branch }, { seat: 'claude-2' });
  await h.finish(first, { ...done, result: 'Fixed the notes.', usage: usage(Date.now() - 60_000) });

  const fix = await h.start(
    { agent: 'kit', title: 'Fixing review notes (round 2)', pr: 80, branch },
    { seat: 'claude-2' },
  );
  assert.deepEqual(fix.resumes, { job: first.id, session: 's-4' });
  assert.equal(fix.closingReports, undefined);
});

test('a fix within the hour of a last reply with no seat on record starts fresh with the closing reports', async () => {
  const author = await h.start({ agent: 'kit', title: 'The ribbon' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-5', pr: 81, branch, result: 'Built the ribbon.' };
  await h.finish(author, done);
  // (a run whose usage came in with no seat: nothing says its cache is the claiming seat's)
  recordUsage({ job: author.id, engine: author.engine, session: 's-5', seat: null, usage: usage(Date.now() - 60_000) });

  const fix = await h.start({ agent: 'kit', title: 'Fixing review notes', pr: 81, branch }, { seat: 'claude-1' });
  assert.equal(fix.resumes, undefined);
  assert.deepEqual(fix.closingReports, { reports: [{ job: author.id, report: 'Built the ribbon.' }] });
});
