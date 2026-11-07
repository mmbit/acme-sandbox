// node --test src/emptyclaims.test.ts   (uses a throwaway DATA_DIR): a seat whose claims come back empty shows the first
// check its best job failed in its status, until a claim starts work (emptyclaims.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('emptyclaims');
const { seatStatuses } = await import('./seatstatus.ts');
const { seatStatusWords } = await import('../../worker/hq/seatwords.ts');
const runs = await import('./runs.ts');
const pauses = await import('./pauses.ts');

const DAY = 864e5;
const at = (ms: number) => new Date(ms).toISOString();
const report = (seat: string, engine: string) =>
  h.worker('seat', { seat, engine, state: 'ready', util: 0.1, week: 0.1 });
const status = (seat: string) => seatStatuses(h.db).get(seat)!;

test('a paced seat shows the job pacing kept from it, keeps that reason while it holds, and clears it once it starts the job', async () => {
  await report('paced-1', 'paced');
  const job = h.queue({ agent: 'kit', title: 'Paint the harbour', engine: 'paced' });
  const reset = Date.now() + 2 * DAY;
  assert.equal(await h.claim('paced', { seat: 'paced-1', pacedUntil: reset }), null);
  const empty = status('paced-1').empty!;
  assert.deepEqual({ check: empty.check, job: empty.job, until: empty.until }, { check: 'pacing', job, until: reset });
  assert.match(
    seatStatusWords(status('paced-1'), at),
    new RegExp(`at pacing: #${job} isn't urgent, and the seat's paced places are occupied`),
  );
  assert.equal(await h.claim('paced', { seat: 'paced-1', pacedUntil: reset }), null);
  assert.equal(status('paced-1').empty!.since, empty.since, 'the same reason holds since the first empty claim');
  assert.equal((await h.claim('paced', { seat: 'paced-1' }))?.id, job, 'unpaced, the seat takes it');
  assert.equal(status('paced-1').empty, undefined);
});

test('the best job is the one that passes the most checks: one waiting on a merge goes before one that starts later', async () => {
  await report('waits-1', 'waits');
  const before = h.queue({ agent: 'kit', title: 'Draw the quay', engine: 'waits' });
  h.db.prepare('update jobs set not_before = ? where id = ?').run(Date.now() + DAY, before);
  const waiting = h.queue({ agent: 'kit', title: 'Colour the quay', engine: 'waits', after: before });
  assert.equal(await h.claim('waits', { seat: 'waits-1' }), null);
  const empty = status('waits-1').empty!;
  assert.deepEqual(
    { check: empty.check, job: empty.job, wait: empty.wait },
    { check: 'waits', job: waiting, wait: { on: 'job', job: before } },
  );
  h.cancelQueued();
});

test('a job held by a kind of run and paused with its thread shows the run hold, the first check it fails', async t => {
  h.declareKinds(t, '    sweep:\n      serverAfterLent: true\n      holdUntilLent: [studio]\n');
  runs.publishHolds();
  t.after(() => runs.publishHolds());
  await report('both-1', 'both');
  const thread = h.dueThread();
  const job = h.queue({ agent: 'wren', title: 'Sweep the studio', engine: 'both', thread });
  assert.equal(typeof pauses.pause({ thread, why: 'Wait for the new brushes', byHand: true }, 'juno'), 'object');
  assert.equal(await h.claim('both', { seat: 'both-1' }), null);
  const empty = status('both-1').empty!;
  assert.deepEqual({ check: empty.check, job: empty.job }, { check: 'runs held', job });
  pauses.resume({ thread }, 'juno');
  h.cancelQueued();
});

test('a seat whose only job starts later shows that time, and one with nothing queued for it says so', async () => {
  await report('later-1', 'later');
  const later = h.queue({ agent: 'kit', title: 'Light the lamps', engine: 'later' });
  const from = Date.now() + DAY;
  h.db.prepare('update jobs set not_before = ? where id = ?').run(from, later);
  assert.equal(await h.claim('later', { seat: 'later-1' }), null);
  const empty = status('later-1').empty!;
  assert.deepEqual(
    { check: empty.check, job: empty.job, until: empty.until },
    { check: 'not before', job: later, until: from },
  );
  h.cancelQueued();
  assert.equal(await h.claim('later', { seat: 'later-1' }), null);
  const none = status('later-1').empty!;
  assert.deepEqual({ check: none.check, job: none.job }, { check: 'none', job: null });
  assert.match(seatStatusWords(status('later-1'), at), /empty from .+ to .+: nothing queued that it takes/);
});
