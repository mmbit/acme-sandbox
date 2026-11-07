// node --test src/carryover.test.ts   (uses a throwaway DATA_DIR)
// Claude fixes start from closing reports. Other branch jobs inherit only a session warm on the claiming seat.
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

test("a follow-up within the hour of the author's last reply goes on in the author's session", async () => {
  const author = await h.start({ agent: 'kit', title: 'The checkout' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-1', pr: 77, branch, result: 'Built the checkout.' };
  await h.finish(author, { ...done, usage: usage(Date.now() - COLD_MS + 60_000) });

  const followUp = await h.start(
    { agent: 'kit', title: 'Touch up the checkout', pr: 77, branch },
    { seat: 'claude-1' },
  );
  assert.deepEqual(followUp.resumes, { job: author.id, session: 's-1' });
  assert.equal(followUp.closingReports, undefined);
});

test("a follow-up over an hour after the author's last reply starts fresh with the closing reports, though the report came later", async () => {
  // (its push's checks ran between the session's last reply and its report)
  const author = await h.start({ agent: 'kit', title: 'The basket' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-2', pr: 78, branch };
  await h.finish(author, { ...done, result: 'Built the basket.', usage: usage(Date.now() - COLD_MS - 60_000) });
  const first = await h.start({ agent: 'kit', title: 'Touch up the basket', pr: 78, branch }, { seat: 'claude-1' });
  await h.finish(first, { ...done, result: 'Touched up the basket.', usage: usage(Date.now() - COLD_MS - 30_000) });

  const followUp = await h.start(
    { agent: 'kit', title: 'Touch up the basket again', pr: 78, branch },
    { seat: 'claude-1' },
  );
  assert.equal(followUp.resumes, undefined);
  assert.deepEqual(followUp.closingReports, {
    reports: [
      { job: author.id, report: 'Built the basket.' },
      { job: first.id, report: 'Touched up the basket.' },
    ],
  });
});

test("a follow-up within the hour claimed by another seat starts fresh with the closing reports: the cache is the seat's", async () => {
  const author = await h.start({ agent: 'kit', title: 'The gift note' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-3', pr: 79, branch, result: 'Built the gift note.' };
  await h.finish(author, { ...done, usage: usage(Date.now() - 60_000) });

  const followUp = await h.start(
    { agent: 'kit', title: 'Touch up the gift note', pr: 79, branch },
    { seat: 'claude-2' },
  );
  assert.equal(followUp.resumes, undefined);
  assert.deepEqual(followUp.closingReports, { reports: [{ job: author.id, report: 'Built the gift note.' }] });
});

test('the seat that counts is the one the session last replied on, whichever job ran it', async () => {
  const author = await h.start({ agent: 'kit', title: 'The wrapping' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-4', pr: 80, branch };
  await h.finish(author, { ...done, result: 'Built the wrapping.', usage: usage(Date.now() - 120_000) });
  // (the session went on on the second seat after the author's last reply: the newest last_turn row decides, not the author's)
  const first = await h.start({ agent: 'kit', title: 'Touch up the wrapping', pr: 80, branch }, { seat: 'claude-2' });
  await h.finish(first, { ...done, result: 'Touched up the wrapping.', usage: usage(Date.now() - 60_000) });

  const followUp = await h.start(
    { agent: 'kit', title: 'Touch up the wrapping again', pr: 80, branch },
    { seat: 'claude-2' },
  );
  assert.deepEqual(followUp.resumes, { job: first.id, session: 's-4' });
  assert.equal(followUp.closingReports, undefined);
});

test('a follow-up within the hour of a last reply with no seat on record starts fresh with the closing reports', async () => {
  const author = await h.start({ agent: 'kit', title: 'The ribbon' }, { seat: 'claude-1' });
  const branch = `job/${author.id}`;
  const done = { status: 'done', session: 's-5', pr: 81, branch, result: 'Built the ribbon.' };
  await h.finish(author, done);
  // (a run whose usage came in with no seat: nothing says its cache is the claiming seat's)
  recordUsage({ job: author.id, engine: author.engine, session: 's-5', seat: null, usage: usage(Date.now() - 60_000) });

  const followUp = await h.start({ agent: 'kit', title: 'Touch up the ribbon', pr: 81, branch }, { seat: 'claude-1' });
  assert.equal(followUp.resumes, undefined);
  assert.deepEqual(followUp.closingReports, { reports: [{ job: author.id, report: 'Built the ribbon.' }] });
});

for (const [fix, round] of [
  ['a send-back or conflict repair', null],
  ["a review round's fix", 2],
] as const) {
  test(`${fix} on Claude starts from the closing reports, even on a warm seat`, async () => {
    const author = await h.start({ agent: 'kit', engine: 'claude', title: 'The delivery note' }, { seat: 'claude-1' });
    const branch = `job/${author.id}`;
    const done = { session: `delivery-${author.id}`, pr: 82, branch, usage: usage(Date.now()) };
    await h.finish(author, { ...done, result: 'Built the delivery note.' });
    const first = await h.start(
      { agent: 'kit', engine: 'claude', title: 'Fix the note', stage: 'fix', round, pr: 82, branch },
      { seat: 'claude-1' },
    );
    await h.finish(first, { ...done, session: `fix-${author.id}`, result: 'Fixed the delivery note.' });
    const next = await h.start(
      { agent: 'kit', engine: 'claude', title: 'Check the note', stage: 'fix', round, pr: 82, branch },
      { seat: 'claude-1' },
    );
    await h.finish(next, { result: 'Checked the delivery note.' });
    assert.equal(first.resumes, undefined);
    assert.deepEqual(first.closingReports, { reports: [{ job: author.id, report: 'Built the delivery note.' }] });
    assert.equal(next.resumes, undefined);
    assert.deepEqual(next.closingReports, {
      reports: [
        { job: author.id, report: 'Built the delivery note.' },
        { job: first.id, report: 'Fixed the delivery note.' },
      ],
    });
  });
}

test('a yielded Claude fix keeps its own session and unfinished work', async () => {
  const fix = await h.start({ agent: 'kit', engine: 'claude', stage: 'fix', pr: 83, branch: 'review/83' });
  await h.finish(fix, { status: 'yielded', session: 'unfinished-fix' });
  const again = await h.claim('claude', { seat: fix.seat, kind: 'work' });
  assert.equal(again?.id, fix.id);
  assert.equal(again.session, 'unfinished-fix');
  assert.equal(again.resumes, undefined);
  assert.equal(again.closingReports, undefined);
  await h.finish(again);
});

test("a warm Codex fix still goes on in its author's session", async () => {
  const author = await h.start({ agent: 'kit', engine: 'codex', title: 'The receipt' }, { seat: 'codex-1' });
  const branch = `job/${author.id}`;
  await h.finish(author, {
    session: 'receipt',
    pr: 84,
    branch,
    result: 'Built the receipt.',
    usage: usage(Date.now()),
  });
  const fix = await h.start({ agent: 'kit', engine: 'codex', stage: 'fix', pr: 84, branch }, { seat: 'codex-1' });
  assert.deepEqual(fix.resumes, { job: author.id, session: 'receipt' });
  assert.equal(fix.closingReports, undefined);
  await h.finish(fix);
});
