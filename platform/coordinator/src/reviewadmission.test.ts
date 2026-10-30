// node --test src/reviewadmission.test.ts   (uses a throwaway DATA_DIR)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoryReport } from './memory.fixture.ts';
import { harness } from './harness.ts';

const h = await harness('review-admission');
const seat = 'capacity-codex';
const claim = () => h.claim('codex', { seat, util: 0 });
// (the judge a deadline's deliverable wakes as its last task ends with nothing to merge isn't these tests': threadorder.test.ts)
afterEach(() => h.cancelJudges());

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

for (const placement of ['own thread', 'dependent thread'])
  test(`a run serving its ${placement}'s window yields once for the work the claim starts`, async () => {
    await h.capacity({ codex: 2 });
    const thread = h.dueThread({ deadline: Date.now() + 30 * 24 * 3600_000 });
    const active = await h.start(
      { agent: 'kit', engine: 'codex', ...(placement === 'own thread' ? { thread } : {}) },
      { seat },
    );
    const dependent =
      placement === 'dependent thread'
        ? h.queue({ agent: 'bolt', engine: 'codex', forSeat: seat, after: active.id, thread })
        : null;
    if (dependent) assert.equal(h.job(active.id).thread, null, 'the running task has no thread of its own');
    const review = h.queue({ agent: 'quill', engine: 'codex', kind: 'review', forSeat: seat });
    const room = { capped: [seat] };
    assert.equal(
      (await h.heartbeat(active, room)).body.yield,
      undefined,
      'the claim would resume the windowed work ahead of the undated review',
    );
    const urgent = h.queue({
      agent: 'rook',
      engine: 'codex',
      forSeat: seat,
      thread: h.dueThread({ deadline: Date.now() + 60_000 }),
    });
    assert.equal((await h.heartbeat(active, room)).body.yield, 'waiting');
    await h.finish(active, { status: 'yielded', session: 'yield-once' });
    const next = (await claim())!;
    assert.equal(next.id, urgent, 'the waiter takes the freed place');
    assert.equal((await h.heartbeat(next, room)).body.yield, undefined, 'the waiter keeps its run');
    await h.finish(next);
    const resumed = (await claim())!;
    assert.equal(resumed.id, active.id);
    assert.equal(resumed.session, 'yield-once');
    await h.finish(resumed);
    if (dependent) {
      const following = (await claim())!;
      assert.equal(following.id, dependent);
      await h.finish(following);
    }
    const startedReview = (await claim())!;
    assert.equal(startedReview.id, review);
    await h.finish(startedReview);
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
      h.cancelJudges(); // (the deliverable's end woke its owner's judge)
      const resumed = (await h.claim(engine, { seat: bound, util: 0 }))!;
      assert.equal(resumed.id, active.id);
      assert.equal(resumed.session, 'kept-review');
      await h.finish(resumed);
    });

for (const kind of ['review', 'consolidate'])
  for (const measured of [false, true])
    test(`a windowed ${kind} keeps the next room ahead of undated reviews with ${measured ? 'larger' : 'unknown'} memory`, async () => {
      await h.capacity({ claude: 2 });
      const bound = 'capacity-claude';
      const lower = h.queue({ agent: 'rook', engine: 'claude', kind: 'review', forSeat: bound });
      const waiting = h.queue({
        agent: 'quill',
        engine: 'claude',
        kind,
        forSeat: bound,
        thread: h.dueThread({ deadline: Date.now() + 5 * 3600_000 }),
      });
      const jobs = [{ job: lower, mb: 300 }, ...(measured ? [{ job: waiting, mb: 1200 }] : [])];
      assert.equal((await h.worker('room', { jobs })).status, 200);
      assert.equal(
        await h.claim('claude', { seat: bound, room: 900, util: 0 }),
        null,
        'a smaller undated review cannot consume room the first windowed run is waiting for',
      );
      const next = (await h.claim('claude', { seat: bound, ...(measured ? { room: 1300 } : {}), util: 0 }))!;
      assert.equal(next.id, waiting, 'the windowed run takes the next sufficient room on the free seat');
      await h.finish(next);
      h.cancelJudges(); // (the deliverable's end woke its owner's judge)
      const last = (await h.claim('claude', { seat: bound, room: 900, util: 0 }))!;
      assert.equal(last.id, lower);
      await h.finish(last);
    });

test('a blocked windowed consolidate does not reserve room ahead of ready reviews', async () => {
  await h.capacity({ claude: 2 });
  const bound = 'capacity-claude';
  const dependency = h.queue({ agent: 'kit' });
  h.queue({
    agent: 'quill',
    engine: 'claude',
    kind: 'consolidate',
    forSeat: bound,
    after: dependency,
    thread: h.dueThread({ deadline: Date.now() + 5 * 3600_000 }),
  });
  const lower = h.queue({ agent: 'rook', engine: 'claude', kind: 'review', forSeat: bound });
  assert.equal((await h.worker('room', { jobs: [{ job: lower, mb: 300 }] })).status, 200);
  const next = (await h.claim('claude', { seat: bound, room: 900, util: 0 }))!;
  assert.equal(next.id, lower);
  await h.finish(next);
  h.cancelQueued();
});

for (const expedited of [false, true])
  for (const neededMb of [900, 1200])
    test(`a ${neededMb} MB ${expedited ? 'expedited ' : ''}waiter pauses a sufficient group or leaves every run working`, async () => {
      await h.capacity({ codex: 4 });
      const first = await h.start({ agent: 'kit', engine: 'codex', forSeat: seat }, { seat, util: 0 });
      const last = await h.start({ agent: 'bolt', engine: 'codex', forSeat: seat }, { seat, util: 0 });
      const waiter = h.queue({
        agent: 'moss',
        engine: 'codex',
        forSeat: seat,
        ...(expedited ? { expedite: true } : { thread: h.dueThread({ deadline: Date.now() }) }),
      });
      const jobs = [first.id, last.id].map(job => ({ job, mb: 400 }));
      jobs.push({ job: waiter, mb: neededMb });
      await h.worker('room', {
        jobs,
        capacity: {
          slots: { codex: 4 },
          seatRuns: { codex: 4 },
          room: 0,
          memory: memoryReport({
            at: Date.now(),
            availableMb: 1600,
            totalSlots: 4,
            runningMb: { [first.id]: 400, [last.id]: 400 },
          }),
        },
      });
      for (let beat = 0; beat < 3; beat++)
        assert.deepEqual(
          [
            (await h.heartbeat(first, { short: true })).body.yield,
            (await h.heartbeat(last, { short: true })).body.yield,
          ],
          neededMb === 900 ? ['waiting', 'waiting'] : [undefined, undefined],
        );
      if (neededMb === 900) {
        await h.finish(last, { status: 'yielded', session: 'last-session' });
        assert.equal(
          (await h.heartbeat(first, { short: true })).body.yield,
          'waiting',
          'the unfinished group still yields',
        );
        await h.finish(first, { status: 'yielded', session: 'first-session' });
        const started = (await h.claim('codex', { seat, util: 0, room: 900 }))!;
        assert.equal(started.id, waiter, 'the waiter takes the combined release');
        await h.finish(started);
        for (const session of ['first-session', 'last-session']) {
          const resumed = (await claim())!;
          assert.equal(resumed.session, session);
          await h.finish(resumed);
        }
      } else {
        await h.finish(first);
        await h.finish(last);
        await h.finish((await claim())!);
      }
      h.cancelJudges(); // (the deliverable's end woke its owner's judge)
      await h.capacity({ codex: 2 });
    });

test('an idle seat preserves deadline room from the first yield request through the next claim', async () => {
  h.cancelQueued();
  await h.capacity({ claude: 15, codex: 15 });
  const busy = 'claude-busy',
    idle = 'claude-idle';
  for (const [seatId, util] of [
    [busy, 0.6],
    [idle, 0.03],
  ] as const)
    await h.worker('seat', { seat: seatId, engine: 'claude', state: 'ready', util, week: 0.1 });
  const lower = await h.start({ agent: 'kit', engine: 'claude' }, { seat: busy, util: 0 });
  const urgent = h.queue({ agent: 'moss', engine: 'claude', thread: h.dueThread({ deadline: Date.now() - 60_000 }) });
  const small = h.queue({ agent: 'bolt', engine: 'codex', forSeat: seat });
  await h.worker('room', {
    jobs: [
      { job: lower.id, mb: 300 },
      { job: urgent, mb: 700 },
      { job: small, mb: 400 },
    ],
    capacity: {
      slots: { claude: 15, codex: 15 },
      seatRuns: {},
      room: 15,
      memory: memoryReport({ at: Date.now(), runningMb: { [lower.id]: 300 } }),
    },
  });
  const yielded = (await h.heartbeat(lower, { short: true })).body;
  assert.equal(yielded.yield, 'waiting');
  assert.equal(yielded.immediate, true);
  assert.equal(
    await h.claim('codex', { seat, util: 0, room: 500 }),
    null,
    'new lower work cannot spend the room needed alongside the pending pause release',
  );
  await h.finish(lower, { status: 'yielded', session: 'saved-lower' });
  const started = (await h.claim('claude', { seat: idle, util: 0, room: 800 }))!;
  assert.equal(started.id, urgent);
  await h.finish(started);
  h.cancelJudges(); // (the deliverable's end woke its owner's judge)
  const resumed = (await h.claim('claude', { seat: busy, util: 0 }))!;
  assert.equal(resumed.id, lower.id);
  assert.equal(resumed.session, 'saved-lower');
  await h.finish(resumed);
  const next = (await claim())!;
  assert.equal(next.id, small);
  await h.finish(next);
});
