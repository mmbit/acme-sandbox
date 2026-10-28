// node --test src/rounds.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { play } from './eta.ts';
import type { QueuedJob, Snapshot } from './eta.ts';

const work = (id: number, fields: Partial<QueuedJob> = {}): QueuedJob => ({
  id,
  agent: 'author',
  title: 'A change',
  kind: 'work',
  origin: 'work',
  status: 'queued',
  engine: 'claude',
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
  due: 3600000,
  review: null,
  reasons: [],
  ...fields,
});
const snapshot = (jobs: QueuedJob[]): Snapshot => ({
  now: 0,
  planner: 3,
  jobs,
  seats: ['claude', 'codex'].map(engine => ({
    id: engine,
    engine,
    state: 'ready',
    until: null,
    fiveHour: 0,
    fiveHourResets: null,
    week: 0,
    weekResets: null, // (no pace)
    stop: 0.95,
  })),
  rates: {},
  slots: { claude: 1, codex: 1 },
  deployLagMs: 0,
});

test('a visual merge waits for both the pictures review and the board, while those reviews can run', () => {
  const owner = work(1, { status: 'done', finished: 0 });
  const pictures = work(2, {
    reviewPlan: {
      panel: 'one',
      count: 1,
      terminal: 'ruling',
      stages: [
        { key: 'ruling', kind: 'consolidate', agent: 'ruler', engine: 'codex', usualMs: 20, slowMs: 20, after: [] },
      ],
    },
  });
  const sizes = new Map([
    [1, { agent_ms: 0 }],
    [2, { agent_ms: 10 }],
  ]);
  for (const at of [5, 100, null]) {
    const card = at === null ? null : { request: 7, at };
    const played = play(snapshot([{ ...owner, mergeHold: { job: pictures.id, card } }, pictures]), sizes);
    assert.equal(played.get(2)!.merged, 30, 'the pictures work and review proceed');
    assert.equal(played.get(1)!.merged, at === null ? null : Math.max(30, at));
    assert.ok(played.get(1)!.waits.some(w => w.on === 'board'));
  }
});

test('existing review runs count once and remaining fixes and rulings use their measured times', () => {
  const owner = work(1, {
    board: 1,
    reviewPlan: {
      panel: 'one',
      count: 2,
      terminal: '2:ruling',
      stages: [
        {
          key: '1:review',
          job: 2,
          kind: 'review',
          agent: 'reader',
          engine: 'claude',
          usualMs: 10,
          slowMs: 20,
          after: [],
        },
        { key: '1:fix', kind: 'work', agent: 'owner', engine: 'codex', usualMs: 30, slowMs: 40, after: ['1:review'] },
        {
          key: '2:ruling',
          kind: 'consolidate',
          agent: 'ruler',
          engine: 'claude',
          usualMs: 50,
          slowMs: 60,
          after: ['1:fix'],
        },
      ],
    },
  });
  const input = snapshot([owner, work(2, { kind: 'review' }), work(3, { after: 1 })]);
  const sizes = new Map([
    [1, { agent_ms: 100 }],
    [2, { agent_ms: 15 }],
    [3, { agent_ms: 1 }],
  ]);
  const slow = play(input, sizes, { pace: 'slow' });
  assert.equal(slow.get(1)!.done, 100);
  assert.equal(slow.get(1)!.merged, 215);
  assert.equal(slow.get(3)!.start, 215);
  assert.equal(play(input, sizes).get(1)!.merged, 195);
  sizes.set(1, { agent_ms: 100 });
  assert.equal(play(input, sizes, { pace: 'slow' }).get(1)!.merged, 215);
});

test('existing fixes keep task precedence while later work waits for its own forecast review', () => {
  const fix = work(1, { origin: 'fix' });
  const continuation = work(2, {
    follows: fix.id,
    reviewPlan: {
      panel: 'check',
      count: 1,
      terminal: 'ruling',
      stages: [
        {
          key: 'fix',
          job: fix.id,
          kind: 'work',
          agent: fix.agent,
          engine: fix.engine,
          usualMs: 10,
          slowMs: 10,
          after: [],
        },
        {
          key: 'ruling',
          kind: 'consolidate',
          agent: 'ruler',
          engine: 'codex',
          usualMs: 30,
          slowMs: 30,
          after: ['fix'],
        },
      ],
    },
  });
  const input = snapshot([fix, continuation]);
  const sizes = new Map([
    [fix.id, { agent_ms: 10 }],
    [continuation.id, { agent_ms: 100 }],
  ]);
  const seen = play(input, sizes);
  assert.equal(seen.get(fix.id)!.start, 0);
  assert.equal(seen.get(continuation.id)!.start, 10);
  assert.equal(seen.get(continuation.id)!.done, 110);
  assert.equal(seen.get(continuation.id)!.merged, 140);
});

test('due work pauses a predicted follow-through fix while the check itself keeps its room', () => {
  const minute = 60_000;
  const check = work(1, {
    origin: 'hq',
    followThrough: true,
    due: 4 * 60 * minute,
    reviewPlan: {
      panel: 'check',
      count: 2,
      terminal: '1:fix',
      stages: [
        {
          key: '1:fix',
          kind: 'work',
          agent: 'author',
          engine: 'claude',
          usualMs: 60 * minute,
          slowMs: 60 * minute,
          after: [],
        },
      ],
    },
  });
  const due = work(2, { notBefore: 3 * minute, due: 15 * minute });
  const input = { ...snapshot([check, due]), room: 1 };
  const sizes = new Map([
    [check.id, { agent_ms: 2 * minute }],
    [due.id, { agent_ms: minute }],
  ]);
  const forecast = play(input, sizes);
  assert.equal(forecast.get(check.id)!.done, 2 * minute);
  assert.equal(forecast.get(due.id)!.start, 4 * minute);
  assert.ok(forecast.get(due.id)!.done! <= due.due!);

  sizes.set(check.id, { agent_ms: 60 * minute });
  const protectedCheck = play(input, sizes);
  assert.equal(protectedCheck.get(check.id)!.done, 60 * minute);
  assert.equal(protectedCheck.get(due.id)!.start, 60 * minute);
});

test('a projected reviewer spends its own measured memory instead of the author demand', () => {
  const owner = work(1, {
    memoryMb: 2400,
    reviewPlan: {
      panel: 'one',
      count: 1,
      terminal: 'review',
      stages: [
        {
          key: 'review',
          kind: 'review',
          agent: 'reader',
          engine: 'claude',
          usualMs: 10,
          slowMs: 10,
          after: [],
          memoryMb: 300,
        },
      ],
    },
  });
  const input = snapshot([owner, work(2, { memoryMb: 2200, notBefore: 10 })]);
  input.slots.claude = 2;
  input.seatRuns = { claude: 2 };
  input.memory = {
    at: 0,
    availableMb: 4000,
    freeReserveMb: 1500,
    defaultRunMb: 700,
    totalSlots: 2,
    heldSlots: 0,
    heldMb: 0,
    starting: [],
    runningMb: {},
  };
  const played = play(
    input,
    new Map([
      [1, { agent_ms: 10 }],
      [2, { agent_ms: 10 }],
    ]),
  );
  assert.equal(played.get(1)!.merged, 20);
  assert.equal(played.get(2)!.start, 10);
  assert.equal(played.get(2)!.done, 20);
});

test('occupants outside the modeled queue keep their worker slots and memory', () => {
  const input = snapshot([work(1), work(2)]);
  input.slots.claude = 2;
  input.seatRuns = { claude: 2 };
  input.memory = {
    at: 0,
    availableMb: 4000,
    freeReserveMb: 1500,
    defaultRunMb: 700,
    totalSlots: 2,
    heldSlots: 0,
    heldMb: 0,
    starting: [],
    runningMb: { 99: 700 },
  };
  const played = play(
    input,
    new Map([
      [1, { agent_ms: 10 }],
      [2, { agent_ms: 10 }],
    ]),
  );
  assert.equal(played.get(2)!.start, 10);
  const blocked = structuredClone(input);
  blocked.memory!.totalSlots = 1;
  assert.equal(
    play(
      blocked,
      new Map([
        [1, { agent_ms: 10 }],
        [2, { agent_ms: 10 }],
      ]),
    ).get(1)!.start,
    null,
  );
});

test('projected reviews, fixes and rulings carry a board item through paced seats', () => {
  const minute = 60_000;
  const owner = work(1, {
    board: 1,
    itemWork: true,
    due: null,
    reviewPlan: {
      panel: 'check',
      count: 2,
      terminal: 'ruling',
      stages: [
        {
          key: 'review',
          kind: 'review',
          agent: 'reader',
          engine: 'claude',
          usualMs: minute,
          slowMs: minute,
          after: [],
        },
        {
          key: 'fix',
          kind: 'work',
          agent: 'author',
          engine: 'codex',
          usualMs: minute,
          slowMs: minute,
          after: ['review'],
        },
        {
          key: 'ruling',
          kind: 'consolidate',
          agent: 'ruler',
          engine: 'claude',
          usualMs: minute,
          slowMs: minute,
          after: ['fix'],
        },
      ],
    },
  });
  const input = snapshot([owner]);
  input.now = 24 * 60 * minute;
  input.pacing = true;
  for (const seat of input.seats) Object.assign(seat, { week: 0.8, weekResets: input.now + 5 * 24 * 60 * minute });
  const sizes = new Map([[1, { agent_ms: minute }]]);
  for (const pace of ['usual', 'slow'] as const) {
    assert.equal(play(input, sizes, { pace }).get(1)!.merged, input.now + 4 * minute);
    const ordinary = structuredClone(input);
    ordinary.jobs[0].itemWork = false;
    assert.ok(play(ordinary, sizes, { pace }).get(1)!.merged! > input.now + 60 * minute);
  }
});
