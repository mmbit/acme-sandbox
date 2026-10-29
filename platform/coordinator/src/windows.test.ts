// node --test src/windows.test.ts   (throwaway DATA_DIR and the test company): windows on threads, never on one job
// (windows.ts): hq window sets, widens, tightens or takes off a thread's deadline and aim, or only tries it, and says what
// that moves; a call's item with its time sets its thread's window when it's handed out; and the claim hands out the
// thread's whole chain by latest start, the work it waits for at any depth included. The CEO's summary line for a
// thread past its deadline is threats.ts's (summary.test.ts).
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

const h = await harness('deadlines', {
  before: repo =>
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: shop, name: The shop, owner: moss }\n'),
});
const { db, jobs } = h;
const windows = await import('./windows.ts');
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const forecast = await import('./forecast.ts');
const { inOneStep } = await import('./db.ts');
const threats = await import('./threats.ts');
const threadends = await import('./threadends.ts');
const predictionlog = await import('./predictionlog.ts');

const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  SHA = 'a'.repeat(40);
const thread = (id: string) => ({ ...(db.prepare('select * from threads where id = ?').get(id) as any) });
// A thread in the shop, moss's: its id
let threads = 0;
const opened = () => {
  const t = projects.createThread({ project: 'shop', name: `Shop work ${++threads}`, goal: 'It sells' });
  if (typeof t === 'string') throw new Error(t);
  return t.id;
};
// The order the claim hands an engine's work out in
const claimed = async (engine: string, n: number) => {
  const order: (number | undefined)[] = [];
  for (let i = 0; i < n; i++) order.push((await h.claim(engine))?.id);
  return order;
};

beforeEach(async () => {
  db.exec(
    'delete from jobs; delete from requests; delete from prs; delete from waits; delete from wakes; delete from seats; delete from runs; delete from predictions; delete from calls; delete from call_tokens; delete from call_jobs; delete from call_items',
  );
  // (an earlier test's thread left open and empty plays as its owner's placeholder in the forecast)
  h.closedThreads();
  for (const engine of ['claude', 'codex'])
    assert.equal(
      (await h.worker('seat', { seat: `${engine}-1`, engine, state: 'ready', util: 0.1, week: 0.1 })).status,
      200,
    );
  assert.equal(
    (
      await h.worker('room', {
        capacity: {
          slots: { claude: 1, codex: 1 },
          seatRuns: { codex: 1 },
          room: 1,
        },
      })
    ).status,
    200,
  );
});

test("a deadline reads as a time from now, a UTC time or one on the company's clock, and anything else is refused", () => {
  const at = Date.parse('2026-10-06T08:00:00Z');
  assert.equal(windows.parse('2h', at), at + 2 * HOUR);
  assert.equal(windows.parse('1h30m', at), at + 1.5 * HOUR);
  assert.equal(windows.parse('14:30', at), Date.parse('2026-10-06T14:30:00Z'), 'later today');
  assert.equal(windows.parse('07:00', at), Date.parse('2026-10-07T07:00:00Z'), 'gone today: tomorrow');
  assert.equal(windows.parse('2026-10-06T10:00Z', at), Date.parse('2026-10-06T10:00:00Z'));
  // The fixture's clock is Europe/Amsterdam: each time at its own date's offset, either side of 25 October's change
  assert.equal(windows.parse('2026-10-06 12:00', at), Date.parse('2026-10-06T10:00:00Z'), 'summer time');
  assert.equal(windows.parse('2026-10-26T09:00', at), Date.parse('2026-10-26T08:00:00Z'), 'winter time');
  for (const bad of [
    'soon',
    '2 hours',
    '25:00',
    '2027-02-31T10:00Z',
    '2027-02-31 10:00',
    '2026-10-06 24:00',
    '2026-10-06 09:00',
    '-2h',
    '',
    '2026-10-06T07:00Z',
    '0m',
  ])
    assert.equal(typeof windows.parse(bad, at), 'string', `"${bad}" is refused, with why`);
});

test('hq window: on a thread named by its id, a job on it or a pull request; set, widened, tightened, and none takes it off', async () => {
  const shop = opened(),
    kit = await h.start({ agent: 'kit', title: 'On the intercom' });
  const run = await h.start({ agent: 'bolt', title: 'The share link', queuedBy: 'juno', thread: shop }),
    running = run.id;
  const near = (at: number, from: number) => Math.abs(at - (Date.now() + from)) < MINUTE;
  const r = await h.agent('window', kit.token, { job: running, deadline: '3h' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.thread, shop);
  assert.equal(r.body.tried, false);
  assert.ok(near(thread(shop).deadline, 3 * HOUR), 'three hours from now');
  assert.equal(thread(shop).aim, thread(shop).deadline, 'no aim given: the aim is the deadline');
  assert.equal(thread(shop).deadline_by, 'kit', 'kit gave the board the time');
  const equal = await h.agent('window', kit.token, { thread: shop, deadline: '2h', aim: '2h' });
  assert.equal(equal.status, 200, JSON.stringify(equal.body));
  assert.equal(thread(shop).aim, thread(shop).deadline, 'equal relative times share one clock reading');
  const elapsed = new Date(Date.now() - HOUR).toISOString().slice(0, 19) + 'Z';
  const widened = await h.agent('window', kit.token, { thread: shop, deadline: '3h', aim: elapsed });
  assert.equal(widened.status, 200, JSON.stringify(widened.body));
  assert.equal(thread(shop).aim, Date.parse(elapsed), 'the agreed aim may have passed');
  // an aim of its own; widened, the aim stays
  assert.equal((await h.agent('window', kit.token, { thread: shop, deadline: '4h', aim: '2h' })).status, 200);
  assert.ok(near(thread(shop).deadline, 4 * HOUR) && near(thread(shop).aim, 2 * HOUR));
  // by its pull request (the thread of the work job on its branch), widened: the aim stays
  assert.equal((await h.finish(run, { pr: 9101, branch: `job/${running}`, sha: SHA })).status, 200);
  assert.equal((await h.agent('window', kit.token, { pr: 9101, deadline: '5h' })).body.thread, shop);
  assert.ok(near(thread(shop).deadline, 5 * HOUR) && near(thread(shop).aim, 2 * HOUR), 'the aim kept');
  // tightened before the aim: the aim moves to the deadline
  assert.equal((await h.agent('window', kit.token, { thread: shop, deadline: '1h' })).status, 200);
  assert.ok(near(thread(shop).deadline, HOUR));
  assert.equal(thread(shop).aim, thread(shop).deadline, 'the aim at the deadline');
  // an aim after the deadline is refused, and nothing changes
  const was = thread(shop);
  const late = await h.agent('window', kit.token, { thread: shop, deadline: '2h', aim: '3h' });
  assert.equal(late.status, 400);
  assert.match(late.body.error, /aim .* is after the deadline/);
  assert.deepEqual(thread(shop), was);
  // none takes it off, aim and all
  assert.equal((await h.agent('window', kit.token, { thread: shop, deadline: 'none' })).status, 200);
  assert.deepEqual([thread(shop).deadline, thread(shop).aim, thread(shop).deadline_by], [null, null, null]);
  const loose = jobs.createJob({ agent: 'bolt', title: 'Loose', prompt: 'x', thread: null }).id;
  for (const [body, status, why] of [
    [{ job: running, deadline: 'tonight' }, 400, 'a time it can read'],
    [{ job: running, deadline: '2h', aim: 'soon' }, 400, 'an aim it can read'],
    [{ job: running, deadline: 'none', aim: '1h' }, 400, 'none takes no aim'],
    [{ deadline: '2h' }, 400, 'a thread, job or pull request'],
    [{ job: running, pr: 9101, deadline: '2h' }, 400, 'only one'],
    [{ job: 999999, deadline: '2h' }, 409, 'a job that is there'],
    [{ pr: 424242, deadline: '2h' }, 409, 'a pull request that is there'],
    [{ job: loose, deadline: '2h' }, 409, 'a job in a thread'],
    [{ thread: 'shop/nothing', deadline: '2h' }, 409, 'a thread that is there'],
  ] as const)
    assert.equal((await h.agent('window', kit.token, body)).status, status, why);
  // (the thread's branch holds the pushed work: its merge clears the branch, and the thread is done once closed)
  h.mergedPr(9101);
  threadends.merged(9101);
  assert.equal(
    (await h.agent('plan/done', (await h.start({ agent: 'moss', title: 'x' })).token, { thread: shop })).status,
    200,
  );
  const done = await h.agent('window', kit.token, { thread: shop, deadline: '2h' });
  assert.equal(done.status, 409, 'an open thread');
  assert.match(done.body.error, new RegExp(`${shop} is done: a window goes on an open deliverable`));
});

test("a call's item with its time sets its thread's window when it's handed out: deadline and aim at its time, from the call's agent", async () => {
  const shop = opened(),
    kit = await h.start({ agent: 'kit', title: 'x' });
  assert.equal((await h.agent('window', kit.token, { thread: shop, deadline: '6h', aim: '5h' })).status, 200);
  const ctx = await h.voice('call-context?agent=juno&request=0');
  assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
  const promise = await h.agent('item', ctx.body.token, {
    kind: 'promise',
    goal: 'The board wants it on time.',
    owner: 'bolt',
    what: 'The deck',
    deadline: '2h',
  });
  assert.equal(promise.status, 200, JSON.stringify(promise.body));
  const due = (db.prepare('select due from call_items where id = ?').get(promise.body.id) as { due: number }).due;
  const handed = await h.agent('job', ctx.body.token, {
    agent: 'bolt',
    title: 'The deck',
    prompt: 'Make it.',
    item: promise.body.id,
    thread: shop,
  });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.deadline, new Date(due).toISOString());
  assert.deepEqual([thread(shop).deadline, thread(shop).aim, thread(shop).deadline_by], [due, due, 'juno']);
});

test("a due thread's whole chain goes first: its work, the reviews and fixes on its branches, and the work it waits for at any depth", async () => {
  const soon = Date.now() + HOUR,
    later = Date.now() + 2 * HOUR;
  const due = h.dueThread({ deadline: soon }),
    dueLater = h.dueThread({ deadline: later }),
    plain = opened();
  // the due thread's work waits for work in another thread, which waits for more: two levels down (each in a thread
  // of its own, to run at once)
  const deep = await h.start({ agent: 'kit', title: 'The fonts', thread: opened() });
  const base = await h.start({ agent: 'kit', title: 'Header', thread: plain });
  const board = await h.start({ agent: 'kit', title: 'Front page', thread: due });
  // each in review on its pull request (review.test.ts covers how it gets there)
  for (const [j, pr] of [
    [deep, 9013],
    [base, 9011],
    [board, 9012],
  ] as const) {
    assert.equal((await h.finish(j)).status, 200);
    h.storedPr(pr, j.id, 'open', [], { sha: SHA, round: 1, since: j.id });
  }
  const walk = jobs.createJob({
    agent: 'juno',
    title: 'Walk the shop',
    prompt: 'x',
    thread: due,
    after: base.id,
    queuedBy: 'juno',
  });
  assert.deepEqual(jobs.addWait(walk.id, deep.id, 'juno'), { ok: true });
  const engine = 'order',
    ids = {
      otherReview: jobs.createJob({
        agent: 'quill',
        title: 'Review other',
        prompt: 'x',
        kind: 'review',
        pr: 9010,
        round: 1,
        branch: 'job/elsewhere',
        engine,
      }).id,
      urgent: jobs.createJob({ agent: 'juno', title: 'The board on: a card', prompt: 'x', engine }).id,
      deepReview: jobs.createJob({
        agent: 'quill',
        title: 'Review fonts',
        prompt: 'x',
        kind: 'review',
        pr: 9013,
        round: 1,
        branch: `job/${deep.id}`,
        engine,
      }).id,
      baseReview: jobs.createJob({
        agent: 'quill',
        title: 'Review header',
        prompt: 'x',
        kind: 'review',
        pr: 9011,
        round: 1,
        branch: `job/${base.id}`,
        engine,
      }).id,
      boardFix: jobs.createJob({
        agent: 'kit',
        title: 'Fixing review notes',
        prompt: 'x',
        pr: 9012,
        branch: `job/${board.id}`,
        stage: 'fix',
        engine,
      }).id,
      laterWork: jobs.createJob({ agent: 'kit', title: 'New page', prompt: 'x', thread: dueLater, engine }).id,
    };
  const name = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  assert.deepEqual(
    (await claimed(engine, 6)).map(id => name[id!]),
    ['deepReview', 'baseReview', 'boardFix', 'laterWork', 'otherReview', 'urgent'],
  );
});

test("a card rings from work the pass gives a latest start (a due thread's, work it waits for) and the board's own", async () => {
  const due = h.dueThread({ deadline: Date.now() + HOUR }),
    plain = opened();
  // (each running in a thread of its own, the due thread's first: a task queued ahead in its thread holds the next)
  const needed = await h.start({ agent: 'kit', title: 'The fonts', thread: plain });
  const own = await h.start({ agent: 'kit', title: 'The header', thread: due });
  jobs.createJob({
    agent: 'juno',
    title: 'Walk the shop',
    prompt: 'x',
    thread: due,
    after: needed.id,
    queuedBy: 'juno',
  });
  const other = await h.start({ agent: 'kit', title: 'The footer', thread: opened() });
  const call = await h.start({ agent: 'juno', title: "The call's follow-up", thread: opened() });
  h.storedCall(1, 'juno', call.id);
  const rings = async (job: Running) =>
    (db.prepare('select urgency from requests where id = ?').get(await h.ask(job)) as { urgency: string }).urgency;
  assert.deepEqual(
    [await rings(needed), await rings(own), await rings(other), await rings(call)],
    ['now', 'now', 'today', 'now'],
  );
});

test("a deadline orders the claim even once it's past, after the windows still open; a done thread's orders nothing", async () => {
  const engine = 'urgency',
    now = Date.now();
  const ahead = jobs.createJob({
    agent: 'kit',
    title: 'Ahead',
    prompt: 'x',
    thread: h.dueThread({ deadline: now + HOUR }),
    engine,
  }).id;
  const past = jobs.createJob({
    agent: 'kit',
    title: 'Past',
    prompt: 'x',
    thread: h.dueThread({ deadline: now - 25 * HOUR }),
    engine,
  }).id;
  const closed = h.dueThread({ deadline: now + 10 * MINUTE });
  assert.deepEqual(plan.done(closed, 'juno'), { ok: true });
  const done = jobs.createJob({ agent: 'kit', title: 'Closed', prompt: 'x', thread: closed, engine }).id;
  const plain = jobs.createJob({ agent: 'kit', title: 'Plain', prompt: 'x', engine }).id;
  assert.deepEqual(await claimed(engine, 4), [ahead, past, done, plain]);
});

test("the queue's play uses latest starts before unwindowed older work", () => {
  const T = Date.now(),
    engine = 'claude';
  const plain = jobs.createJob({ agent: 'kit', title: 'Plain', prompt: 'x', engine }).id;
  const due = jobs.createJob({
    agent: 'kit',
    title: 'Due',
    prompt: 'x',
    engine,
    thread: h.dueThread({ deadline: T + 5 * HOUR }),
  }).id;
  const play = forecast.refresh(T);
  assert.ok(
    play.usual.get(due)!.start! < play.usual.get(plain)!.start!,
    'the due work starts before unwindowed older work',
  );
});

test("hq window's plays from one read of the queue are the plays of the queue read again with the window set", () => {
  const T = Date.now(),
    engine = 'claude';
  const [first, second, third] = [opened(), opened(), h.dueThread({ deadline: T + 4 * HOUR })];
  const waited = jobs.createJob({ agent: 'kit', title: 'Laid first', prompt: 'x', engine, thread: first }).id;
  jobs.createJob({ agent: 'moss', title: 'On top of it', prompt: 'x', engine, thread: second, after: waited });
  jobs.createJob({ agent: 'kit', title: 'Already due', prompt: 'x', engine, thread: third });
  jobs.createJob({ agent: 'kit', title: 'Unthreaded', prompt: 'x', engine });
  const outlooks = (f: { threads: Map<string, any> }) =>
    [...f.threads.values()].map(({ thread, eta, finish, deadline, aim, slack, chain }) => ({
      thread,
      eta,
      finish,
      deadline,
      aim,
      slack,
      chain,
    }));
  for (const [id, window] of [
    [second, { deadline: T + HOUR, aim: T + HOUR }],
    [first, { deadline: T + 2 * HOUR, aim: T + 90 * MINUTE }],
    [third, null],
  ] as const) {
    const played = forecast.trial(T);
    const read = inOneStep(() => (windows.set(thread(id), window, 'kit'), forecast.play(T)), { keep: false });
    assert.deepEqual(
      outlooks(played(q => windows.withWindow(q, id, window))),
      outlooks(read),
      `${id}: ${JSON.stringify(window)}`,
    );
  }
});

test("HQ's queue ranks two jobs the plan starts together in the claim's order, not by age", async () => {
  assert.equal(
    (
      await h.worker('room', {
        capacity: { slots: { claude: 2, codex: 1 }, seatRuns: { claude: 2, codex: 1 }, room: 3 },
      })
    ).status,
    200,
  );
  const T = Date.now(),
    engine = 'claude';
  const plain = jobs.createJob({ agent: 'kit', title: 'Plain', prompt: 'x', engine }).id;
  const due = jobs.createJob({
    agent: 'kit',
    title: 'Due',
    prompt: 'x',
    engine,
    thread: h.dueThread({ deadline: T + 5 * HOUR }),
  }).id;
  forecast.refresh(T);
  const [older, newer] = [plain, due].map(id => jobs.findJob(id, T)!);
  assert.equal(older.start, newer.start, 'two free slots: the plan starts both at once');
  assert.deepEqual([newer.rank, older.rank], [0, 1], 'the later latest start ranks second, though older');
  assert.deepEqual(await claimed(engine, 2), [due, plain], 'and the claim hands them out so');
});

test("the board's answer on a card from a due thread's work is on that thread: due, and its card rings", async () => {
  const at = Date.now() + 2 * HOUR,
    due = h.dueThread({ deadline: at });
  const asker = await h.start({ agent: 'moss', title: 'The slide: send its card', queuedBy: 'juno', thread: due });
  const card = (
    await h.agent('request', asker.token, {
      kind: 'decision',
      title: 'The slide: good now?',
      body: 'b',
      urgency: 'today',
    })
  ).body.id;
  assert.equal((db.prepare('select urgency from requests where id = ?').get(card) as any).urgency, 'now');
  await h.finish(asker);
  await h.answer(card, 'Move the circle to the left');
  const answer = db
    .prepare("select id, thread, prompt from jobs where title = 'The board on: The slide: good now?'")
    .get() as any;
  assert.equal(answer.thread, due);
  const { engine } = db.prepare('select engine from jobs where id = ?').get(answer.id) as { engine: string };
  const run = await h.claim(engine);
  assert.equal(run?.id, answer.id);
  const again = await h.ask(run!);
  assert.equal((db.prepare('select urgency from requests where id = ?').get(again) as any).urgency, 'now');
});

test("the CEO's summary names a thread whose planned finish is past its deadline, and who gave the time", () => {
  const T = Date.now(),
    due = h.dueThread({ deadline: T + 10 * MINUTE, by: 'kit' });
  jobs.createJob({ agent: 'bolt', title: 'The shop page', prompt: 'x', thread: due, engine: 'claude' });
  const [line] = threats.lines(forecast.refresh(T)).filter(l => l.includes(due));
  assert.match(
    line,
    new RegExp(`^deliverable ${due} \\(.*\\): finish .*, .* past its deadline .*, set by kit\\. Held by: `),
  );
  windows.set(windows.threadOf({ thread: due }) as any, { deadline: T + 10 * HOUR, aim: T + 10 * HOUR }, 'juno');
  assert.deepEqual(
    threats.lines(forecast.refresh(T)).filter(l => l.includes(due)),
    [],
    'on time against the new one',
  );
});

test('board follow-ups lead windowed work; unwindowed work, reviews and fixes follow age', async () => {
  const engine = 'claude';
  const fresh = jobs.createJob({ agent: 'kit', title: 'New page', prompt: 'x', engine }).id;
  const review = jobs.createJob({
    agent: 'quill',
    title: 'Review',
    prompt: 'x',
    kind: 'review',
    pr: 9030,
    round: 1,
    branch: 'job/9030',
    engine,
  }).id;
  const fix = jobs.createJob({
    agent: 'kit',
    title: 'Fixing review notes',
    prompt: 'x',
    pr: 9031,
    branch: 'job/9031',
    stage: 'fix',
    engine,
  }).id;
  const urgent = jobs.createJob({ agent: 'kit', title: 'The board on: a card', prompt: 'x', engine }).id;
  const due = jobs.createJob({
    agent: 'kit',
    title: 'Windowed',
    prompt: 'x',
    engine,
    thread: h.dueThread({ deadline: Date.now() + HOUR }),
  }).id;
  assert.equal((await h.voice('call-end', { agent: 'kit', lines: ['Board: Follow up this call.'] })).status, 200);
  const call = (await h.board('/api/calls')).body[0].job;
  assert.equal(typeof call, 'number');
  assert.deepEqual(
    await claimed(engine, 6),
    [call, due, fresh, review, fix, urgent],
    "the call follow-up leads the window, and a card's answer alone gives no lane",
  );
});

// Last: it has the forecast watch for changes (forecast.start), so the latest forecast is kept between plays.
test("hq window --try saves nothing: the thread's row, the latest forecast and the prediction log stay, while the answer shows what it moves and misses", async () => {
  const T = Date.now(),
    engine = 'claude';
  const [first, second] = [opened(), opened()];
  jobs.createJob({ agent: 'kit', title: 'First in line', prompt: 'x', engine, thread: first });
  jobs.createJob({ agent: 'kit', title: 'Second in line', prompt: 'x', engine, thread: second });
  const kit = await h.start({ agent: 'kit', title: 'x' });
  forecast.start();
  forecast.refresh(T);
  const finishes = async () => {
    const shown = await h.agent('projects', kit.token);
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    return shown.body
      .filter((t: { id: string }) => t.id === first || t.id === second)
      .map((t: { id: string; outlook: { eta: number | null } }) => ({ thread: t.id, eta: t.outlook.eta }));
  };
  const planned = await finishes();
  // (the rows the plays kept, written first)
  const logged = () =>
    (predictionlog.write(), db.prepare('select count(*) n from prediction_log').get() as { n: number }).n;
  const [row, log] = [thread(second), logged()];
  const tried = await h.agent('window', kit.token, { thread: second, deadline: '1m', try: true });
  assert.equal(tried.status, 200, JSON.stringify(tried.body));
  assert.equal(tried.body.tried, true);
  assert.deepEqual(thread(second), row, "the thread's row as it was");
  assert.deepEqual(await finishes(), planned, 'the displayed finishes as they were');
  assert.equal(logged(), log, 'nothing logged');
  // the window would put the second first: both threads move, and its own window, a minute away, misses
  assert.deepEqual(tried.body.moves.map((m: { thread: string }) => m.thread).sort(), [first, second].sort());
  assert.deepEqual(
    tried.body.misses.map((m: { thread: string }) => m.thread),
    [second],
  );
  // hq window prints it, a line each
  const cli = await h.hq(kit, 'window', second, '1m', '--try');
  assert.equal(cli.code, 0, cli.out);
  assert.match(
    cli.out,
    new RegExp(
      `^Tried ${second}: deadline .* UTC, aim .* UTC\\.\nNothing was saved\\.\n(Moves The shop's Shop work \\d+ by [-+].*\\.\n){2}Misses The shop's Shop work \\d+: deadline .* UTC, planned finish .* UTC\\.\n$`,
    ),
  );
  assert.deepEqual(thread(second), row);
  // set for real, the same answer, and it's kept: the request plays nothing more, the queue is played whole a moment
  // later as for any change (forecast.playSoon), and that play is the latest forecast and logged
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const set = await h.agent('window', kit.token, { thread: second, deadline: '1m' });
    assert.equal(set.body.tried, false);
    assert.deepEqual(set.body.moves.map((m: { thread: string }) => m.thread).sort(), [first, second].sort());
    assert.notEqual(thread(second).deadline, null);
    assert.deepEqual(await finishes(), planned, 'shown as last played until the play a moment later');
    assert.equal(logged(), log);
    mock.timers.tick(10_000);
  } finally {
    mock.timers.reset();
  }
  assert.notDeepEqual(await finishes(), planned, 'the new displayed finishes are kept');
  assert.ok(logged() > log, 'and logged');
});
