// node --test src/attempts.test.ts: a job's attempts are its failed or abandoned runs in a row, not every run it ever
// had: a long life of clean runs must not read as "5 attempts" and stop a job at a deploy. (The two intercom tests guard
// a new turn starting its count over; the rest fail on a count that never resets.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Running } from './harness.ts';

const h = await harness('attempts');
const { board, finish } = h;

// A run of the job, on its engine's next claim (a spare seat: a downtime job starts too). The wait before a retry has
// passed: no route moves the clock.
const run = async (id: number, engine: string) => {
  h.db.prepare('update jobs set not_before = 0 where id = ?').run(id);
  const job = await h.claim(engine, { util: 0, ...engine === 'claude' ? { kind: 'chat' } : {} });
  assert.equal(job?.id, id, `job #${id} is the one claimed`);
  return job!;
};
// The worker went away mid-run (a deploy, a crash) without reporting: ten minutes on its heartbeat is stale, and the
// next claim sees it.
const abandon = async (job: Running) => {
  h.db.prepare('update jobs set heartbeat = 0 where id = ?').run(job.id);
  await h.claim('nothing-here');
};
const say = async (text: string) => assert.equal((await board('/api/chat', { text })).status, 200);
let intercom = 0;   // the intercom's job: the same one, turn after turn

test('an intercom that answered many turns survives a restart that cuts off its next turn', async () => {
  await say('Turn 1');
  let turn = (await h.claim('claude', { kind: 'chat' }))!;
  intercom = turn.id;
  for (let n = 1; n <= 6; n++) {
    await finish(turn, { result: `Answer ${n}` });
    await say(`Turn ${n + 1}`);
    turn = await run(turn.id, 'claude');
  }
  await abandon(turn);
  assert.deepEqual([h.job(turn.id).status, h.job(turn.id).attempts], ['queued', 1], 'handed back, not given up');
});

test('a failed intercom turn after many good ones is tried again, not given up on', async () => {
  await say('Hello');
  let turn = await run(intercom, 'claude');
  for (let n = 1; n <= 3; n++) { await finish(turn, { result: 'Hi' }); await say('And?'); turn = await run(turn.id, 'claude'); }
  await finish(turn, { status: 'failed', result: 'the CLI crashed' });
  assert.equal(h.job(turn.id).status, 'queued', 'the same turn is tried again');
  assert.ok(h.job(turn.id).until > Date.now(), 'after a short wait');
});

test('a job parked, paused and resumed many times still gets its full retries', async () => {
  const id = h.queue({ agent: 'kit', engine: 'many', title: 'Follow up on your call with the board', downtime: true });
  for (let i = 0; i < 3; i++) {
    const job = await run(id, 'many');
    await h.answer(await h.park(job, { kind: 'decision', title: `Question ${i}` }), 'The second one.');
  }
  for (let i = 0; i < 3; i++) await finish(await run(id, 'many'), { status: 'interrupted' });
  await finish(await run(id, 'many'), { status: 'limited', resetAt: 0 });
  await finish(await run(id, 'many'), { status: 'yielded' });
  await abandon(await run(id, 'many'));
  assert.equal(h.job(id).status, 'queued', 'one abandoned run after ten clean ones is not the end');
});

test('five abandoned runs in a row give up, visibly', async () => {
  const id = h.queue({ agent: 'kit', engine: 'crashes', title: 'Crashes every time' });
  const after = h.queue({ agent: 'kit', engine: 'waits', title: 'Builds on it', after: id });
  await finish(await run(id, 'crashes'), { status: 'interrupted' });   // a clean hand-back doesn't count
  for (let i = 1; i <= 5; i++) await abandon(await run(id, 'crashes'));
  await h.claim('nothing-here');   // the next claim gives up on it
  assert.equal(h.job(id).status, 'failed');
  assert.match(h.job(id).result, /last 5 runs in a row/);
  assert.ok((await h.feed()).some(e => e.text?.startsWith(`Failed #${id}:`)), 'the feed says it failed');
  // given up by a claim, not reported by a worker: the job waiting for it (hq job --after) still hears
  assert.match((await run(after, 'waits')).note, new RegExp(`Job #${id} \\(Crashes every time\\), which this job waited for, failed`));
});

test("an agent's request titled like a pull request still hears the board's answer", async () => {
  const job = await h.start({ agent: 'kit', title: 'Fix the checkout' });
  await h.answer(await h.park(job, { kind: 'decision', title: 'PR #5 or a new branch for the checkout fix?' }), 'A new branch.');
  assert.equal(h.job(job.id).status, 'queued');
  assert.match((await run(job.id, job.engine)).note, /A new branch\./);
});

test('the feed previews a long report, marked, and the job keeps all of it', async () => {
  const job = await h.start({ agent: 'kit', title: 'Long report' });
  const report = `${'A long report. '.repeat(200)}The last line matters.`;
  await finish(job, { result: report });
  assert.equal(h.job(job.id).result, report);
  assert.match((await h.feed()).find(e => e.text?.startsWith(`Finished #${job.id}:`))!.text, /… \(cut\)$/);
});

test('a job whose earlier run was cut off is never "never ran", even after a clean hand-back starts its count again', async () => {
  const id = h.queue({ agent: 'kit', engine: 'half', title: 'Half done', queuedBy: 'kit' });
  await abandon(await run(id, 'half'));                               // run 1 died without reporting: it may have pushed commits
  await finish(await run(id, 'half'), { status: 'interrupted' });     // run 2 handed back before the CLI sent a session id
  assert.deepEqual([h.job(id).status, h.job(id).attempts], ['queued', 0]);
  const kit = await h.start({ agent: 'kit' });
  assert.notEqual((await h.agent('cancel', kit.token, { id })).status, 200, 'hq cancel refuses it');
  assert.equal(h.job(id).status, 'queued');
});

const row = (id: number) => h.db.prepare('select status, attempts, not_before, note, landing, result from jobs where id = ?').get(id) as
  { status: string; attempts: number; not_before: number; note: string | null; landing: string | null; result: string | null };

test("a run the worker's own plumbing snagged goes back in the queue after a growing wait, and gives up after four in a row", async () => {
  const id = h.queue({ agent: 'kit', engine: 'snags', title: 'Started in an outage', queuedBy: 'kit' });
  const after = h.queue({ agent: 'kit', engine: 'waits-snag', title: 'Builds on it', after: id });
  let wait = 0;
  for (let n = 1; n <= 3; n++) {
    const t = Date.now();
    await finish(await run(id, 'snags'), { status: 'snagged', result: 'Worker error: Failed to connect to github.com port 443' });
    const r = row(id);
    assert.deepEqual([r.status, r.attempts], ['queued', n], `snag ${n}: queued again, and counted`);
    assert.ok(r.not_before - t >= 5 * 60_000 * 2 ** (n - 1) - 1000 && r.not_before - t > wait, `snag ${n}: after a wait that grows`);
    wait = r.not_before - t;
    assert.match(r.note!, /You were paused/, 'its next run hears it was cut off, as after a restart');
  }
  await finish(await run(id, 'snags'), { status: 'snagged', result: 'Worker error: Failed to connect to github.com port 443' });
  assert.deepEqual([row(id).status, row(id).result], ['failed', 'Worker error: Failed to connect to github.com port 443']);
  assert.ok((await h.feed()).some(e => e.text?.startsWith(`Failed #${id}:`)), 'the feed says it failed');
  assert.match((await run(after, 'waits-snag')).note, new RegExp(`Job #${id} \\(Started in an outage\\), which this job waited for, failed`));
});

test("a snag after a run that ended well hands its next run the landing, kept through a snag before it, until it lands", async () => {
  const id = h.queue({ agent: 'kit', engine: 'lands', title: 'Pushed into an outage', queuedBy: 'kit' });
  const landing = { summary: 'Fixed the checkout.', result: 'Fixed the checkout.' };
  await finish(await run(id, 'lands'), { status: 'snagged', session: 's-1', branch: 'job/1', result: 'the push failed', landing });
  const again = await run(id, 'lands');
  assert.deepEqual(JSON.parse(again.landing), landing, 'the next claim carries it to the worker');
  assert.equal(again.session, 's-1', 'and the session it ran in');
  await finish(again, { status: 'snagged', result: 'Worker error: the mirror fetch failed' });   // (before it got to land)
  assert.deepEqual(JSON.parse(row(id).landing!), landing, 'a snag without one keeps it');
  await finish(await run(id, 'lands'), { status: 'done', pr: 4321, branch: 'job/1', result: 'Fixed the checkout.' });
  assert.deepEqual([row(id).status, row(id).landing, row(id).attempts], ['done', null, 0]);
});

test("an agent's own failure stays failed, and a snagged intercom turn is tried like a failed one", async () => {
  const job = await h.start({ agent: 'kit', title: 'The CLI exited 1' });
  await finish(job, { status: 'failed', result: 'The run ended with an error: exit code 1' });
  assert.equal(row(job.id).status, 'failed');

  await say('Hello again');
  const turn = await run(intercom, 'claude');
  const t = Date.now();
  await finish(turn, { status: 'snagged', result: 'Worker error: fetch failed' });
  assert.equal(row(turn.id).status, 'queued');
  assert.ok(row(turn.id).not_before - t < 5 * 60_000, "the intercom's short wait, not a work job's");
});
