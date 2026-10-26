// node --test src/when.test.ts   (uses a throwaway DATA_DIR): hq when, new work played into the plan as it stands: the
// earliest it can be done without making any window miss, and with --by whether it makes that time and, only if not,
// what would, as played (windows giving, one more seat).
import { writeFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('when');

const MIN = 60_000,
  HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());

const { markMerged } = await import('./work.ts');
const wakes = await import('./wakes.ts');

// Done jobs of kit's (or `agent`'s) two days ago, `minutes` long, merged an hour after: what new work like them is sized on. Each runs
// through the worker's routes on the clock; its pull request is the review fixture's, merged as review.ts marks it.
let prs = 100;
async function past(title: string, minutes: number, agent = 'kit') {
  const ended = T0 - 48 * HOUR;
  mock.timers.setTime(ended - minutes * MIN);
  const job = await h.start({ agent, title, queuedBy: 'juno' });
  mock.timers.setTime(ended);
  assert.equal((await h.finish(job)).status, 200);
  h.storedPr(++prs, job.id, 'open');
  mock.timers.setTime(ended + HOUR);
  markMerged(prs);
  mock.timers.setTime(T0);
}
await past('Paint the harbour map', 30);
await past('Paint the harbour map in winter', 40);
await past('Paint the harbour map at night', 50);
for (const title of ['Catalogue the old letters', 'Catalogue the new letters', 'Catalogue the lost letters'])
  await past(title, 48 * 60, 'moss');

let sizingReader: ReturnType<typeof h.start> | undefined;
const reader = () => (sizingReader ??= h.start({ agent: 'bolt', title: 'Planning', kind: 'chat' }));
// The one claude seat, its fill rates measured over an hour of a run on it (headroom.ts); codex's seat is reported once,
// so its rates aren't measured. The worker runs one job of each at once.
const reading = (seat: string, engine: string, used: number) =>
  h.worker('seat', {
    seat,
    engine,
    state: 'ready',
    util: used,
    week: used,
    resets: T0 + 5 * HOUR,
    weekResets: T0 + 7 * 24 * HOUR,
  });
test.before(async () => {
  mock.timers.setTime(T0 - 2 * HOUR);
  await reading('claude-a', 'claude', 0.1);
  const run = await h.start({ agent: 'bolt', title: 'Measuring the seat' }, { seat: 'claude-a' });
  mock.timers.setTime(T0 - HOUR);
  await reading('claude-a', 'claude', 0.12);
  await h.finish(run);
  mock.timers.setTime(T0);
  await reading('codex-a', 'codex', 0.1);
  await h.worker('room', {
    short: false,
    free: 8192,
    jobs: [],
    capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 16 },
  });
});
// Anything queued cancelled, and the threads it leaves open and empty closed (an open thread with no task plays as its
// owner's placeholder in the forecast)
const clear = () => {
  h.cancelQueued();
  h.closedThreads();
};
test.afterEach(async () => {
  clear();
  await h.worker('room', { capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 16 } });
});

const ask = async (query: Record<string, string>) =>
  h.agent(`when?${new URLSearchParams({ agent: 'kit', size: '40m', ...query })}`, (await reader()).token);
// Spring: kit's queued work on its own thread, alone done (merged and deployed) at T0 + 90 min, with `slack` minutes past
// that to its deadline: its thread's id. Anything queued before is cancelled. held: minutes it doesn't start before
// (a time it waits for: hq job --when), which its deadline counts.
const SPRING_DONE = T0 + 90 * MIN;
const spring = (slack: number, held = 0) => {
  clear();
  const thread = h.dueThread({ deadline: SPRING_DONE + (held + slack) * MIN });
  const job = h.queue({
    agent: 'kit',
    title: 'Paint the harbour map for spring',
    engine: 'claude',
    queuedBy: 'juno',
    thread,
  });
  if (held) wakes.hold(job, [{ kind: 'at', arg: String(T0 + held * MIN) }]);
  return thread;
};
const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const hqWhen = async (...args: string[]) => {
  const size = args[0]?.match(/^\d+[mh]$/) ? args.shift()! : '40m';
  const r = await h.hq(await reader(), 'when', 'paint the harbour map', '--agent', 'kit', '--size', size, ...args);
  assert.equal(r.code, 0, r.out);
  return r.out;
};

test('the earliest without making any window miss: ahead of work whose window can give, never of work whose can not', async () => {
  spring(5 * 60);
  const loose = (await ask({ q: 'paint the harbour map' })).body;
  assert.deepEqual([loose.size.agent_minutes, loose.size.given, loose.size.compared], [40, true, 0]);
  const time = loose.earliest.time;
  assert.equal(time.work_ms, 40 * MIN);
  assert.ok(time.review_ms > 0);
  assert.equal(time.total_ms, loose.earliest.finish - T0);
  assert.equal(time.work_ms + time.review_ms + time.waiting_ms + time.deploy_ms, time.total_ms);
  assert.match(await hqWhen(), /Time from this quote to live: .* work.* review.* waiting.* deploy.* total/);
  // with no window it runs on the room spring's window leaves; with one, it goes first, as spring's window holds
  assert.equal(loose.free.waits[0].on, 'queue');
  assert.deepEqual([loose.earliest.start, loose.earliest.finish, loose.earliest.gives], [T0, SPRING_DONE, []]);
  assert.ok(
    loose.earliest.due >= loose.earliest.finish && loose.earliest.due < loose.free.finish,
    JSON.stringify(loose),
  );
  assert.match(await hqWhen(), /paint the harbour map, as kit's work: 40 min of agent time \(as given\)/);
  assert.match(await hqWhen(), /Its window for that: deadline .*, aim .*\. With no window at all it's done about/);
  // A later window preserves spring's deadline and finishes at the unwindowed time.
  spring(0);
  const tight = (await ask({ q: 'paint the harbour map' })).body;
  assert.deepEqual([tight.earliest.finish, tight.earliest.due], [tight.free.finish, tight.free.finish]);
  assert.ok(tight.free.finish > SPRING_DONE);
  const out = await hqWhen();
  assert.match(out, /At the earliest without making any window miss: done about .*\.\nIts window for that:/);
  assert.match(out, /\(Played \d+ ways on the queue as it is, in \d+\.\d s\.\)/);
});

test('a quote that plays the queue many ways leaves room for other requests: they are answered first', async () => {
  // six of moss's two-day jobs on a thread due on day 7: no deadline holds before the end of the play's reach, so the
  // search plays a deadline in every span between them
  const thread = h.dueThread({ deadline: T0 + 7 * 24 * HOUR });
  h.cancelQueued();
  for (let i = 0; i < 6; i++)
    h.queue({ agent: 'moss', title: `Catalogue the letters, box ${i}`, engine: 'claude', queuedBy: 'juno', thread });
  const { token } = await reader();
  const answered: string[] = [];
  // the other request goes once the quote has reached HQ
  const sent = new Promise<unknown>(resolve =>
    h.server!.once('request', () => resolve(h.agent('jobs', token).then(() => answered.push('jobs')))),
  );
  const quote = ask({ q: 'paint the harbour map' }).then(() => answered.push('quote'));
  await Promise.all([quote, sent]);
  assert.deepEqual(answered, ['jobs', 'quote']);
});

test("each agreed deadline as the answer's play leaves it, against the plan without the work: facts, no verdict", async () => {
  const thread = spring(5 * 60);
  const { earliest, free } = (await ask({ q: 'paint the harbour map' })).body;
  // the work goes ahead of spring, whose deadline gives it the room: spring ends later, inside its window
  const [deadline] = earliest.deadlines;
  assert.equal(earliest.deadlines.length, 1, JSON.stringify(earliest.deadlines));
  assert.deepEqual([deadline.thread, deadline.before, deadline.trend], [thread, SPRING_DONE, []]);
  assert.ok(deadline.finish > SPRING_DONE, JSON.stringify(deadline));
  assert.equal(deadline.slack_ms, deadline.deadline - deadline.finish);
  // with no window, the work runs on the room spring leaves, and spring's finish stays
  assert.equal(free.deadlines[0].finish, SPRING_DONE);
  const out = await hqWhen();
  assert.match(
    out,
    /\nAgreed deadlines \(thread windows\):\n- .*: deadline .* UTC \(given by juno\); done about .* UTC, [\d hmin]+ of slack \(the work takes [\d hmin]+\)\.\nAn agreed deadline its finish passes is yours to move back first; the board hears of it when nothing does or it asks\. A tight or shrinking margin is yours to plan with/,
  );
  assert.doesNotMatch(out, /\b(safe|tight|moving):/, 'the facts, never a verdict');
});

test("no time holds every window: work its window counts on starting later can't be overtaken, and the answer says so", async () => {
  // Spring has no margin for even an immediate deadline pause after it becomes ready.
  const thread = spring(0, 10);
  const none = (await ask({ q: 'paint the harbour map' })).body.earliest;
  assert.equal(none.found, false);
  assert.deepEqual(
    none.gives.map((g: { thread: string }) => g.thread),
    [thread],
  );
  assert.match(
    await hqWhen(),
    new RegExp(
      `No time in the next 8 days holds every window\\.\\nWith its deadline as late as .* or none: done about .*, and these windows miss:\\n- ${thread} \\(Due: Thread \\d+\\) past its deadline .* by \\d+ min`,
    ),
  );
});

test('no finish in the play with no window: the earliest is searched for within its reach all the same', async () => {
  // six of moss's two-day jobs fill the one claude slot past the play's 8 days: with no window, then each on a thread
  // of its own due on day 7, which a deadline at the end of the reach queues the work behind, and a sooner one ahead
  // of; then due two days and two hours out, where the work goes ahead of them only for a deadline between 80 and 160
  // minutes out (the order changes in between). (A thread each: in one thread they'd run one after another, its window
  // missed already.)
  for (const deadline of [null, T0 + 7 * 24 * HOUR, T0 + 48 * HOUR + 120 * MIN]) {
    clear();
    for (let i = 0; i < 6; i++)
      h.queue({
        agent: 'moss',
        title: `Catalogue the letters, box ${i}`,
        engine: 'claude',
        queuedBy: 'juno',
        thread: deadline && h.dueThread({ deadline }),
      });
    const { free, earliest } = (await ask({ q: 'paint the harbour map' })).body;
    assert.equal(free.finish, null);
    assert.deepEqual([earliest.found, earliest.start, earliest.gives], [true, T0, []]);
    assert.ok(earliest.finish <= earliest.due && earliest.finish < T0 + 2 * HOUR, JSON.stringify(earliest));
    assert.match(
      await hqWhen(),
      /Its window for that: deadline .*\. With no window at all it has no finish in sight\./,
    );
  }
});

test('--by: whether it makes the time, and only if not, what would, as played: windows giving, one more seat', async () => {
  await h.worker('room', { capacity: { slots: { claude: 2, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 16 } });
  const by = async (time: number) => (await ask({ q: 'paint the harbour map', by: utc(time) })).body.by;
  spring(45);
  const yes = await by(T0 + 160 * MIN);
  assert.deepEqual([yes.makes, yes.due, yes.gives], [true, T0 + 160 * MIN, []]);
  assert.match(
    await hqWhen('--by', utc(T0 + 160 * MIN)),
    /By .*: yes, done about .* with every window held\. Its window: deadline/,
  );
  const thread = spring(0);
  const unwindowed = await by(T0 + 160 * MIN);
  assert.deepEqual([unwindowed.makes, unwindowed.due, unwindowed.gives], [true, T0 + 160 * MIN, []]);
  assert.match(await hqWhen('--by', utc(T0 + 160 * MIN)), /yes, done about .* with every window held/);
  // sooner: with its windows held one claude slot can't. Ahead of spring, it's done in time if spring's window gives;
  // and one more seat does it with every window held
  const sooner = await by(T0 + 100 * MIN);
  assert.deepEqual([sooner.makes, sooner.giving], [false, true]);
  assert.ok(sooner.finish <= T0 + 100 * MIN, JSON.stringify(sooner));
  assert.deepEqual(
    sooner.widen.map((g: { thread: string }) => g.thread),
    [thread],
  );
  assert.ok(sooner.seat.makes && sooner.seat.finish <= T0 + 100 * MIN, JSON.stringify(sooner.seat));
  assert.match(
    await hqWhen('--by', utc(T0 + 100 * MIN)),
    new RegExp(
      `By .* only if these windows give for it \\(done about .*\\):\\n- ${thread} \\(Due: Thread \\d+\\) past its deadline .* by .+\\nOr with one more claude seat: done about .*, no window giving \\(its deadline .*\\)\\.`,
    ),
  );
  // spring's window passed yesterday, so a deadline at the time asked still leaves the new work behind it: with every
  // other window relaxed, it goes first, and spring's window gives
  const overdue = spring(-24 * 60);
  const late = await by(T0 + 100 * MIN);
  assert.deepEqual([late.makes, late.giving], [false, true]);
  assert.ok(late.finish <= T0 + 100 * MIN, JSON.stringify(late));
  assert.deepEqual(
    late.widen.map((g: { thread: string }) => g.thread),
    [overdue],
  );
  // ten minutes of work by T0 + 80: a deadline then leaves it behind spring, with no window it comes last, but a sooner
  // deadline (60 minutes out) puts it first with spring still inside its window
  const tenBy = async (time: number) => (await ask({ q: 'paint the harbour map', size: '10m', by: utc(time) })).body.by;
  spring(60);
  const tighter = await tenBy(T0 + 80 * MIN);
  assert.deepEqual([tighter.makes, tighter.due, tighter.gives], [true, T0 + 60 * MIN, []]);
  assert.match(
    await hqWhen('10m', '--by', utc(T0 + 80 * MIN)),
    /By .*: yes, done about .* with every window held\. Its window: deadline .*, aim .*\./,
  );
  // with less slack, no deadline it can make puts it ahead of spring, which the plan orders first on its slow size;
  // played ahead anyway it's done in time and spring still is too: spring's window has to widen, not miss
  const widened = spring(40);
  const ahead = await tenBy(T0 + 80 * MIN);
  assert.deepEqual([ahead.makes, ahead.giving, ahead.gives], [false, true, []]);
  assert.deepEqual(
    ahead.widen.map((g: { thread: string; past_ms: number }) => [g.thread, g.past_ms <= 0]),
    [[widened, true]],
  );
  assert.match(
    await hqWhen('10m', '--by', utc(T0 + 80 * MIN)),
    new RegExp(`only if these windows give for it .*:\\n- ${widened} .* still done by its deadline .*, once widened`),
  );
  spring(0);
  // sooner than the work itself takes: neither does, each as played
  const never = await by(T0 + 20 * MIN);
  assert.deepEqual([never.makes, never.giving, never.seat.makes], [false, false, false]);
  assert.match(
    await hqWhen('--by', utc(T0 + 20 * MIN)),
    /Not by .* even with the windows ahead of it giving way: done about .*\.\nNot by .* with one more claude seat and every window held: done about .*\./,
  );
  assert.doesNotMatch(await hqWhen('--by', utc(T0 + 20 * MIN)), /RED FLAG/);
  // on a call, a finish past the board's time comes with what to check and do before the board hears it: one
  // instruction with the agreed deadline the play misses
  const onCall = await h.hq(
    { ...(await reader()), call: true },
    'when',
    'paint the harbour map',
    '--agent',
    'kit',
    '--size',
    '40m',
    '--by',
    utc(T0 + 20 * MIN),
  );
  assert.match(
    onCall.out,
    /RED FLAG, not news for the board: this work lands \d.* past the time asked for \([^)]*\); Due's Thread \d+ misses its deadline\. Before you say a time/,
  );
  assert.match(
    onCall.out,
    /- the size: [^]*- the plan: [^]*- other work [^]*- the window: [^]*If one moves it forward/,
  );
  // a seat whose fill rates aren't measured (codex's) isn't copied, nor said to be no help, and the plays say they
  // returned a conditional finish without a measured exhaustion time
  const unseated = (await ask({ q: 'paint the harbour map', agent: 'nib', by: utc(T0 + 20 * MIN) })).body.by;
  assert.deepEqual([unseated.makes, unseated.seat, unseated.unpriced], [false, null, ['codex-a']]);
  assert.match(
    (
      await h.hq(
        await reader(),
        'when',
        'paint the harbour map',
        '--agent',
        'nib',
        '--size',
        '40m',
        '--by',
        utc(T0 + 20 * MIN),
      )
    ).out,
    /With one more codex seat: not played, as HQ has no codex seat with measured fill rates and reported slots to copy\.\n(.*\n)*Seat fill rates are not measured yet for codex-a: exhaustion times are unknown and these finishes are conditional\./,
  );
});

test('--by with one more seat: a sooner deadline on that seat is searched for too, never only the time asked', async () => {
  await h.worker('room', { capacity: { slots: { claude: 2, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 16 } });
  // two of kit's 40-minute jobs on threads of their own, both due T0 + 105 min, which one slot can't hold for both. Ten
  // minutes of work by T0 + 110 doesn't make it with every window held; with one more seat and a deadline at that
  // time, the plan orders it behind both and it's done too late, but a sooner deadline puts it first and every window
  // holds
  clear();
  for (const season of ['spring', 'autumn'])
    h.queue({
      agent: 'kit',
      title: `Paint the harbour map for ${season}`,
      engine: 'claude',
      queuedBy: 'juno',
      thread: h.dueThread({ deadline: T0 + 105 * MIN }),
    });
  const by = T0 + 110 * MIN;
  const seat = (await ask({ q: 'paint the harbour map', size: '10m', by: utc(by) })).body.by;
  assert.equal(seat.makes, false, JSON.stringify(seat));
  assert.ok(seat.seat.makes && seat.seat.due < by && seat.seat.finish <= by, JSON.stringify(seat.seat));
  assert.deepEqual(seat.seat.gives, []);
  assert.match(
    await hqWhen('10m', '--by', utc(by)),
    /with one more claude seat: done about .*, no window giving \(its deadline .*\)\./,
  );
});

test('a size given replaces the estimate; an ask it can not read says why', async () => {
  const given = (await ask({ q: 'paint the harbour map', size: '2h' })).body;
  assert.deepEqual([given.size.agent_minutes, given.size.given], [120, true]);
  for (const [query, why] of [
    [{ q: 'paint the harbour map', size: 'soon' }, 'can\'t read the size "soon"'],
    [{ q: 'paint the harbour map', after: '99999' }, "there's no job #99999"],
    [{ q: 'paint the harbour map', by: 'tomorrowish' }, 'can\'t read by "tomorrowish"'],
    [{ q: '' }, 'say what the work is'],
  ] as const) {
    const r = await ask(query);
    assert.equal(r.status, 400);
    assert.ok(r.body.error.startsWith(why), r.body.error);
  }
});

test('a quote for urgent work counts making room instead of waiting for the running work to finish', async () => {
  const running = await h.start(
    { agent: 'moss', engine: 'claude', title: 'Catalogue the letters, long running work' },
    { seat: 'claude-a' },
  );
  try {
    const query = { q: 'paint the harbour map', size: '10m', by: utc(T0 + 20 * MIN) };
    const quoted = (await ask(query)).body.by;
    assert.equal(quoted.start, T0 + MIN);
    assert.ok(quoted.waits.some((w: { on: string; pausing?: boolean }) => w.on === 'queue' && w.pausing));
    assert.ok(quoted.time.review_ms > 0);
    const { work_ms, review_ms, waiting_ms, deploy_ms, total_ms } = quoted.time;
    assert.equal(work_ms + review_ms + waiting_ms + deploy_ms, total_ms);
    const output = await hqWhen('10m', '--by', query.by);
    assert.match(output, /pausing lower-order work/);
    assert.match(output, /Time from this quote to live:/);
  } finally {
    await h.finish(running);
  }
});

test('an explicit added seat compares every project, thread and window without changing the plan', async () => {
  writeFileSync(`${h.repo}/company/seatplans.yaml`, 'claude-a: 20\n');
  spring(300);
  await h.worker('room', { capacity: { slots: { claude: 2, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 16 } });
  const other = h.dueThread({ deadline: T0 + 400 * MIN });
  h.queue({ agent: 'kit', title: 'Paint the harbour map at dusk', engine: 'claude', queuedBy: 'juno', thread: other });
  const before = await ask({ q: 'paint the harbour map' });
  const replay = async (plan: string) => h.agent(`when?extra_seat=${plan}`, (await reader()).token);
  const small = await replay('5x');
  const large = await replay('20x');
  assert.equal(small.status, 200);
  assert.equal(small.body.available, true);
  assert.equal(small.body.capacity.confidence, 'low');
  assert.equal(small.body.capacity.measured.fiveHours, 1);
  assert.equal(small.body.capacity.measured.weekHours, 1);
  assert.equal(small.body.capacity.five_per_agent_hour, large.body.capacity.five_per_agent_hour * 4);
  assert.equal(small.body.capacity.week_per_agent_hour, large.body.capacity.week_per_agent_hour * 4);
  const due = small.body.projects.find((p: { name: string }) => p.name === 'Due');
  assert.ok(due.threads.length > 0);
  assert.ok(due.threads.some((t: { window: { deadline: number | null } }) => t.window.deadline !== null));
  assert.ok(due.threads.every((t: { before: unknown; after: unknown }) => t.before && t.after));
  const after = await ask({ q: 'paint the harbour map' });
  assert.deepEqual(after.body.free, before.body.free);
  assert.ok(
    due.threads.some(
      (t: { before: { finish: number }; after: { finish: number } }) =>
        t.after.finish !== null && t.before.finish !== null && t.after.finish < t.before.finish,
    ),
  );
  await h.worker('room', { capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 1 } });
  const fullRoom = (await replay('20x')).body;
  for (const project of fullRoom.projects)
    for (const thread of project.threads) {
      assert.equal(thread.after.finish, thread.before.finish);
      assert.equal(thread.after.eta, thread.before.eta);
      assert.equal(thread.after.held, thread.before.held);
      assert.equal(thread.after.slack_ms, thread.before.slack_ms);
    }
  await h.worker('room', { capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { codex: 1 }, room: 16 } });
  assert.equal((await replay('20x')).body.available, true);
  await h.worker('room', { capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 16 } });

  const cli = await h.hq(await reader(), 'when', '--extra-seat', '5x');
  assert.equal(cli.code, 0, cli.out);
  assert.match(cli.out, /Hypothetical added Claude Max 5x/);
  assert.match(cli.out, /Before, usual pace seat predictions:/);
  assert.match(cli.out, /With added seat, usual pace seat predictions:/);
  assert.match(cli.out, /Thread finishes: \d+ earlier, \d+ later, \d+ unchanged, \d+ unresolved/);
  const eta = await h.hq(await reader(), 'projects', 'Due', '--extra-seat', '20x');
  assert.equal(eta.code, 0, eta.out);
  assert.match(eta.out, /Hypothetical added Claude Max 20x/);
  assert.equal((await replay('10x')).status, 400);
  writeFileSync(`${h.repo}/company/seatplans.yaml`, 'unknown-seat: 20\n');
  const unmeasured = await replay('5x');
  assert.equal(unmeasured.body.available, false);
  assert.equal(unmeasured.body.projects, undefined);
});

test('a 5x added seat exhausts its measured weekly allowance and waits for its own reset', async () => {
  writeFileSync(`${h.repo}/company/seatplans.yaml`, 'claude-a: 20\n');
  await reading('claude-a', 'claude', 0.99);
  const thread = h.dueThread({ deadline: T0 + 2 * 24 * HOUR });
  const job = h.queue({ agent: 'kit', title: 'Paint the harbour map', engine: 'claude', queuedBy: 'juno', thread });
  const sizes = await import('./sizes.ts');
  sizes.setSize(job, '15h', 'A measured long run', 'juno');
  const replay = async (plan: string) => (await h.agent(`when?extra_seat=${plan}`, (await reader()).token)).body;
  const small = await replay('5x');
  const large = await replay('20x');
  const name = (await h.agent(`thread?id=${thread}`, (await reader()).token)).body.name;
  const find = (r: typeof small) =>
    r.projects
      .flatMap((p: { threads: { name: string }[] }) => p.threads)
      .find((t: { name: string }) => t.name === name);
  const smallThread = find(small),
    largeThread = find(large);
  assert.ok(largeThread.after.finish < T0 + 2 * 24 * HOUR, JSON.stringify(largeThread));
  assert.ok(smallThread.after.finish > T0 + 5 * 24 * HOUR, JSON.stringify(smallThread));
  assert.equal(largeThread.after.standing, 'holds');
  assert.equal(smallThread.after.standing, 'misses');
});
