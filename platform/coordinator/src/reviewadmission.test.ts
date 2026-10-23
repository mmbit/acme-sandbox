// node --test src/reviewadmission.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('review-admission');
const seat = 'capacity-codex';
const claim = () => h.claim('codex', { seat, util: 0 });

test('ready reviews get one occupied Codex place while work keeps the other and resumes its session', async () => {
  await h.capacity({ codex: 2 });
  const a = await h.start({ agent: 'kit', engine: 'codex' }, { seat });
  const b = await h.start({ agent: 'bolt', engine: 'codex' }, { seat });
  const olderWork = h.queue({ agent: 'moss', engine: 'codex' });
  const review = h.queue({ agent: 'quill', engine: 'codex', kind: 'review' });
  const nextReview = h.queue({ agent: 'rook', engine: 'codex', kind: 'review' });
  const room = { capped: [seat] };
  assert.equal((await h.heartbeat(b)).body.yield, undefined, 'free room needs no pause');
  assert.deepEqual(
    [(await h.heartbeat(a, room)).body.yield, (await h.heartbeat(b, room)).body.yield],
    [undefined, 'waiting'],
    'one work run yields for a review without a thread window',
  );
  await h.finish(b, { status: 'yielded', session: 'saved-work' });
  const startedReview = (await claim())!;
  assert.equal(startedReview.id, review, 'older work cannot take the freed review place');
  assert.equal((await h.heartbeat(a, room)).body.yield, undefined, 'a second review does not pause the remaining work');
  await h.finish(a);
  const resumed = (await claim())!;
  assert.equal(resumed.id, b.id, 'work gets the other place even while more reviews are ready');
  assert.equal(resumed.session, 'saved-work');
  await h.finish(startedReview);
  const second = (await claim())!;
  assert.equal(second.id, nextReview, 'the review place serves the next ready review');
  await h.finish(resumed);
  const work = (await claim())!;
  assert.equal(work.id, olderWork);
  await h.finish(second);
  await h.finish(work);
});

test('a free Codex seat starts a review before older work and then starts work beside it', async () => {
  const work = h.queue({ agent: 'kit', engine: 'codex' });
  const review = h.queue({ agent: 'quill', engine: 'codex', kind: 'consolidate' });
  const another = h.queue({ agent: 'rook', engine: 'codex', kind: 'review' });
  const first = (await claim())!;
  assert.equal(first.id, review);
  const second = (await claim())!;
  assert.equal(second.id, work);
  await h.finish(first);
  await h.finish(second);
  const last = (await claim())!;
  assert.equal(last.id, another);
  await h.finish(last);
});

test('an undated review with a free seat place does not pause work for a general slot or memory', async () => {
  const work = await h.start({ agent: 'kit', engine: 'codex' }, { seat });
  const elsewhere = await h.start({ agent: 'bolt', engine: 'claude' });
  const review = h.queue({ agent: 'quill', engine: 'codex', kind: 'review', forSeat: seat });
  for (const run of [work, elsewhere]) assert.equal((await h.heartbeat(run, { short: true })).body.yield, undefined);
  await h.finish(work);
  await h.finish(elsewhere);
  const startedReview = (await claim())!;
  assert.equal(startedReview.id, review);
  await h.finish(startedReview);
});

test('a second review with a tight window waits for the review place while ordinary work progresses', async () => {
  const work = await h.start({ agent: 'kit', engine: 'codex' }, { seat });
  const active = await h.start({ agent: 'quill', engine: 'codex', kind: 'review' }, { seat });
  const tight = h.queue({
    agent: 'rook',
    engine: 'codex',
    kind: 'review',
    thread: h.dueThread({ deadline: Date.now() }),
  });
  assert.equal((await h.heartbeat(work, { capped: [seat] })).body.yield, undefined);
  await h.finish(active);
  const next = (await claim())!;
  assert.equal(next.id, tight);
  await h.finish(next);
  await h.finish(work);
});

test('a blocked review takes no room and the board call still claims before a ready review', async () => {
  const a = await h.start({ agent: 'kit', engine: 'codex' }, { seat });
  const b = await h.start({ agent: 'bolt', engine: 'codex' }, { seat });
  const review = h.queue({ agent: 'quill', engine: 'codex', kind: 'review', after: a.id });
  assert.equal((await h.heartbeat(b, { capped: [seat] })).body.yield, undefined);
  const call = h.queue({ agent: 'juno', engine: 'codex' });
  h.storedCall(84, 'juno', call);
  await h.finish(a);
  const followUp = (await claim())!;
  assert.equal(followUp.id, call, 'the board call retains its lane');
  assert.equal((await h.heartbeat(followUp, { capped: [seat] })).body.yield, undefined);
  assert.equal((await h.heartbeat(b, { capped: [seat] })).body.yield, 'waiting');
  await h.finish(b, { status: 'yielded', session: 'after-call' });
  const startedReview = (await claim())!;
  assert.equal(startedReview.id, review);
  await h.finish(startedReview);
  await h.finish(followUp);
  const resumed = (await claim())!;
  assert.equal(resumed.id, b.id);
  await h.finish(resumed);
});

test('a review on another seat does not occupy the bound review place or free its capped seat', async () => {
  const otherSeat = 'other-codex';
  await h.worker('seat', { seat: otherSeat, engine: 'codex', state: 'ready', util: 0 });
  const a = await h.start({ agent: 'kit', engine: 'codex', forSeat: seat }, { seat });
  const b = await h.start({ agent: 'bolt', engine: 'codex', forSeat: seat }, { seat });
  const elsewhere = await h.start(
    { agent: 'rook', engine: 'codex', kind: 'review', forSeat: otherSeat },
    { seat: otherSeat },
  );
  const review = h.queue({ agent: 'quill', engine: 'codex', kind: 'review', forSeat: seat });
  const room = { short: true, capped: [seat] };
  assert.deepEqual(
    [
      (await h.heartbeat(a, room)).body.yield,
      (await h.heartbeat(b, room)).body.yield,
      (await h.heartbeat(elsewhere, room)).body.yield,
    ],
    [undefined, 'waiting', undefined],
  );
  await h.finish(b, { status: 'yielded', session: 'bound-seat-work' });
  const startedReview = (await claim())!;
  assert.equal(startedReview.id, review);
  for (const job of [a, elsewhere, startedReview]) await h.finish(job);
  const resumed = (await claim())!;
  assert.equal(resumed.id, b.id);
  await h.finish(resumed);
});
