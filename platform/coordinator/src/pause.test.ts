// node --test src/pause.test.ts: while the board has the company paused, new work and reviews wait; the intercom, the
// jobs the pause names with everything on their pull requests, and the pull requests it names still run; everything
// resumes when it's lifted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Running } from './harness.ts';

const h = await harness('pause');
const { cancelJob } = await import('./ledger.ts');
// (no route pauses the company: a one-off in company/migrations.sql sets the setting, and takes it out again)
const paused = (pause: { since: string; allow: number[]; prs?: number[] } | null) =>
  pause
    ? h.db
        .prepare("insert or replace into settings (key, value) values ('company.paused', ?)")
        .run(JSON.stringify(pause))
    : h.db.prepare("delete from settings where key = 'company.paused'").run();
const claim = async (kind?: string) => (await h.claim('claude', { util: 0, ...(kind ? { kind } : {}) }))?.id;

test("a paused company starts no new work and no other work's reviews, but the intercom, the named jobs with their pull requests, and the named pull requests still run", async () => {
  const work = h.queue({ agent: 'bolt', engine: 'claude', title: 'Build a thing' });
  const other = h.queue({
    agent: 'quill',
    engine: 'claude',
    kind: 'review',
    pr: 5,
    round: 1,
    branch: 'job/1',
    title: 'Review PR #5',
  });
  const allowed = h.queue({ agent: 'juno', engine: 'claude', title: 'Tell the team' });
  const itsReview = h.queue({
    agent: 'quill',
    engine: 'claude',
    kind: 'review',
    pr: 8,
    round: 1,
    branch: `job/${allowed}`,
    title: 'Review PR #8',
  });
  const named = h.queue({
    agent: 'quill',
    engine: 'claude',
    kind: 'consolidate',
    pr: 7,
    round: 1,
    title: 'Check PR #7',
  });
  const fix = h.queue({ agent: 'bolt', engine: 'claude', pr: 7, title: 'Fixing review notes on PR #7' });
  paused({ since: 'now', allow: [allowed], prs: [7] });
  assert.equal((await h.board('/api/chat', { text: 'Hello' })).status, 200);
  const turn = await claim('chat'); // (the intercom's turn: its own slot)
  assert.equal(h.job(turn!).kind, 'chat');
  await h.finish(h.job(turn!));
  const started = [await claim(), await claim(), await claim(), await claim()];
  assert.deepEqual(
    started.sort(),
    [allowed, itsReview, named, fix].sort(),
    "the named job, its pull request's review, and the named pull request's check and fix",
  );
  assert.equal(await claim(), undefined, "ordinary work and another pull request's review wait");
  paused(null);
  assert.deepEqual([await claim(), await claim()].sort(), [work, other].sort(), 'and start once the pause is lifted');
});

test('a pause stops running work too, at its next step and back in the queue in its session, and it resumes once lifted; a call and the named work run on', async () => {
  paused(null);
  const work = await h.start({ agent: 'bolt', engine: 'claude', title: 'Long build' });
  const call = await h.start({
    agent: 'juno',
    engine: 'claude',
    title: 'Follow up on your call with the board',
    call: 1,
  });
  const named = await h.start({ agent: 'kit', engine: 'claude', title: 'Named' });
  paused({ since: 'now', allow: [named.id] });
  assert.equal((await h.heartbeat(work)).body.yield, 'paused');
  assert.equal((await h.heartbeat(call)).body.yield, undefined);
  assert.equal((await h.heartbeat(named)).body.yield, undefined);
  assert.equal((await h.finish(work, { status: 'yielded', session: 'its-session' })).status, 200);
  assert.deepEqual(
    { ...h.db.prepare('select status, session from jobs where id = ?').get(work.id) },
    { status: 'queued', session: 'its-session' },
  );
  assert.equal(await claim(), undefined, 'the pause holds it');
  paused(null);
  assert.equal(await claim(), work.id);
  for (const j of [call, named]) await h.finish(j);
  await h.finish({ ...work, ...h.job(work.id) });
});

test("a paused run's next run hears what the pause stopped: its commands and its team members still at work, once", async () => {
  paused(null);
  const lead = await h.start({ agent: 'bolt', engine: 'claude', title: 'Lead a team' });
  const tests = 'npm test (running 4 min)';
  const members = Array.from(
    { length: 13 },
    (_, i) => `member-${i + 1}-whose-whole-name-the-lead-uses-to-start-this-member-again`,
  );
  await h.finish(lead, {
    status: 'yielded',
    session: 'its-session',
    lost: [tests],
    lostAt: '2026-10-19T19:05:00.000Z',
    members,
  });
  const next = await h.claim('claude', { util: 0 });
  assert.equal(next?.id, lead.id);
  assert.equal(next?.session, 'its-session');
  assert.ok(next?.cut?.includes(tests));
  for (const member of members) assert.ok(next?.cut?.includes(member));
  // paused again with nothing going: nothing to tell, and the last note isn't told twice
  await h.finish({ ...lead, ...h.job(lead.id) }, { status: 'yielded', session: 'its-session' });
  assert.equal((await h.claim('claude', { util: 0 }))?.cut, null);
  await h.finish({ ...lead, ...h.job(lead.id) });
});

// A seat ready on the engine, so work waiting there waits for room, not for its seat (jobs.ts makesRoom: a seat out of
// its window frees nothing by pausing).
const seatReady = async (engine: string) =>
  assert.equal((await h.worker('seat', { seat: `ready-${engine}`, engine, state: 'ready', util: 0 })).status, 200);
// (what's in the way on the worker, as every run's heartbeat reports it: here every slot taken)
const yieldOf = async (job: Running, room: Record<string, unknown> = { short: true }) =>
  (await h.heartbeat(job, room)).body.yield;

test("the board's call's follow-up gets a run: the running work last in the order makes room, one per follow-up, after half a minute", async () => {
  paused(null);
  await seatReady('claude');
  const first = await h.start({ agent: 'bolt', engine: 'claude', title: 'First' });
  const early = await h.start({ agent: 'kit', engine: 'claude', title: 'Early' });
  const late = await h.start({ agent: 'moss', engine: 'claude', title: 'Late' });
  const followUp = h.queue({
    agent: 'juno',
    engine: 'claude',
    title: 'Follow up on your call with the board',
    call: 9,
  });
  h.storedCall(9, 'juno', followUp);
  const yields = async () => [await yieldOf(first), await yieldOf(early), await yieldOf(late)];
  assert.deepEqual(await yields(), [undefined, undefined, undefined], 'a free run may still take it');
  h.db.prepare('update jobs set created = ? where id = ?').run(new Date(Date.now() - 60_000).toISOString(), followUp);
  assert.deepEqual(await yields(), [undefined, undefined, 'waiting']);
  assert.equal(await yieldOf(late, {}), undefined, 'only for work waiting for the room it holds');
  // and it's the first work a free run takes, before other work
  const other = h.queue({ agent: 'bolt', engine: 'claude', title: 'Other work' });
  await h.finish(late);
  assert.equal(await claim(), followUp);
  for (const j of [first, early]) await h.finish(j);
  h.db.prepare("update jobs set status = 'cancelled' where id in (?, ?)").run(other, followUp);
});

test('windowed work whose slack is used pauses the running work with no window and starts in its place; work with slack pauses nothing', async () => {
  paused(null);
  await seatReady('claude');
  const running = await h.start({ agent: 'kit', engine: 'claude', title: 'No window' });
  const loose = h.queue({
    agent: 'bolt',
    engine: 'claude',
    title: 'Has slack',
    thread: h.dueThread({ deadline: Date.now() + 30 * 24 * 3600_000 }),
  });
  assert.equal(await yieldOf(running), undefined, 'work with slack waits for a slot to free');
  const tight = h.queue({
    agent: 'moss',
    engine: 'claude',
    title: 'Slack used',
    thread: h.dueThread({ deadline: Date.now() + 60_000 }),
  });
  assert.equal(await yieldOf(running), 'waiting');
  assert.equal((await h.finish(running, { status: 'yielded', session: 'its-session' })).status, 200);
  assert.equal(await claim(), tight, 'it starts in its place');
  assert.equal(await claim(), loose);
  assert.equal(await claim(), running.id, 'and the paused work after it, in its session');
  for (const id of [tight, loose, running.id]) await h.finish({ ...h.job(id) });
  h.cancelJudges(); // (the deliverable's end woke its owner's judge)
});

test("a review and the board's call's follow-up are never paused, and memory short of room pauses another engine's run, whose room goes to the work it paused for", async () => {
  paused(null);
  await seatReady('claude');
  const review = await h.start({
    agent: 'quill',
    engine: 'claude',
    kind: 'review',
    pr: 40,
    round: 1,
    branch: 'job/1',
    title: 'Review PR #40',
  });
  const lane = await h.start({ agent: 'juno', engine: 'claude', title: 'Follow up on your call with the board' });
  h.storedCall(14, 'juno', lane.id);
  const elsewhere = await h.start({ agent: 'kit', engine: 'codex', title: 'On another engine' });
  const thread = h.dueThread({ deadline: Date.now() + 60_000 });
  const tight = h.queue({
    agent: 'moss',
    engine: 'claude',
    title: 'Slack used',
    thread,
  });
  assert.equal(await yieldOf(review), undefined, 'a review runs to its end');
  assert.equal(await yieldOf(lane), undefined, "the board's word runs on");
  assert.equal(await yieldOf(elsewhere, {}), undefined, 'room left: the waiting work starts beside it');
  assert.equal(await yieldOf(elsewhere), 'waiting', 'short of memory, any engine makes room');
  // the room it frees goes to the work it was freed for: its own engine's next short claim doesn't take it back
  assert.equal(
    (await h.worker('room', { jobs: [elsewhere, { id: tight }].map(j => ({ job: j.id, mb: 500, cores: 1 })) })).status,
    200,
  );
  assert.equal((await h.finish(elsewhere, { status: 'yielded', session: 'its-session' })).status, 200);
  const short = (engine: string, seat?: string) => h.claim(engine, { util: 0, room: 1000, ...(seat ? { seat } : {}) });
  assert.equal(await short('codex', elsewhere.seat), null, 'the paused run waits');

  assert.equal((await h.board('/api/chat', { text: 'Hello again' })).status, 200);
  const turn = (await h.claim('claude', { kind: 'chat', seat: 'ready-claude', util: 0 }))!;
  assert.equal(turn?.kind, 'chat', 'the intercom starts while work waits for the room reserved for it');
  await h.finish(turn);

  assert.equal((await h.agent('pauses', lane.token, { thread, why: 'Wait for a decision', byHand: true })).status, 200);
  const unblocked = (await short('codex', elsewhere.seat))!;
  assert.equal(unblocked?.id, elsewhere.id, 'a paused waiter holds no room');
  assert.equal((await h.agent('pauses/resume', lane.token, { thread })).status, 200);
  assert.equal(await yieldOf(unblocked), 'waiting', 'the resumed waiter needs room again');
  assert.equal((await h.finish(unblocked, { status: 'yielded', session: 'its-session' })).status, 200);
  assert.equal(await short('codex', elsewhere.seat), null, 'the new reservation holds its room');
  const waiter = (await short('claude', 'ready-claude'))!;
  assert.equal(waiter?.id, tight, 'the work it made room for starts');
  assert.equal((await h.finish(waiter, { status: 'yielded', session: 'waiter-session' })).status, 200);
  const back = (await short('codex', elsewhere.seat))!;
  assert.equal(back?.id, elsewhere.id, 'the completed handoff holds no room when the waiter queues again');
  const again = (await short('claude', 'ready-claude'))!;
  assert.equal(again?.id, tight);
  for (const j of [review, lane, back, again]) await h.finish(j);
  h.cancelJudges(); // (the deliverable's end woke its owner's judge)
});

test("the CEO's follow-through check runs to its end once started: work due sooner pauses another run", async () => {
  paused(null);
  await seatReady('claude');
  const other = await h.start({ agent: 'kit', engine: 'claude', title: 'Started first' });
  // (the later of the two in the order, so the one a pause would stop: the 11:00 check of 23 October, paused a minute in)
  const check = await h.start({ agent: 'juno', engine: 'claude', title: 'Follow-through check (11:00 UTC)' });
  h.db
    .prepare("insert into followthrough_checks (slot, job, created) values ('2026-10-23T11', ?, ?)")
    .run(check.id, new Date().toISOString());
  const tight = h.queue({
    agent: 'moss',
    engine: 'claude',
    title: 'Slack used',
    thread: h.dueThread({ deadline: Date.now() + 60_000 }),
  });
  assert.deepEqual([await yieldOf(other), await yieldOf(check)], ['waiting', undefined]);
  h.db.prepare('delete from followthrough_checks').run();
  assert.equal(await yieldOf(check), 'waiting', 'the same run as plain work would have been the one');
  for (const j of [other, check]) await h.finish(j);
  assert.ok(cancelJob(tight, 'Test finished'));
  h.cancelJudges(); // (the deliverable's end woke its owner's judge)
});

test('a seat at its run cap: with slots and memory to spare, a run on that seat makes room', async () => {
  paused(null);
  await seatReady('codex');
  const a = await h.start({ agent: 'kit', engine: 'codex', title: 'A' }, { seat: 'ready-codex' });
  const b = await h.start({ agent: 'bolt', engine: 'codex', title: 'B' }, { seat: 'ready-codex' });
  const tight = h.queue({
    agent: 'moss',
    engine: 'codex',
    title: 'Slack used',
    thread: h.dueThread({ deadline: Date.now() + 60_000 }),
  });
  const yields = async (room: Record<string, unknown>) => [await yieldOf(a, room), await yieldOf(b, room)];
  assert.deepEqual(await yields({}), [undefined, undefined], 'its seat has room: it starts beside them');
  assert.deepEqual(await yields({ capped: ['ready-codex'] }), [undefined, 'waiting'], 'the later in the order yields');
  for (const j of [a, b]) await h.finish(j);
  assert.ok(cancelJob(tight, 'Test finished'));
  h.cancelJudges(); // (the deliverable's end woke its owner's judge)
});

test('every slot taken and its seat at its cap: a run on that seat makes room, not the last run in the order', async () => {
  paused(null);
  await seatReady('codex');
  await seatReady('claude');
  const a = await h.start({ agent: 'kit', engine: 'codex', title: 'A' }, { seat: 'ready-codex' });
  const b = await h.start({ agent: 'bolt', engine: 'codex', title: 'B' }, { seat: 'ready-codex' });
  const newer = await h.start({ agent: 'quill', engine: 'claude', title: 'Newer' }, { seat: 'ready-claude' });
  const tight = h.queue({
    agent: 'moss',
    engine: 'codex',
    title: 'Slack used',
    thread: h.dueThread({ deadline: Date.now() + 60_000 }),
  });
  const room = { short: true, capped: ['ready-codex'] };
  assert.deepEqual(
    [await yieldOf(a, room), await yieldOf(b, room), await yieldOf(newer, room)],
    [undefined, 'waiting', undefined],
    "pausing the Claude run would free a slot, not the Codex seat's run it waits for",
  );
  for (const j of [a, b, newer]) await h.finish(j);
  assert.ok(cancelJob(tight, 'Test finished'));
  h.cancelJudges(); // (the deliverable's end woke its owner's judge)
});

test("a call's follow-up is never held by a pause, nor what was queued on the call, nor a job a call's follow-up went to", async () => {
  const followUp = h.queue({
    agent: 'juno',
    engine: 'claude',
    title: 'Follow up on your call with the board',
    call: 1,
  });
  const parked = h.queue({ agent: 'bolt', engine: 'claude', title: 'Waits on a card' });
  h.storedCall(2, 'bolt', parked);
  const other = h.queue({ agent: 'bolt', engine: 'claude', title: 'Other work' });
  paused({ since: 'now', allow: [] });
  assert.deepEqual([await claim(), await claim()].sort(), [followUp, parked].sort());
  assert.equal(await claim(), undefined);
  paused(null);
  assert.equal(await claim(), other);
});

test("the board's word runs through a pause to its merge: a call's follow-up, an item it handed out and the board's answer to a card, each with its pull request's reviews and fixes, while other work's reviews wait", async () => {
  const followUp = h.queue({ agent: 'juno', engine: 'claude', title: 'Follow up on your call with the board' });
  h.storedCall(12, 'juno', followUp);
  const answer = h.queue({ agent: 'juno', engine: 'claude', title: 'The board on: the plan' });
  h.db.prepare('update jobs set answers = 179 where id = ?').run(answer);
  const reviews = [followUp, answer].map((j, i) =>
    h.queue({
      agent: 'quill',
      engine: 'claude',
      kind: 'review',
      pr: 20 + i,
      round: 1,
      branch: `job/${j}`,
      title: `Review PR #${20 + i}`,
    }),
  );
  const fix = h.queue({
    agent: 'juno',
    engine: 'claude',
    pr: 21,
    branch: `job/${answer}`,
    title: 'Fixing review notes',
  });
  const other = h.queue({
    agent: 'quill',
    engine: 'claude',
    kind: 'review',
    pr: 30,
    round: 1,
    branch: 'job/1',
    title: 'Review PR #30',
  });
  // (ledger.handOut: it carries the item's call)
  const handedOut = h.queue({ agent: 'bolt', engine: 'claude', title: "A call's item, handed out later", call: 12 });
  h.db.prepare('update jobs set item = 5 where id = ?').run(handedOut);
  paused({ since: 'now', allow: [] });
  const started = [await claim(), await claim(), await claim(), await claim(), await claim(), await claim()];
  assert.deepEqual(started.sort(), [followUp, answer, ...reviews, fix, handedOut].sort(), 'no job named anywhere');
  assert.equal(await claim(), undefined, "other work's review waits");
  paused(null);
  assert.equal(await claim(), other);
});

test("the CEO's expedited fix starts first, through a pause and ahead of the board's word, and the latest-started work makes room for it at once", async () => {
  paused(null);
  await seatReady('claude');
  const first = await h.start({ agent: 'bolt', engine: 'claude', title: 'First' });
  const late = await h.start({ agent: 'moss', engine: 'claude', title: 'Late' });
  const word = h.queue({ agent: 'kit', engine: 'claude', title: 'Follow up on your call with the board', call: 10 });
  h.storedCall(10, 'kit', word);
  const fix = h.queue({ agent: 'juno', engine: 'claude', title: 'Fix the claim', expedite: true });
  assert.deepEqual(
    [await yieldOf(first), await yieldOf(late)],
    [undefined, 'waiting'],
    'the latest started yields, at once',
  );
  paused({ since: 'now', allow: [] });
  const started = await h.claim('claude', { util: 0 });
  assert.equal(started?.id, fix, 'it starts first, through the pause');
  paused(null);
  for (const j of [first, late, started!]) await h.finish(j);
  assert.ok(cancelJob(word, 'Test finished'));
});

test('a running expedited fix keeps its seat: the latest-started other work makes room for what comes after it', async () => {
  paused(null);
  await seatReady('claude');
  const first = await h.start({ agent: 'bolt', engine: 'claude', title: 'First' });
  const fix = await h.start({ agent: 'juno', engine: 'claude', title: 'Fix the claim', expedite: true });
  const word = h.queue({ agent: 'kit', engine: 'claude', title: 'Follow up on your call with the board', call: 11 });
  h.storedCall(11, 'kit', word);
  h.db.prepare('update jobs set created = ? where id = ?').run(new Date(Date.now() - 60_000).toISOString(), word);
  assert.deepEqual([await yieldOf(fix), await yieldOf(first)], [undefined, 'waiting'], 'never the expedited run');
  for (const j of [first, fix]) await h.finish(j);
  assert.ok(cancelJob(word, 'Test finished'));
});
