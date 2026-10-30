// node --test src/eta.test.ts   (uses a throwaway DATA_DIR): the agent time from done jobs like the work (hq estimate), its
// ETA from the queue played forward on the seats (a queued job's, and new work's: hq when), and hq estimate --accuracy.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('eta');
const predictions = await import('./predictions.ts');

const MIN = 60_000,
  HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
const at = (ms: number) => new Date(ms).toISOString();
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());

const firstGuess = h.queue({ agent: 'kit', title: 'Paint the lighthouse', engine: 'claude', queuedBy: 'juno' });

// A done job of kit's, queued by Juno, that ran `minutes` two days ago, its pull request merged `review` minutes after
// its end (null: none opened).
function past(title: string, minutes: number, review: number | null) {
  const ended = T0 - 48 * HOUR;
  return h.pastJob({
    title,
    run: { started: ended - minutes * MIN, ended },
    merged: review === null ? undefined : ended + review * MIN,
  });
}
past('Paint the harbour map', 30, 60);
past('Paint the harbour map in winter', 40, 60);
past('Paint the harbour map at night', 50, 60);

// Work kit queues now (a hand-off).
const queued = (title: string, o: { item?: number } = {}) =>
  h.queue({ agent: 'kit', title, engine: 'claude', queuedBy: 'juno', ...o });
const seat = (windows: Record<string, unknown> = {}) =>
  h.worker('seat', { seat: 'claude-a', engine: 'claude', state: 'ready', util: 0.1, week: 0.1, ...windows });
let sizingReader: ReturnType<typeof h.start> | undefined;
const reader = () => (sizingReader ??= h.start({ agent: 'bolt', title: 'Sizing', kind: 'chat' }));
const ask = async (query: Record<string, string>) => {
  await reportCapacity();
  const r = await h.agent(`estimate?${new URLSearchParams(query)}`, (await reader()).token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const harbour = { q: 'paint the harbour map', agent: 'kit' };
// New work played into the plan as if queued now (hq when): with no window, its start, merge and waits.
const when = async (query: Record<string, string>) => {
  await reportCapacity();
  const r = await h.agent(`when?${new URLSearchParams({ size: '40m', ...query })}`, (await reader()).token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const merged = r.body.free.finish === null ? null : r.body.free.finish - deployLag();
  return { ...r.body.free, merged };
};
const deployLag = () => predictions.played(T0, [], ['usual']).snapshot.deployLagMs as number;
const reportCapacity = () =>
  h.worker('room', {
    short: false,
    free: 8192,
    jobs: [],
    capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { claude: 1, codex: 1 }, room: 16 },
  });
test.before(async () => {
  await h.worker('seat', { seat: 'codex-a', engine: 'codex', state: 'ready', util: 0.1 });
});
const clear = () => h.db.exec("update jobs set status = 'cancelled' where status = 'queued'");
test.afterEach(clear);

test('a first guess stays saved when comparable history arrives later', async () => {
  await seat();
  const found = await ask({ q: `#${firstGuess}` });
  assert.deepEqual(
    [found.estimate.agent_minutes, found.estimate.guessed, found.estimate.compared, found.outlook.merged],
    [30, true, 0, T0 + 60 * MIN],
  );
});

test('new work uses the caller estimate and measured review runs', async () => {
  await seat();
  const found = await ask(harbour);
  assert.equal(found.estimate, undefined, 'the search supplies comparisons, not a chosen estimate');
  assert.deepEqual(
    found.jobs.map((job: { agent_minutes: number }) => job.agent_minutes).sort((a: number, b: number) => a - b),
    [30, 40, 50],
  );
  assert.equal(found.outlook, undefined);
  const planned = await when(harbour);
  assert.deepEqual([planned.start, planned.merged], [T0, T0 + 70 * MIN]);
  const { out, code } = await h.hq(await reader(), 'estimate', 'paint the harbour map', '--agent', 'kit');
  assert.equal(code, 0, out);
  assert.match(out, /40 min of agent time/);
});

test('work queued after another starts once that work is merged, and waits on it', async () => {
  await seat();
  const first = queued('Paint the harbour map for spring');
  const own = await ask({ q: `#${first}` });
  assert.equal(own.outlook.merged, T0 + 70 * MIN);
  const next = await when({ ...harbour, after: String(first) });
  assert.deepEqual([next.start, next.merged], [T0 + 70 * MIN, T0 + 140 * MIN]);
  assert.deepEqual(next.waits, [{ on: 'job', job: first }]);
  clear();
});

test("work queued behind other work on the engine's only slot starts when that ends", async () => {
  await seat();
  queued('Paint the harbour map for summer');
  const next = await when(harbour);
  assert.equal(next.start, T0 + 40 * MIN);
  assert.equal(next.waits[0].on, 'queue');
  clear();
});

test("a card the work waits on is answered at the board's usual time for one open that long, and the outlook names it", async () => {
  await seat();
  const card = (created: number, answered?: number) =>
    Number(
      h.db
        .prepare(
          "insert into requests (created, agent, kind, title, body, status, answered) values (?, 'kit', 'decision', 'Which harbour?', 'x', ?, ?)",
        )
        .run(at(created), answered ? 'answered' : 'open', answered ? at(answered) : null).lastInsertRowid,
    );
  // the board answered decisions in 2, 3 and 10 hours lately
  for (const hours of [2, 3, 10]) card(T0 - 2 * 24 * HOUR, T0 - 2 * 24 * HOUR + hours * HOUR);
  const waitOn = (request: number, title: string) => {
    const job = queued(title);
    h.db.prepare('insert into request_waits (job, request) values (?, ?)').run(job, request);
    return job;
  };
  // open an hour: of the answers that took longer, the middle one, 3 hours from its filing
  const fresh = card(T0 - HOUR);
  const own = await ask({ q: `#${waitOn(fresh, 'Paint the harbour map for the board')}` });
  assert.deepEqual([own.outlook.start, own.outlook.merged], [T0 + 2 * HOUR, T0 + 2 * HOUR + 70 * MIN]);
  assert.deepEqual(own.outlook.waits, [{ on: 'board', request: fresh, at: T0 + 2 * HOUR }]);
  assert.deepEqual(own.outlook.cards, [{ request: fresh, at: T0 + 2 * HOUR }]);
  clear();
  // open five hours: only the 10-hour answer took that long; open longer than any: as the play starts
  const old = card(T0 - 5 * HOUR);
  assert.equal(
    (await ask({ q: `#${waitOn(old, 'Paint the harbour map for the mayor')}` })).outlook.start,
    T0 + 5 * HOUR,
  );
  clear();
  const oldest = card(T0 - 11 * HOUR);
  const after = waitOn(oldest, 'Paint the harbour map for the council');
  assert.equal((await ask({ q: `#${after}` })).outlook.start, T0);
  const { out } = await h.hq(await reader(), 'estimate', `#${after}`);
  assert.match(out, new RegExp(`It counts on the board answering card #${oldest} by .*, as it usually does\\.`));
  clear();
  h.db.prepare('delete from request_waits').run();
  h.db.prepare('delete from requests').run();
});

test('the play is a function of its snapshot and sizes: played again, or from the snapshot kept as JSON, the same', async () => {
  await seat({ util: 0.5, resets: T0 + 3 * HOUR });
  const first = queued('Paint the harbour map for spring');
  queued('Paint the harbour map for summer');
  h.queue({
    agent: 'kit',
    title: 'Paint the harbour map for autumn',
    engine: 'claude',
    queuedBy: 'juno',
    after: first,
  });
  const { snapshot } = await import('./backlog.ts');
  const { play, PLAY_VERSION } = await import('./eta.ts');
  const queue = snapshot(T0);
  const sizes = new Map(queue.jobs.map(j => [j.id, { agent_ms: (20 + (j.id % 7) * 10) * MIN }]));
  const once = play(queue, sizes);
  assert.deepEqual(play(JSON.parse(JSON.stringify(queue)), sizes), once);
  assert.deepEqual(play(queue, sizes), once);
  assert.ok(Number.isInteger(PLAY_VERSION) && PLAY_VERSION >= 2);
  assert.throws(() => play(queue, new Map()), /no size for job/);
  clear();
});

test('the play and claim put windowed work before older unwindowed work', async () => {
  await seat();
  const older = queued('Paint the harbour map for the ferry');
  const fair = h.dueThread({ deadline: T0 + 5 * HOUR });
  const due = h.queue({
    agent: 'kit',
    title: 'Paint the harbour map for the fair',
    engine: 'claude',
    queuedBy: 'juno',
    thread: fair,
  });
  await reportCapacity();
  const [dueAt, olderAt] = [due, older].map(id => predictions.outlook(T0).get(id)!.start);
  assert.ok(dueAt! < olderAt!, 'the windowed work runs first');
  const claimed = (await h.claim('claude', { seat: 'claude-a' }))!;
  assert.equal(claimed.id, due, 'as the claim hands it out');
  h.db.prepare("update jobs set status = 'cancelled' where id = ?").run(claimed.id);
  // (closed: an open thread with no task plays as its owner's placeholder)
  h.closedThreads(fair);
  clear();
});

test('a paced seat holds undated work in the play until its pacing lifts, as the claim does', async () => {
  const reset = T0 + 48 * HOUR;
  await seat({ week: 0.8, weekResets: reset, pace: true });
  const undated = queued('Paint the harbour map for winter');
  await reportCapacity();
  const start = predictions.outlook(T0).get(undated)!.start!;
  assert.ok(start > T0 + 24 * HOUR && start < reset, 'held now, and let go before the reset');
  assert.equal(await h.claim('claude', { seat: 'claude-a', pacedUntil: reset }), null, 'nor does the claim start it');
  // (work carrying the board's call item is the board's word: the play starts it now, as the claim does)
  const carried = queued('Paint the harbour gate, as the board asked', { item: h.openItem('kit') });
  await reportCapacity();
  assert.ok(predictions.outlook(T0).get(carried)!.start! < T0 + HOUR, "the play doesn't hold it");
  assert.equal(
    (await h.claim('claude', { seat: 'claude-a', pacedUntil: reset }))?.id,
    carried,
    'and the claim starts it',
  );
  h.db.prepare("update jobs set status = 'cancelled' where id = ?").run(carried);
  await h.board('/api/seats/pacing', { on: false });
  assert.ok(predictions.outlook(T0).get(undated)!.start! < start, 'pacing off, it starts sooner');
  await h.board('/api/seats/pacing', { on: true });
  clear();
});

test("a time a promise holds to: the play once more at every size's slow pick, four in five of the done jobs like it", async () => {
  await seat();
  const id = queued('Paint the harbour map for the harbourmaster');
  predictions.sweep();
  const found = await ask({ q: `#${id}` });
  // The slow work takes 50 minutes, followed by the same two measured 15-minute runs.
  assert.equal(found.outlook.held, T0 + 80 * MIN);
  const { out } = await h.hq(await reader(), 'estimate', `#${id}`);
  assert.match(out, /projected merge .* \(by .* four times in five: the time a promise holds to\)/);
});

test("a queued job's own estimate is the one stored as it was queued", async () => {
  await seat();
  const id = queued('Paint the harbour map for the visitors');
  predictions.sweep();
  const longer = past('Paint the harbour map for the visitors guide', 400, 60);
  const own = await ask({ q: `#${id}` });
  assert.deepEqual(
    [own.estimate.agent_minutes, own.estimate.compared, own.estimate.guessed, own.outlook.merged],
    [40, 3, false, T0 + 70 * MIN],
  );
  assert.ok(!own.jobs.some((j: { id: number }) => j.id === longer));
  h.db.prepare('delete from runs where job = ?').run(longer);
  h.db.prepare('delete from prs where branch = ?').run(`job/${longer}`);
  h.db.prepare('delete from jobs where id = ?').run(longer);
  clear();
});

test('new work keeps the estimate it was queued with, and --accuracy sets it against what happened', async () => {
  await seat();
  const id = queued('Paint the harbour lights');
  predictions.sweep();
  const kept = h.db.prepare('select agent_ms, picks, eta from predictions where job = ?').get(id) as any;
  assert.deepEqual([kept.agent_ms, JSON.parse(kept.picks).length, kept.eta], [40 * MIN, 3, T0 + 70 * MIN]);
  const job = (await h.claim('claude', { seat: 'claude-a' }))!;
  assert.equal(job.id, id);
  mock.timers.setTime(T0 + 80 * MIN);
  await h.finish(job, { status: 'done', pr: 200, branch: `job/${id}`, sha: 'a'.repeat(40) });
  h.db.prepare("update prs set status = 'merged', merged_at = ? where number = 200").run(at(T0 + 200 * MIN));
  mock.timers.setTime(T0 + 210 * MIN);
  const r = await h.agent('estimate/accuracy', (await reader()).token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const worst = r.body.agent_time.worst.find((w: any) => w.id === id);
  assert.deepEqual([worst.predicted_minutes, worst.actual_minutes], [40, 80]);
  const late = r.body.eta.worst.find((w: any) => w.id === id);
  // it started on time, ran 40 minutes longer
  assert.deepEqual([late.late_minutes, late.moved.start_minutes, late.moved.run_minutes], [130, 0, 40]);
  assert.equal(r.body.matching[0].way, 'agent, kind and words (the mean)');
  const { out } = await h.hq(await reader(), 'estimate', '--accuracy');
  assert.match(out, /estimated 40 min, took 1 h 20 min/);
  assert.match(out, /2 h 10 min late\): started 0 min later, ran 40 min longer/);
});

test('deploy lag uses the first successful finish after each recent merge, excluding merges without a deploy', async () => {
  const { orderingSnapshot } = await import('./backlog.ts');
  const { inOneStep } = await import('./db.ts');
  const { recordedDeployHistory } = await import('./reviewfixture.ts');
  const now = T0 + 14 * 24 * HOUR;
  inOneStep(
    () => {
      assert.equal(orderingSnapshot(now).deployLagMs, 20 * MIN);
      for (const minutes of [10, 8, 2, 7 * 24 * 60]) h.pastJob({ merged: now - minutes * MIN });
      recordedDeployHistory(h.db, [
        { fetched: now - 12 * MIN, finished: now - 10 * MIN, ok: true },
        { fetched: now - 10 * MIN, finished: now - 9 * MIN, ok: false },
        { fetched: now - 10 * MIN, finished: now - 5 * MIN, ok: true },
        { fetched: now - 9 * MIN, finished: now - 7 * MIN, ok: true },
      ]);
      // The qualifying lags are three minutes and one minute. Equal finishes and failed deploys do not qualify.
      assert.ok(Math.abs(orderingSnapshot(now).deployLagMs - MIN) < 1);
      assert.equal(orderingSnapshot(now + 8 * 24 * HOUR).deployLagMs, 20 * MIN);
    },
    { keep: false },
  );
});
