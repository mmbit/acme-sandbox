// node --test src/carryover.test.ts   (uses a throwaway DATA_DIR)
// A pull request's next job goes on in its author's session while it's warm, and starts fresh from the author's closing
// reports once it has gone cold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('carryover');
const { COLD_MS } = await import('./carryover.ts');
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
  assert.deepEqual(fix.resumes, { job: author.id, session: 's-1', seat: null });
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
