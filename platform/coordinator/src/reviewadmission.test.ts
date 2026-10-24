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

test("a review waiting for its place pauses other work, never the CEO's follow-through check", async () => {
  await h.capacity({ codex: 2 });
  const a = await h.start({ agent: 'kit', engine: 'codex' }, { seat });
  const check = await h.start({ agent: 'bolt', engine: 'codex' }, { seat });
  h.db
    .prepare("insert into followthrough_checks (slot, job, created) values ('2026-10-23T11', ?, ?)")
    .run(check.id, new Date().toISOString());
  const review = h.queue({ agent: 'quill', engine: 'codex', kind: 'review' });
  const room = { capped: [seat] };
  assert.deepEqual(
    [(await h.heartbeat(a, room)).body.yield, (await h.heartbeat(check, room)).body.yield],
    ['waiting', undefined],
    'the check is the later in the order, and runs on',
  );
  h.db.prepare('delete from followthrough_checks').run();
  for (const j of [a, check]) await h.finish(j);
  const started = (await claim())!;
  assert.equal(started.id, review);
  await h.finish(started);
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

test('a second review whose window is slipping takes lower work’s place on the next claim', async () => {
  const active = await h.start({ agent: 'quill', engine: 'codex', kind: 'review' }, { seat });
  const work = await h.start({ agent: 'kit', engine: 'codex' }, { seat });
  const tight = h.queue({
    agent: 'rook',
    engine: 'codex',
    kind: 'review',
    thread: h.dueThread({ deadline: Date.now() }),
  });
  const answer = (await h.heartbeat(work, { capped: [seat] })).body;
  assert.equal(answer.yield, 'waiting');
  assert.equal(answer.immediate, true, 'deadline preemption does not wait for a tool boundary');
  await h.finish(work, { status: 'yielded', session: 'deadline-work' });
  const next = (await claim())!;
  assert.equal(next.id, tight);
  await h.finish(next);
  await h.finish(active);
  const resumed = (await claim())!;
  assert.equal(resumed.id, work.id);
  assert.equal(resumed.session, 'deadline-work');
  await h.finish(resumed);
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

for (const engine of ['codex', 'claude'])
  for (const kind of ['review', 'consolidate'])
    test(`slipping ${engine} work preempts a lower ${kind} and the paused session resumes`, async () => {
      await h.capacity({ [engine]: 1 });
      const bound = `capacity-${engine}`;
      const active = await h.start({ agent: 'quill', engine, kind, forSeat: bound }, { seat: bound });
      const waiting = h.queue({
        agent: 'kit',
        engine,
        forSeat: bound,
        thread: h.dueThread({ deadline: Date.now() + 60_000 }),
      });
      const answer = (await h.heartbeat(active, { capped: [bound] })).body;
      assert.equal(answer.yield, 'waiting');
      assert.equal(answer.immediate, true);
      await h.finish(active, { status: 'yielded', session: 'kept-review' });
      const next = (await h.claim(engine, { seat: bound, util: 0 }))!;
      assert.equal(next.id, waiting);
      await h.finish(next);
      const resumed = (await h.claim(engine, { seat: bound, util: 0 }))!;
      assert.equal(resumed.id, active.id);
      assert.equal(resumed.session, 'kept-review');
      await h.finish(resumed);
    });
