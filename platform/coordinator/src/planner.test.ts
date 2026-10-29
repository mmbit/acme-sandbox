// node --test src/planner.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect, play, type QueuedJob, type Snapshot } from './eta.ts';
import { memoryReport } from './memory.fixture.ts';
import { DEADLINE_PAUSE_MS, PAUSE_MS } from './planner.ts';
import { extraClaude } from './seatcapacity.ts';
import { paceChange, pacingLifts } from '../../worker/src/pace.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/plan-test-`);
const { threadOutlooks, standing, undrawnWords } = await import('./forecast.ts');
const MINUTE = 60_000;
const work = (id: number, extra: Partial<QueuedJob> = {}): QueuedJob => ({
  id,
  agent: 'author',
  title: 'A job',
  kind: 'work',
  origin: 'work',
  status: 'queued',
  engine: 'codex',
  for_seat: null,
  downtime: 0,
  created: 0,
  finished: null,
  notBefore: 0,
  seat: null,
  pr: null,
  board: 0,
  spentMs: 0,
  after: 'released',
  waitsFor: [],
  cards: [],
  wakes: [],
  due: null,
  review: null,
  reasons: [],
  ...extra,
});
const snapshot = (jobs: QueuedJob[], extra: Partial<Snapshot> = {}): Snapshot => ({
  now: 0,
  planner: 3,
  jobs,
  seats: ['codex', 'claude'].map(engine => ({
    id: engine,
    engine,
    state: 'ready',
    until: null,
    fiveHour: 0,
    fiveHourResets: null,
    week: 0,
    weekResets: null, // (no pace)
    stop: 0.85,
  })),
  rates: {},
  slots: { codex: 1, claude: 1 },
  room: 2,
  seatRuns: { codex: 1, claude: 1 },
  deployLagMs: 0,
  ...extra,
});
const sizes = (entries: [number, number][]) =>
  new Map(entries.map(([id, minutes]) => [id, { agent_ms: minutes * MINUTE }]));

test('a retained placeholder loop stalls its work while independent work still plays in both forecasts', () => {
  const input = snapshot([
    work(1, { thread: 'project/build', needs: [-1000] }),
    work(-1000, { thread: 'project/bare', placeholder: true, needs: [1] }),
    work(2),
  ]);
  const before = structuredClone(input);
  for (const pace of ['usual', 'slow'] as const) {
    const seen = play(
      input,
      sizes([
        [1, 1],
        [-1000, 1],
        [2, 1],
      ]),
      { pace },
    );
    assert.equal(seen.get(1)!.start, null);
    assert.equal(seen.get(-1000)!.start, null);
    assert.ok(seen.get(2)!.done !== null);
    assert.match(JSON.stringify(seen.get(1)!.waits), /plan cycle/);
  }
  assert.deepEqual(input, before, 'a play leaves the retained input unchanged');
});

test('ready reviews start within the pause bound on a full two-run seat while work progresses', () => {
  const input = snapshot(
    [
      work(1, { status: 'running', seat: 'codex' }),
      work(2, { status: 'running', seat: 'codex' }),
      work(3),
      work(4, { kind: 'review' }),
      work(5, { kind: 'consolidate' }),
      work(6, { engine: 'claude', after: 4 }),
      work(7, { engine: 'claude', after: 5 }),
    ],
    { slots: { codex: 15, claude: 15 }, seatRuns: { codex: 2 }, room: 4 },
  );
  const seen = play(
    input,
    sizes([
      [1, 120],
      [2, 180],
      [3, 120],
      [4, 2],
      [5, 2],
      [6, 1],
      [7, 1],
    ]),
  );
  assert.equal(seen.get(6)!.start, PAUSE_MS + 2 * MINUTE, 'the first review finishes after the pause and its own run');
  assert.equal(seen.get(7)!.start, PAUSE_MS + 4 * MINUTE, 'the next review uses the same place');
  assert.equal(seen.get(1)!.done, 120 * MINUTE, 'the other work run is uninterrupted');
  assert.equal(seen.get(2)!.done, (180 + 4) * MINUTE + 2 * PAUSE_MS, 'paused work resumes and completes');
  assert.equal(seen.get(3)!.start, 120 * MINUTE, 'queued work starts while the resumed work is running');
});

test('a bound review claims its open seat before older work when another seat is full', () => {
  const seats = snapshot([]).seats;
  const input = snapshot(
    [
      work(1, { status: 'running', seat: 'a' }),
      work(2, { status: 'running', seat: 'a' }),
      work(3, { status: 'running', seat: 'b' }),
      work(4),
      work(5, { kind: 'review', for_seat: 'b' }),
      work(6, { engine: 'claude', after: 5 }),
    ],
    {
      seats: [{ ...seats[0], id: 'a' }, { ...seats[0], id: 'b' }, seats[1]],
      slots: { codex: 4, claude: 1 },
      seatRuns: { codex: 2 },
      room: 10,
    },
  );
  const sized = sizes([
    [1, 120],
    [2, 180],
    [3, 120],
    [4, 120],
    [5, 2],
    [6, 1],
  ]);
  const seen = play(input, sized);
  assert.equal(seen.get(6)!.start, 2 * MINUTE);
  assert.equal(seen.get(4)!.start, 2 * MINUTE);
  assert.equal(seen.get(4)!.done, 122 * MINUTE);
});

test('a later id inherits a dependent window through every predecessor and runs before loose work', () => {
  const input = snapshot([
    work(1),
    work(2, { due: 100 * MINUTE }),
    work(3),
    work(4, { after: 3 }),
    work(5, { after: 4, due: 40 * MINUTE }),
  ]);
  const sized = sizes([
    [1, 10],
    [2, 10],
    [3, 10],
    [4, 10],
    [5, 10],
  ]);
  const seen = play(input, sized);
  assert.equal(seen.get(3)!.start, 0);
  assert.equal(seen.get(5)!.merged, 30 * MINUTE);
  assert.ok(seen.get(1)!.start! > seen.get(2)!.start!);
});

test('a window that has passed goes after every window still open, and before work with none', () => {
  const input = snapshot(
    [
      work(1, { due: 60 * MINUTE }),
      work(2, { due: 600 * MINUTE }),
      work(3),
      work(4, { due: 30 * MINUTE }),
      work(5, { after: 4, due: 700 * MINUTE }),
    ],
    { now: 300 * MINUTE },
  );
  const seen = play(
    input,
    sizes([
      [1, 10],
      [2, 10],
      [3, 10],
      [4, 10],
      [5, 10],
    ]),
  );
  const start = (id: number) => seen.get(id)!.start!;
  assert.ok(start(2) < start(1), 'missed by four hours, it no longer goes before a window still to come');
  assert.ok(start(4) < start(1), 'its own window passed, but work with an open one waits for it');
  assert.ok(start(1) < start(3), 'ahead of work with no window');
});

test('a pause release with a passed window leaves more urgent running work uninterrupted', () => {
  const input = snapshot(
    [work(1, { status: 'running', seat: 'codex', due: 60 * MINUTE }), work(2, { due: -72 * 60 * MINUTE })],
    { pauseUntil: [2] },
  );
  const seen = play(
    input,
    sizes([
      [1, 180],
      [2, 30],
    ]),
  );
  assert.equal(seen.get(1)!.done, 180 * MINUTE);
  assert.equal(seen.get(2)!.start, 180 * MINUTE);
  assert.ok(!seen.get(2)!.waits.some(wait => wait.on === 'queue' && wait.pausing));
});

test('reviewers and rulings occupy slots, fix runs have their own engine, and merge edges await the last run', () => {
  const owner = work(1, {
    reviewPlan: {
      panel: 'two',
      count: 2,
      terminal: 'ruling',
      stages: [
        {
          key: 'review-a',
          kind: 'review',
          agent: 'a',
          engine: 'codex',
          usualMs: 4 * MINUTE,
          slowMs: 6 * MINUTE,
          after: [],
        },
        {
          key: 'review-b',
          kind: 'review',
          agent: 'b',
          engine: 'codex',
          usualMs: 4 * MINUTE,
          slowMs: 6 * MINUTE,
          after: [],
        },
        {
          key: 'fix',
          kind: 'work',
          agent: 'c',
          engine: 'claude',
          usualMs: 10 * MINUTE,
          slowMs: 20 * MINUTE,
          after: ['review-a', 'review-b'],
        },
        {
          key: 'ruling',
          kind: 'consolidate',
          agent: 'b',
          engine: 'codex',
          usualMs: 3 * MINUTE,
          slowMs: 5 * MINUTE,
          after: ['fix'],
        },
      ],
    },
  });
  const input = snapshot([owner, work(2, { after: 1 })]),
    sized = sizes([
      [1, 5],
      [2, 1],
    ]);
  const usual = play(input, sized),
    slow = play(input, sized, { pace: 'slow' });
  assert.equal(usual.get(1)!.done, 5 * MINUTE);
  assert.equal(usual.get(1)!.merged, 26 * MINUTE);
  assert.equal(usual.get(2)!.start, 26 * MINUTE);
  assert.equal(slow.get(1)!.merged, 42 * MINUTE);
  assert.deepEqual(usual.get(1)!.time, {
    work_ms: 5 * MINUTE,
    review_ms: 21 * MINUTE,
    waiting_ms: 0,
    deploy_ms: 0,
    total_ms: 26 * MINUTE,
  });
  const parallel = play({ ...input, slots: { codex: 2, claude: 1 }, seatRuns: { codex: 2, claude: 1 } }, sized);
  assert.equal(parallel.get(1)!.time!.review_ms, 17 * MINUTE);
  assert.equal(parallel.get(1)!.time!.total_ms, 22 * MINUTE);
});

test('used slack immediately pauses lower work and preserves its remaining run', () => {
  const input = snapshot([work(1, { status: 'running', seat: 'codex' }), work(2, { due: 16 * MINUTE })]);
  const seen = play(
    input,
    sizes([
      [1, 60],
      [2, 10],
    ]),
  );
  assert.equal(seen.get(2)!.start, DEADLINE_PAUSE_MS);
  assert.equal(seen.get(2)!.merged, 10 * MINUTE + DEADLINE_PAUSE_MS);
  assert.deepEqual(seen.get(2)!.time, {
    work_ms: 10 * MINUTE,
    review_ms: 0,
    waiting_ms: DEADLINE_PAUSE_MS,
    deploy_ms: 0,
    total_ms: 10 * MINUTE + DEADLINE_PAUSE_MS,
  });
  assert.ok(seen.get(2)!.waits.some(w => w.on === 'queue' && w.pausing));
  assert.equal(seen.get(1)!.done, 70 * MINUTE + 2 * DEADLINE_PAUSE_MS);
});

test('memory pressure can pause another engine, but a quota wait never pauses work for room', () => {
  const running = work(1, { engine: 'claude', status: 'running', seat: 'claude' }),
    urgent = work(2, { for_seat: 'codex', due: 16 * MINUTE });
  const input = snapshot([running, urgent], { room: 1 });
  assert.equal(
    play(
      input,
      sizes([
        [1, 60],
        [2, 10],
      ]),
    ).get(2)!.start,
    DEADLINE_PAUSE_MS,
  );
  input.seats.find(s => s.id === 'codex')!.fiveHour = 0.85;
  input.seats.find(s => s.id === 'codex')!.fiveHourResets = 30 * MINUTE;
  const seen = play(
    input,
    sizes([
      [1, 60],
      [2, 10],
    ]),
  );
  assert.equal(seen.get(1)!.done, 70 * MINUTE + 2 * DEADLINE_PAUSE_MS);
  assert.equal(seen.get(2)!.start, 30 * MINUTE + DEADLINE_PAUSE_MS);
});

test('deadline work preempts lower reviews and rulings while the board lane keeps its place', () => {
  for (const extra of [{ kind: 'review' }, { kind: 'consolidate' }, { board: 1 }]) {
    const seen = play(
      snapshot([work(1, { status: 'running', seat: 'codex', ...extra }), work(2, { due: 10 * MINUTE })]),
      sizes([
        [1, 30],
        [2, 5],
      ]),
    );
    assert.equal(seen.get(2)!.start, 'board' in extra ? 30 * MINUTE : DEADLINE_PAUSE_MS);
  }
});

for (const weekly of [false, true])
  test(`a reported ${weekly ? 'week' : 'five-hour'} reset renews the window after it fills again`, () => {
    const input = snapshot([work(1, { notBefore: 30 * MINUTE }), work(2, { after: 1 })]);
    const seat = input.seats.find(s => s.id === 'codex')!;
    if (weekly) {
      seat.week = seat.stop;
      seat.weekResets = 10 * MINUTE;
    } else {
      seat.fiveHour = seat.stop;
      seat.fiveHourResets = 10 * MINUTE;
    }
    input.rates = { codex: { week: { codex: weekly ? 6 : 0 }, five: { codex: weekly ? 0 : 6 } } };
    const seen = play(
      input,
      sizes([
        [1, 10],
        [2, 10],
      ]),
    );
    const returns = (weekly ? 10 + 7 * 24 * 60 : 30 + 5 * 60) * MINUTE;
    assert.equal(seen.get(1)!.start, 30 * MINUTE);
    assert.equal(seen.get(2)!.start, returns);
    assert.equal(seen.get(2)!.merged, returns + 10 * MINUTE);
    assert.ok(seen.get(2)!.waits.some(w => w.on === 'seats' && w.until === returns));
  });

test('Claude work reuses its five-hour seat before another seat lifts its weekly pacing', () => {
  const input = snapshot([work(1, { engine: 'claude', notBefore: 30 * MINUTE })], { pacing: true });
  const seat = input.seats.find(s => s.id === 'claude')!;
  seat.fiveHour = seat.stop;
  seat.fiveHourResets = 10 * MINUTE;
  seat.weekResets = 7 * 24 * 60 * MINUTE;
  input.seats.push({ ...seat, id: 'claude-paced', fiveHour: 0, week: 0.91, weekResets: 3 * 24 * 60 * MINUTE });
  input.rates = { claude: { week: 0, five: { claude: 6, 'claude-paced': 0 } } };
  const seen = play(input, sizes([[1, 20]])).get(1)!;
  assert.equal(seen.start, 30 * MINUTE);
  assert.ok(Math.abs(seen.merged! - 633 * MINUTE) < 1);
  assert.ok(seen.waits.some(w => w.on === 'seats' && w.until === 330 * MINUTE));
  assert.ok(seen.waits.some(w => w.on === 'seats' && w.until === 630 * MINUTE));
});

test('a window with no reported reset keeps its return unknown', () => {
  const input = snapshot([work(1)]);
  input.seats.find(s => s.id === 'codex')!.fiveHour = 0.85;
  assert.equal(play(input, sizes([[1, 10]])).get(1)!.merged, null);
});

test('thread slack counts deploy lag, and a card and a wake remain explicit prerequisites', () => {
  const row = work(1, {
    thread: 'project/thread',
    due: 60 * MINUTE,
    cards: [{ request: 7, at: 10 * MINUTE }],
    wakes: [{ at: 20 * MINUTE }],
  });
  const input = snapshot([row], {
    deployLagMs: 5 * MINUTE,
    windows: { 'project/thread': { deadline: 60 * MINUTE, aim: 40 * MINUTE } },
  });
  const sized = sizes([[1, 10]]),
    seen = play(input, sized);
  assert.equal(seen.get(1)!.start, 20 * MINUTE);
  assert.deepEqual(seen.get(1)!.cards, [{ request: 7, at: 10 * MINUTE }]);
  const thread = threadOutlooks(input, seen, seen, sized).get('project/thread')!;
  assert.equal(thread.finish, 35 * MINUTE);
  assert.equal(thread.slack, 25 * MINUTE);
});

test('a windowed thread with no task drawn misses its window, and a thread it needs too', () => {
  const window = { deadline: 60 * MINUTE, aim: 60 * MINUTE };
  const bare = work(-1000, { thread: 'project/bare', placeholder: true });
  const sized = sizes([
    [-1000, 10],
    [1, 10],
  ]);
  const alone = snapshot([bare], { windows: { 'project/bare': window } });
  const own = threadOutlooks(alone, play(alone, sized), play(alone, sized), sized).get('project/bare')!;
  assert.equal(play(alone, sized).get(-1000)!.merged, 10 * MINUTE, 'the placeholder still plays');
  assert.deepEqual([own.eta, own.finish, own.slack, own.held], [null, null, null, null]);
  assert.equal(standing(own), 'misses');
  assert.equal(undrawnWords(own), 'no task drawn: nobody is building it');

  const needing = snapshot([bare, work(1, { thread: 'project/ui', needs: [-1000] })], {
    windows: { 'project/ui': window },
  });
  const seen = play(needing, sized);
  assert.ok(seen.get(1)!.start! >= seen.get(-1000)!.merged!, "other threads' ETAs still count the placeholder");
  const threads = threadOutlooks(needing, seen, seen, sized);
  const [ui, needed] = [threads.get('project/ui')!, threads.get('project/bare')!];
  assert.deepEqual([ui.eta, ui.finish, standing(ui)], [null, null, 'misses']);
  assert.equal(undrawnWords(ui), 'it needs project/bare, with no task drawn: nobody is building it');
  assert.deepEqual([needed.eta, needed.finish, standing(needed)], [null, null, null]);
  assert.equal(undrawnWords(needed), 'no task drawn: nobody is building it');
});

test('a thread with no task drawn and no window at stake keeps its placeholder finish', () => {
  const input = snapshot([work(-1000, { thread: 'project/bare', placeholder: true })]);
  const sized = sizes([[-1000, 10]]),
    seen = play(input, sized);
  const thread = threadOutlooks(input, seen, seen, sized).get('project/bare')!;
  assert.deepEqual([thread.eta, thread.finish, thread.undrawn], [10 * MINUTE, 10 * MINUTE, []]);
  assert.equal(undrawnWords(thread), null);
});

test('ready work consumes the reported week now and waits only at the actual stop', () => {
  const input = snapshot([work(1)]);
  const seat = input.seats.find(s => s.id === 'codex')!;
  seat.week = 0.85;
  seat.stop = 0.95;
  seat.weekResets = 3 * 24 * 60 * MINUTE;
  input.rates = { codex: { week: { codex: 0.5 }, five: { codex: 0 } } };
  assert.equal(play(input, sizes([[1, 20]])).get(1)!.start, 0);
  seat.week = seat.stop;
  assert.equal(play(input, sizes([[1, 20]])).get(1)!.start, seat.weekResets);
});

test('board-word work takes the lane and waits the call pause delay before making room', () => {
  const input = snapshot([work(1, { status: 'running', seat: 'codex' }), work(2, { board: 1 }), work(3)]);
  const seen = play(
    input,
    sizes([
      [1, 30],
      [2, 5],
      [3, 5],
    ]),
  );
  assert.equal(seen.get(2)!.start, 30_000 + PAUSE_MS);
  assert.ok(seen.get(3)!.start! > seen.get(2)!.start!);
});

test('work waiting for a full seat makes room on that seat even with free engine slots', () => {
  const input = snapshot(
    [work(1, { status: 'running', seat: 'codex' }), work(2, { for_seat: 'codex', due: 16 * MINUTE })],
    { slots: { codex: 2, claude: 1 } },
  );
  const seen = play(
    input,
    sizes([
      [1, 60],
      [2, 10],
    ]),
  );
  assert.equal(seen.get(2)!.start, DEADLINE_PAUSE_MS);
});

test('downtime uses spare room, while downtime needed by a window runs in the shared order', () => {
  const sized = sizes([
    [1, 10],
    [2, 10],
    [3, 1],
  ]);
  const input = snapshot([work(1, { downtime: 1 }), work(2)]);
  let seen = play(input, sized);
  assert.equal(seen.get(2)!.start, 0);
  assert.equal(seen.get(1)!.start, 10 * MINUTE);
  input.slots.codex = 2;
  input.seatRuns = { codex: 2 };
  assert.equal(play(input, sized).get(1)!.start, 0, 'the other free slot is spare room');
  input.slots.codex = 1;
  input.seatRuns = { codex: 1 };
  input.jobs.push(work(3, { after: 1, due: 30 * MINUTE }));
  seen = play(input, sized);
  assert.equal(seen.get(1)!.start, 0);
  assert.equal(seen.get(3)!.merged, 11 * MINUTE);
});

test('remaining work at the snapshot is preserved across a future seat reset', () => {
  const input = snapshot([work(1, { engine: 'claude' })]);
  const seat = input.seats.find(s => s.id === 'claude')!;
  seat.fiveHour = 0.6;
  seat.fiveHourResets = 60 * MINUTE;
  input.rates = { claude: { week: 0, five: { claude: 0.5 } } };
  const seen = play(input, sizes([[1, 40]])).get(1)!;
  assert.equal(seen.done, 70 * MINUTE);
  assert.equal(seen.left_ms, 40 * MINUTE);
});

test("a paced seat takes the board's word and work due to start before its weekly reset; the rest waits till its pacing lifts", () => {
  const HOUR = 60 * MINUTE,
    reset = 48 * HOUR;
  const input = snapshot([work(1), work(2, { due: 2 * HOUR }), work(3, { board: 1 })]);
  const seat = input.seats.find(s => s.id === 'codex')!;
  Object.assign(seat, { fiveHour: 0.2, week: 0.8, weekResets: reset, stop: 0.9 });
  input.pacing = true;
  const sized = sizes([
    [1, 10],
    [2, 10],
    [3, 10],
  ]);
  const seen = play(input, sized),
    lifts = paceChange({ week: 0.8, weekResets: reset }, 0.9, 0)!;
  assert.equal(seen.get(3)!.start, 0);
  assert.equal(seen.get(2)!.start, 10 * MINUTE);
  assert.ok(lifts > 10 * MINUTE && lifts < reset, 'its pacing lifts before the reset');
  // (to the second, as the worker's pacing lifts: pace.ts paceChange)
  assert.ok(Math.abs(seen.get(1)!.start! - lifts) <= 1000, 'the undated work starts as the worker would let it');
  assert.ok(seen.get(1)!.waits.some(w => w.on === 'seats' && Math.abs(w.until - lifts) <= 1000));
  input.pacing = false;
  assert.equal(play(input, sized).get(1)!.start, 20 * MINUTE, 'pacing off, it starts after the others');
  Object.assign(input, { pacing: true, seats: [{ ...seat, credits: true }] });
  // (a seat on credits is paced all the same: the board, 22 Oct.)
  assert.ok(Math.abs(play(input, sized).get(1)!.start! - lifts) <= 1000, 'a seat on credits paces too');
});

test('an idle paced seat lets undated work go once its week evens out, a day before its reset, not at it', () => {
  const HOUR = 60 * MINUTE,
    input = snapshot([work(1)]);
  Object.assign(
    input.seats.find(s => s.id === 'codex')!,
    {
      fiveHour: 0.1,
      week: 0.5,
      weekResets: 96 * HOUR,
      stop: 0.9,
    },
  );
  input.pacing = true;
  const start = play(input, sizes([[1, 10]])).get(1)!.start!;
  assert.ok(start > 21 * HOUR && start < 22 * HOUR, `it starts when the worker's pacing lifts (${start / HOUR} h)`);
});

test('the week the play spends paces a seat as it goes: work after the spending waits for the pacing to lift', () => {
  const HOUR = 60 * MINUTE,
    input = snapshot([work(1), work(2)]);
  Object.assign(
    input.seats.find(s => s.id === 'codex')!,
    { week: 0.35, weekResets: 96 * HOUR, stop: 0.9 },
  );
  input.pacing = true;
  input.rates = { codex: { week: { codex: 0.05 }, five: { codex: 0 } } };
  const seen = play(
    input,
    sizes([
      [1, 120],
      [2, 10],
    ]),
  );
  assert.equal(seen.get(1)!.start, 0, 'on pace at first');
  assert.ok(seen.get(2)!.start! > 2 * HOUR, 'the first job used enough of the week to pace it');
  assert.ok(seen.get(2)!.waits.some(w => w.on === 'seats'));
});

test('an idle queue starts when another seat can keep the reserve again', () => {
  const HOUR = 60 * MINUTE,
    input = snapshot([work(1, { for_seat: 'codex' })], { pacing: true });
  const a = input.seats.find(s => s.id === 'codex')!;
  Object.assign(a, { week: 0.76, weekResets: 48 * HOUR, stop: 0.9 });
  input.seats.push({ ...a, id: 'codex-b', week: 0.95, weekResets: 24 * HOUR });
  const start = play(input, sizes([[1, 10]])).get(1)!.start!;
  assert.ok(start > 12 * HOUR && start < 12 * HOUR + 1000, `the reserve frees it after 12 hours (${start / HOUR} h)`);
});

test("a seat the play fills to its stop level hands the reserve back: the other seat's pacing aims lower from then on", () => {
  const HOUR = 60 * MINUTE,
    resets = 96 * HOUR;
  const input = snapshot([
    work(1, { status: 'running', seat: 'codex-b', kind: 'review' }),
    work(2, { for_seat: 'codex', notBefore: HOUR }),
  ]);
  const a = input.seats.find(s => s.id === 'codex')!;
  Object.assign(a, { week: 0.4, weekResets: resets, stop: 0.9 });
  input.seats.push({ ...a, id: 'codex-b', week: 0.89 });
  Object.assign(input, {
    pacing: true,
    slots: { codex: 2, claude: 1 },
    seatRuns: { codex: 1, claude: 1 },
    rates: { codex: { week: { codex: 0.02, 'codex-b': 0.02 }, five: {} } },
  });
  const start = play(
    input,
    sizes([
      [1, 30],
      [2, 10],
    ]),
  ).get(2)!.start!;
  // (both aim at their limit at first, each with the other under its stop level; once the running job takes codex-b to
  // its stop, codex keeps the reserve and paces toward its own)
  const lifts = pacingLifts({ week: 0.4, weekResets: resets }, 0.9, HOUR);
  assert.ok(lifts > 2 * HOUR, 'aiming at its stop level, codex is paced when the work is ready');
  assert.ok(Math.abs(start - lifts) <= 1000, `the work waits till that pacing lifts (${start / HOUR} h)`);
});

test('the time split counts prerequisites as waiting and deployment separately from its own work', () => {
  const input = snapshot([work(1), work(2, { after: 1 })], { deployLagMs: 2 * MINUTE });
  const seen = play(
    input,
    sizes([
      [1, 10],
      [2, 5],
    ]),
  ).get(2)!;
  assert.deepEqual(seen.time, {
    work_ms: 5 * MINUTE,
    review_ms: 0,
    waiting_ms: 10 * MINUTE,
    deploy_ms: 2 * MINUTE,
    total_ms: 17 * MINUTE,
  });
  const held = play(snapshot([work(1, { after: 'never' })]), sizes([[1, 10]])).get(1)!;
  assert.equal(held.time, null, 'unfinished work has no invented total');
});

test('putting a thirty-minute task first cannot strand a slipping thread behind four hours of lower review', () => {
  const jobs = [
    work(1, { kind: 'review', status: 'running', seat: 'codex' }),
    work(2, { kind: 'consolidate', status: 'running', seat: 'codex' }),
    work(3, { due: 45 * MINUTE }),
  ];
  const room = { slots: { codex: 2 }, seatRuns: { codex: 2 }, room: 2 };
  const durations = sizes([
    [1, 240],
    [2, 240],
    [3, 10],
    [4, 30],
  ]);
  for (const pace of ['usual', 'slow'] as const) {
    const before = play(snapshot(jobs, room), durations, { pace }).get(3)!;
    const after = play(snapshot([...jobs, work(4, { due: 30 * MINUTE })], room), durations, { pace }).get(3)!;
    assert.ok(after.merged! <= 45 * MINUTE, JSON.stringify({ before, after }));
    assert.ok(after.merged! - before.merged! <= 30 * MINUTE + DEADLINE_PAUSE_MS);
  }
});

test('a running job releases its measured memory so the queue can use the worker slots', () => {
  const input = snapshot(
    [
      work(1, { engine: 'claude', status: 'running', seat: 'claude', memoryMb: 2400 }),
      work(2, { engine: 'claude', memoryMb: 700 }),
      work(3, { engine: 'claude', memoryMb: 700 }),
    ],
    {
      room: 1,
      slots: { claude: 4 },
      seatRuns: { claude: 4 },
      memory: memoryReport({
        availableMb: 1900,
        totalSlots: 4,
        runningMb: { 1: 2400 },
      }),
    },
  );
  const played = play(
    input,
    sizes([
      [1, 10],
      [2, 10],
      [3, 10],
    ]),
  );
  assert.equal(played.get(2)!.start, 10 * MINUTE);
  assert.equal(played.get(3)!.start, 10 * MINUTE);
});

test('startup memory reservations expire at their recorded time while holds and shared slots remain', () => {
  const input = snapshot([work(1), work(2)], {
    room: 0,
    slots: { codex: 2 },
    seatRuns: { codex: 2 },
    memory: memoryReport({
      availableMb: 2600,
      totalSlots: 2,
      heldSlots: 1,
      heldMb: 400,
      starting: [{ until: MINUTE, mb: 700 }],
    }),
  });
  const played = play(
    input,
    sizes([
      [1, 10],
      [2, 10],
    ]),
  );
  assert.equal(played.get(1)!.start, MINUTE);
  assert.equal(played.get(2)!.start, 11 * MINUTE);
});

test('unmeasured future demand spends the real worker startup allowance', () => {
  const input = snapshot([work(1), work(2)], {
    room: 8,
    slots: { codex: 8 },
    seatRuns: { codex: 8 },
    memory: memoryReport({
      availableMb: 2200,
      totalSlots: 8,
    }),
  });
  const played = play(
    input,
    sizes([
      [1, 10],
      [2, 10],
    ]),
  );
  assert.equal(played.get(1)!.start, 0);
  assert.equal(played.get(2)!.start, 10 * MINUTE);
});

test('a job measured past the room the snapshot leaves starts on the allowance, as the worker admits it', () => {
  // (700 MB above the reserve, as on 26 October with too little free for any of Margin's 1.6-2.1 GB jobs: the play
  // started none of them in 8 days, and paused the queue behind them)
  const input = snapshot([work(1, { memoryMb: 1900 }), work(2, { memoryMb: 1900 }), work(3, { memoryMb: 300 })], {
    room: 8,
    slots: { codex: 8 },
    seatRuns: { codex: 8 },
    memory: memoryReport({
      availableMb: 2200,
      totalSlots: 8,
    }),
  });
  const played = play(
    input,
    sizes([
      [1, 10],
      [2, 10],
      [3, 10],
    ]),
  );
  assert.equal(played.get(1)!.start, 0);
  // (the first holds its measured 1.9 GB while it runs)
  assert.equal(played.get(2)!.start, 10 * MINUTE);
  assert.equal(played.get(3)!.start, 20 * MINUTE);
});

test('the seat account names exhausted work, the binding window, reset gap and resuming seat', () => {
  const HOUR = 60 * MINUTE;
  const input = snapshot([work(1, { engine: 'claude', for_seat: 'claude' })]);
  Object.assign(input.seats[1], { fiveHour: 0.8, stop: 0.9, fiveHourResets: 3 * HOUR, weekResets: 7 * 24 * HOUR });
  input.rates = { claude: { five: { claude: 0.1 }, week: { claude: 0 } } };
  const durations = sizes([[1, 180]]);
  const account = inspect(input, durations);
  assert.deepEqual(account.outlooks, play(input, durations), 'inspection observes the shared play');
  const events = account.seats.find(s => s.seat === 'claude')!.events;
  const stop = events.find(e => e.type === 'exhaustion')!;
  assert.equal(stop.quota, 'fiveHour');
  assert.ok(Math.abs(stop.at - HOUR) < 2);
  assert.ok(Math.abs(stop.running![0].remaining_ms - 2 * HOUR) < 2);
  assert.equal(stop.running![0].bound_seat, 'claude');
  assert.ok(Math.abs(stop.idle_ms! - 2 * HOUR) < 2);
  assert.equal(events.find(e => e.type === 'resume')!.at, 3 * HOUR);
  assert.ok(Math.abs(account.outlooks.get(1)!.done! - 5 * HOUR) < 2);
});

test('exhausted unbound work can resume on another eligible seat while its original window waits', () => {
  const HOUR = 60 * MINUTE;
  const input = snapshot([work(1, { engine: 'claude' })]);
  const original = input.seats[1];
  Object.assign(original, { fiveHour: 0.8, stop: 0.9, fiveHourResets: 4 * HOUR, weekResets: 7 * 24 * HOUR });
  input.seats.push({ ...original, id: 'returning', fiveHour: 0, state: 'sleeping', until: 2 * HOUR });
  input.rates = { claude: { five: { claude: 0.1, returning: 0.01 }, week: { claude: 0, returning: 0 } } };
  const account = inspect(input, sizes([[1, 180]]));
  const resume = account.seats.find(s => s.seat === 'returning')!.events.find(e => e.type === 'resume')!;
  assert.equal(resume.from, 'claude');
  assert.equal(resume.at, 2 * HOUR);
  assert.ok(Math.abs(resume.idle_ms! - HOUR) < 2);
  assert.ok(Math.abs(account.outlooks.get(1)!.done! - 4 * HOUR) < 2);
});

test('an added subscription advances seat-bound finishes and exposes shared-room losses without adding worker slots', () => {
  const input = snapshot(
    [
      work(1, { engine: 'claude', thread: 'first' }),
      work(2, { engine: 'claude', thread: 'second' }),
      work(3, { notBefore: 5 * MINUTE, thread: 'codex' }),
      work(4, { after: 3, thread: 'board', cards: [{ request: 1, at: 200 * MINUTE }] }),
    ],
    {
      seatPlans: { claude: 20 },
      slots: { claude: 2, codex: 1 },
      room: 2,
      rates: { claude: { five: { claude: 0.001 }, week: { claude: 0.001 } } },
    },
  );
  const durations = sizes([
    [1, 100],
    [2, 100],
    [3, 10],
    [4, 10],
  ]);
  const before = play(input, durations);
  for (const plan of [5, 20] as const) {
    const added = extraClaude(input, plan);
    assert.ok(added.available);
    assert.deepEqual(added.snapshot.slots, input.slots);
    assert.equal(added.snapshot.room, input.room);
    const after = play(added.snapshot, durations);
    assert.ok(after.get(2)!.merged! < before.get(2)!.merged!);
    assert.ok(after.get(3)!.merged! > before.get(3)!.merged!);
    assert.equal(after.get(4)!.cards.length, 1, 'the board-held finish remains conditional');
    const constrained = { ...input, room: 1 };
    const more = extraClaude(constrained, plan);
    assert.ok(more.available);
    const fixedBefore = play(constrained, durations),
      fixedAfter = play(more.snapshot, durations);
    for (const [id, outcome] of fixedBefore) {
      assert.equal(fixedAfter.get(id)!.merged, outcome.merged, 'a real one-run worker bottleneck has no gain');
    }
  }
});

test('projected review exhaustion names its stage and retains review queue constraints', () => {
  const HOUR = 60 * MINUTE;
  const input = snapshot([
    work(1, {
      engine: 'claude',
      reviewPlan: {
        panel: 'measured',
        count: 1,
        terminal: 'ruling',
        stages: [
          {
            key: 'first-review',
            kind: 'review',
            agent: 'reader',
            engine: 'claude',
            usualMs: 2 * HOUR,
            slowMs: 2 * HOUR,
            after: [],
          },
          {
            key: 'ruling',
            kind: 'consolidate',
            agent: 'ruler',
            engine: 'claude',
            usualMs: MINUTE,
            slowMs: MINUTE,
            after: ['first-review'],
          },
        ],
      },
    }),
  ]);
  Object.assign(input.seats[1], { fiveHour: 0.8, stop: 0.9, fiveHourResets: 3 * HOUR, weekResets: 7 * 24 * HOUR });
  input.rates = { claude: { five: { claude: 0.1 }, week: { claude: 0 } } };
  const account = inspect(input, sizes([[1, 1]]));
  const stop = account.seats.find(seat => seat.seat === 'claude')!.events.find(event => event.type === 'exhaustion')!;
  assert.equal(stop.running![0].stage, 'first-review');
  assert.equal(stop.running![0].kind, 'review');
  assert.ok(stop.running![0].remaining_ms > HOUR);
  const review = account.review_queue.find(run => run.stage === 'first-review')!;
  assert.ok(review.done! > 3 * HOUR);
  assert.ok(account.review_queue.some(run => run.stage === 'ruling' && run.start! >= review.done!));
});

test('holds already active at the cutoff account for remaining idle time even without running work', () => {
  const HOUR = 60 * MINUTE;
  for (const state of ['sleeping', 'draining', 'ready']) {
    const input = snapshot([work(1, { engine: 'claude' })], { now: HOUR });
    Object.assign(input.seats[1], {
      state,
      until: state === 'ready' ? null : 3 * HOUR,
      fiveHour: state === 'ready' ? 1 : 0,
      stop: 1,
      fiveHourResets: 3 * HOUR,
    });
    const seen = inspect(input, sizes([[1, 10]]));
    const events = seen.seats.find(seat => seat.seat === 'claude')!.events;
    const hold = events.find(event => event.type === 'exhaustion')!;
    assert.equal(hold.at, HOUR);
    assert.equal(hold.started_at, null);
    assert.equal(hold.until, 3 * HOUR);
    assert.deepEqual(hold.running, []);
    assert.equal(hold.idle_ms, 2 * HOUR);
    assert.equal(events.find(event => event.type === 'release')!.at, 3 * HOUR);
    assert.equal(seen.outlooks.get(1)!.start, 3 * HOUR);
  }
});

test('overlapping quota and provider holds return only after the last known release', () => {
  const HOUR = 60 * MINUTE;
  for (const reported of [false, true]) {
    const input = snapshot([work(1, { engine: 'claude' })]);
    Object.assign(input.seats[1], {
      fiveHour: 0.9,
      week: 0.9,
      stop: 1,
      fiveHourResets: 4 * HOUR,
      weekResets: 3 * HOUR,
    });
    input.rates = { claude: { five: { claude: 0.1 }, week: { claude: 0.1 } } };
    if (reported) Object.assign(input.seats[1], { state: 'sleeping', until: 5 * HOUR, fiveHour: 1, week: 1 });
    const seen = inspect(input, sizes([[1, 120]]));
    const events = seen.seats.find(seat => seat.seat === 'claude')!.events;
    const hold = events.find(event => event.type === 'exhaustion')!;
    const until = (reported ? 5 : 4) * HOUR;
    assert.equal(hold.quota, reported ? 'reported' : 'fiveHour');
    assert.equal(hold.until, until);
    assert.ok(Math.abs(hold.idle_ms! - (until - hold.at)) < 2);
    assert.equal(events.find(event => event.type === 'release')!.at, until);
    if (!reported) assert.ok(Math.abs(events.find(event => event.type === 'resume')!.idle_ms! - hold.idle_ms!) < 2);
  }
});

test('an empty sleeping Codex seat records its hold as idle time', () => {
  const HOUR = 60 * MINUTE;
  const empty = snapshot([work(1)]);
  Object.assign(empty.seats[0], { state: 'sleeping', until: 3 * HOUR, fiveHour: 1, stop: 0.9 });
  empty.seats[0].fiveHourResets = 3 * HOUR;
  const idle = inspect(empty, sizes([[1, 60]])).seats.find(seat => seat.seat === 'codex')!.events[0];
  assert.equal(idle.running_continues, false);
  assert.equal(idle.idle_ms, 3 * HOUR);
});

test('a Codex hold moves its return to a window that binds while work continues', () => {
  const HOUR = 60 * MINUTE;
  const busy = snapshot([work(1), work(2)]);
  Object.assign(busy.seats[0], { fiveHour: 0.9, week: 0.8, stop: 1, fiveHourResets: 4 * HOUR, weekResets: 6 * HOUR });
  busy.rates = { codex: { five: { codex: 0.1 }, week: { codex: 0.1 } } };
  const seen = inspect(
    busy,
    sizes([
      [1, 300],
      [2, 60],
    ]),
  );
  const events = seen.seats.find(seat => seat.seat === 'codex')!.events;
  const hold = events.find(event => event.type === 'exhaustion')!;
  assert.ok(Math.abs(hold.at - HOUR) < 2);
  assert.equal(hold.started_at, hold.at);
  assert.deepEqual(
    hold.running?.map(run => run.job),
    [1],
  );
  assert.ok(Math.abs(hold.running![0].remaining_ms - 4 * HOUR) < 2);
  assert.equal(hold.quota, 'week');
  assert.equal(hold.until, 6 * HOUR);
  assert.equal(hold.running_continues, true);
  assert.ok(Math.abs(hold.idle_ms! - HOUR) < 2, 'work finishes an hour before the extended return');
  assert.equal(events.find(event => event.type === 'release')!.at, 6 * HOUR);
  assert.equal(seen.outlooks.get(2)!.start, 6 * HOUR);
});

test('an overlapping hold with no known return leaves exhaustion and idle open', () => {
  const HOUR = 60 * MINUTE;
  const input = snapshot([work(1, { engine: 'claude' })]);
  Object.assign(input.seats[1], { state: 'sleeping', until: null, fiveHour: 1, stop: 1, fiveHourResets: HOUR });
  const seen = inspect(input, sizes([[1, 10]]));
  const events = seen.seats.find(seat => seat.seat === 'claude')!.events;
  const hold = events.find(event => event.type === 'exhaustion')!;
  assert.equal(hold.quota, 'reported');
  assert.equal(hold.until, null);
  assert.equal(hold.idle_ms, undefined);
  assert.ok(!events.some(event => event.type === 'release'));
  assert.equal(seen.outlooks.get(1)!.start, null);
});

test('seats without subscription windows run while an existing window with no reading holds work', () => {
  const input = snapshot([work(1)]);
  Object.assign(input.seats[0], { fiveHour: null, week: null });
  assert.equal(play(input, sizes([[1, 10]])).get(1)!.start, 0);
  input.seats[0].fiveHourResets = 30 * MINUTE;
  assert.equal(play(input, sizes([[1, 10]])).get(1)!.start, 30 * MINUTE);
});

test('known finished occupants return memory and slots while unknown occupants remain reserved', () => {
  const input = snapshot([work(1, { status: 'done', finished: 0 }), work(2)], {
    memory: memoryReport({
      availableMb: 1500,
      totalSlots: 1,
      runningMb: { 1: 700 },
    }),
  });
  const durations = sizes([
    [1, 1],
    [2, 10],
  ]);
  assert.equal(play(input, durations).get(2)!.start, 0);
  input.memory!.runningMb = { 999: 700 };
  assert.equal(play(input, durations).get(2)!.start, null);
});

for (const neededMb of [900, 1200])
  // (either size starts on the worker's starting allowance, defaultRunMb, not its measured peak: playmemory.ts canStart)
  test(`a ${neededMb} MB waiter makes room with a whole pause group`, () => {
    const input = snapshot(
      [
        work(1, { status: 'running', seat: 'codex', memoryMb: 400 }),
        work(2, { status: 'running', seat: 'codex', memoryMb: 400 }),
        work(3, { status: 'running', seat: 'claude', engine: 'claude', board: 1, memoryMb: 1400 }),
        work(4, { memoryMb: neededMb, due: 0 }),
      ],
      {
        slots: { codex: 4, claude: 1 },
        seatRuns: { codex: 4, claude: 1 },
        memory: memoryReport({
          availableMb: 1600,
          totalSlots: 3,
          runningMb: { 1: 400, 2: 400, 3: 1400 },
        }),
      },
    );
    for (const pace of ['usual', 'slow'] as const) {
      const seen = play(
        input,
        sizes([
          [1, 60],
          [2, 60],
          [3, 30],
          [4, 10],
        ]),
        { pace },
      );
      assert.equal(seen.get(4)!.start, DEADLINE_PAUSE_MS);
      for (const id of [1, 2]) assert.equal(seen.get(id)!.done, 70 * MINUTE + 2 * DEADLINE_PAUSE_MS);
      assert.equal(seen.get(3)!.done, 30 * MINUTE, 'the board lane keeps its room');
    }
  });

test('a held Codex seat becomes idle only after its last concurrent run finishes', () => {
  const HOUR = 60 * MINUTE;
  for (const minutes of [
    [60, 120],
    [180, 240],
  ]) {
    const input = snapshot([
      work(1, { status: 'running', seat: 'codex' }),
      work(2, { status: 'running', seat: 'codex' }),
      work(3),
    ]);
    Object.assign(input.seats[0], { state: 'draining', until: 3 * HOUR });
    input.slots.codex = 2;
    input.seatRuns!.codex = 2;
    const seen = inspect(
      input,
      sizes([
        [1, minutes[0]],
        [2, minutes[1]],
        [3, 10],
      ]),
    );
    const hold = seen.seats.find(seat => seat.seat === 'codex')!.events[0];
    assert.equal(hold.running_continues, true);
    assert.equal(hold.running!.length, 2);
    assert.equal(hold.idle_ms, Math.max(0, 3 * HOUR - minutes[1] * MINUTE));
    assert.equal(seen.outlooks.get(3)!.start, 3 * HOUR);
  }
});

for (const arrivesAt of [0, DEADLINE_PAUSE_MS / 2])
  test(`a later waiter at ${arrivesAt} cannot spend another waiter's pause release`, () => {
    const input = snapshot(
      [
        work(1, { status: 'running', seat: 'codex', memoryMb: 400 }),
        work(2, { status: 'running', seat: 'codex', memoryMb: 400 }),
        work(3, { status: 'running', seat: 'codex', memoryMb: 400 }),
        work(4, { status: 'running', seat: 'claude', engine: 'claude', board: 1, memoryMb: 1400 }),
        work(5, { memoryMb: 900, due: 0 }),
        work(6, { memoryMb: 1300, due: MINUTE, notBefore: arrivesAt }),
      ],
      {
        slots: { codex: 5, claude: 1 },
        seatRuns: { codex: 5, claude: 1 },
        memory: memoryReport({
          availableMb: 1600,
          totalSlots: 6,
          runningMb: { 1: 400, 2: 400, 3: 400, 4: 1400 },
        }),
      },
    );
    for (const pace of ['usual', 'slow'] as const) {
      const seen = play(
        input,
        sizes([
          [1, 5],
          [2, 60],
          [3, 60],
          [4, 30],
          [5, 10],
          [6, 10],
        ]),
        { pace },
      );
      assert.equal(seen.get(5)!.start, DEADLINE_PAUSE_MS, 'the first waiter gets its pause group');
      assert.equal(seen.get(1)!.done, 5 * MINUTE, 'the remaining run finishes without an unhelpful pause');
      assert.ok(seen.get(6)!.start! >= seen.get(5)!.done!);
    }
  });

for (const constrained of ['engine', 'seat'] as const)
  test(`a later waiter cannot spend the ${constrained} place promised to another pause group`, () => {
    const input = snapshot(
      [
        work(1, { status: 'running', seat: 'claude', engine: 'claude', memoryMb: 2000 }),
        work(2, { status: 'running', seat: 'claude', engine: 'claude', memoryMb: 400 }),
        work(3, { status: 'running', seat: 'claude', engine: 'claude', memoryMb: 400 }),
        work(4, { memoryMb: 900, due: 0 }),
        work(5, { memoryMb: 1000, due: MINUTE }),
      ],
      {
        slots: { codex: constrained === 'engine' ? 1 : 5, claude: 3 },
        seatRuns: { codex: constrained === 'seat' ? 1 : 5, claude: 3 },
        memory: memoryReport({
          availableMb: 1600,
          totalSlots: 5,
          runningMb: { 1: 2000, 2: 400, 3: 400 },
        }),
      },
    );
    for (const pace of ['usual', 'slow'] as const) {
      const seen = play(
        input,
        sizes([
          [1, 5],
          [2, 60],
          [3, 60],
          [4, 10],
          [5, 10],
        ]),
        { pace },
      );
      assert.equal(seen.get(4)!.start, DEADLINE_PAUSE_MS);
      assert.equal(seen.get(1)!.done, 5 * MINUTE, 'more memory cannot free the promised place');
      assert.equal(seen.get(5)!.start, seen.get(4)!.done);
    }
  });

for (const [availableMb, start] of [
  [2000, DEADLINE_PAUSE_MS],
  [2300, 0],
] as const)
  test(`deadline work on an idle seat starts ${start ? 'after the pause' : 'at once'} with ${availableMb} MB free, and lower work cannot take its room`, () => {
    const input = snapshot(
      [
        work(1, { engine: 'claude', status: 'running', seat: 'claude-busy', memoryMb: 300 }),
        work(2, { engine: 'claude', memoryMb: 700, due: -MINUTE }),
        work(3, { engine: 'claude', memoryMb: 400 }),
      ],
      {
        seats: ['claude-idle', 'claude-busy'].map(id => ({
          id,
          engine: 'claude',
          state: 'ready',
          until: null,
          fiveHour: id === 'claude-idle' ? 0.03 : 0.6,
          fiveHourResets: null,
          week: 0.1,
          weekResets: null,
          stop: 0.99,
        })),
        slots: { claude: 15 },
        seatRuns: {},
        room: 15,
        memory: memoryReport({ availableMb, runningMb: { 1: 300 } }),
      },
    );
    for (const pace of ['usual', 'slow'] as const) {
      const seen = play(
        input,
        sizes([
          [1, 60],
          [2, 10],
          [3, 60],
        ]),
        { pace },
      );
      assert.equal(seen.get(2)!.start, start);
      assert.notEqual(seen.get(1)!.done, null, 'the lower run eventually finishes');
      assert.notEqual(seen.get(3)!.done, null, 'new lower work eventually finishes');
    }
  });

for (const [memoryMb, codexSlots, start] of [
  [400, 2, MINUTE / 2],
  [700, 1, MINUTE / 2 + DEADLINE_PAUSE_MS],
] as const)
  test(`a waiter whose seat drains during its pause releases room for ${memoryMb} MB of independent work`, () => {
    const input = snapshot(
      [
        work(1, { status: 'running', seat: 'codex', memoryMb: 300 }),
        work(2, { engine: 'claude', status: 'running', seat: 'claude', followThrough: true, memoryMb: 100 }),
        work(3, { engine: 'claude', memoryMb: 700, due: 0 }),
        work(4, { engine: 'claude', status: 'running', seat: 'claude', memoryMb: 300 }),
        work(5, { memoryMb, due: MINUTE }),
      ],
      {
        slots: { claude: 3, codex: codexSlots },
        seatRuns: { claude: 3, codex: codexSlots },
        rates: { claude: { five: { claude: 0.6 }, week: 0 } },
        memory: memoryReport({ runningMb: { 1: 300, 2: 100, 4: 300 } }),
      },
    );
    Object.assign(input.seats[1], { fiveHour: 0.845, fiveHourResets: 240 * MINUTE });
    for (const pace of ['usual', 'slow'] as const) {
      const seen = play(
        input,
        sizes([
          [1, 60],
          [2, 10],
          [3, 10],
          [4, 60],
          [5, 10],
        ]),
        { pace },
      );
      assert.ok(seen.get(3)!.start! >= 240 * MINUTE, 'the waiter must wait for its seat to reset');
      assert.equal(Math.round(seen.get(5)!.start!), start, 'independent work uses its own ready seat');
    }
  });

test('an older spare claim on another engine cannot spend an ordinary waiter’s reserved room', () => {
  const input = snapshot(
    [
      work(1, { engine: 'claude', status: 'running', seat: 'claude', memoryMb: 300, downtime: 1 }),
      work(2, { memoryMb: 400, downtime: 1 }),
      work(3, { engine: 'claude', memoryMb: 700 }),
    ],
    {
      slots: { claude: 2, codex: 1 },
      seatRuns: { claude: 2, codex: 1 },
      memory: memoryReport({ runningMb: { 1: 300 } }),
    },
  );
  for (const pace of ['usual', 'slow'] as const) {
    const seen = play(
      input,
      sizes([
        [1, 60],
        [2, 60],
        [3, 10],
      ]),
      { pace },
    );
    assert.equal(seen.get(3)!.start, PAUSE_MS);
    assert.ok(seen.get(2)!.start! >= seen.get(3)!.done!);
  }
});
