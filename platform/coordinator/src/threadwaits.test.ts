import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('threadwaits');

const MIN = 60_000,
  HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;

test("hq estimate --calibration splits the threads' waiting by what held them, and counts the tasks held for another job", async () => {
  // hq/x: kit's task A, then ada's B in its thread on A's branch (held for A, then in line), a review in line, its fix
  // waiting to be drawn and then in line, and an hour to the merge with nothing queued
  const a = h.pastJob({
    agent: 'kit',
    thread: 'hq/x',
    created: T0 - 10 * HOUR,
    run: { started: T0 - 9 * HOUR, ended: T0 - 8 * HOUR },
    merged: T0 - 3 * HOUR,
    pr: 9201,
    byBranch: true,
    files: ['platform/x.ts'],
  });
  const b = h.pastJob({
    agent: 'ada',
    thread: 'hq/x',
    branch: `job/${a}`,
    created: T0 - 10 * HOUR,
    run: { started: T0 - 7 * HOUR, ended: T0 - 6.5 * HOUR },
  });
  h.pastJob({
    agent: 'quill',
    kind: 'review',
    pr: 9201,
    round: 1,
    created: T0 - 6.5 * HOUR,
    run: { started: T0 - 6 * HOUR, ended: T0 - 5.9 * HOUR },
  });
  h.pastJob({
    agent: 'kit',
    pr: 9201,
    round: 1,
    stage: 'fix',
    branch: `job/${a}`,
    created: T0 - 5 * HOUR,
    run: { started: T0 - 4.5 * HOUR, ended: T0 - 4 * HOUR },
  });
  // hq/y: wren's task C --after B, on a file of its own: held until hq/x merged, in line, then parked on a card
  const card = Number(
    h.db
      .prepare(
        `insert into requests (created, agent, kind, title, body, status, answered)
        values (?, 'wren', 'question', 'Which?', 'Which one?', 'answered', ?)`,
      )
      .run(new Date(T0 - 2.4 * HOUR).toISOString(), new Date(T0 - 2.2 * HOUR).toISOString()).lastInsertRowid,
  );
  h.pastJob({
    agent: 'wren',
    thread: 'hq/y',
    after: b,
    request: card,
    created: T0 - 9 * HOUR,
    runs: [
      { started: T0 - 2.5 * HOUR, ended: T0 - 2.4 * HOUR },
      { started: T0 - 2.1 * HOUR, ended: T0 - 2 * HOUR },
    ],
    merged: T0 - HOUR,
    pr: 9202,
    byBranch: true,
    files: ['kits/y.ts'],
  });
  const reader = await h.start({ agent: 'bolt', title: 'Splitting the waiting' });
  const r = await h.agent('estimate/calibration', reader.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = r.body.threads;
  assert.equal(t.waiting.total, 294 + 468, "the split covers the threads' waiting whole");
  assert.deepEqual(t.waiting_split, {
    line: { minutes: 186, share: 0.24 },
    line_review: { minutes: 30, share: 0.04 },
    order: { minutes: 0, share: 0 },
    after: { minutes: 360, share: 0.47 },
    card_or_time: { minutes: 12, share: 0.02 },
    fix_drawn: { minutes: 54, share: 0.07 },
    other: { minutes: 120, share: 0.16 },
  });
  // B waited two hours for A on their one pull request (A ran half of it); C six hours for B, sharing no file with it
  assert.deepEqual(t.side_by_side, {
    held: { count: 2, total: 480, median: 120 },
    apart: { count: 1, total: 360, median: 360 },
    shared_files: { count: 0, total: 0, median: null },
    one_pr: { count: 1, total: 120, median: 120 },
    unknown: { count: 0, total: 0, median: null },
  });
  const { out } = await h.hq(reader, 'estimate', '--calibration');
  assert.match(out, /in line for a start \(the machine\): 3 h 6 min \(24%\)/);
  assert.match(out, /could have run side by side\): 1 task, 6 h in all/);
});

// ---- one thread at a time, through waitingSplit: what held a job, as the claim let it go

const { waitingSplit } = await import('./threadwaits.ts');
const X = T0 - 40 * HOUR;
const at = (minute: number) => new Date(X + minute * MIN).toISOString();

// A thread of these tasks, merged at minute 120, with the jobs as threadtime.ts reads them and their runs
function split(tasks: { id: number; run: [number, number]; again?: [number, number] }[]) {
  const ids = JSON.stringify(tasks.map(t => t.id));
  const rows = h.db
    .prepare(
      `select id, kind, agent, engine, pr, round, created, after, thread, coalesce(branch, 'job/' || id) branch,
      coalesce(seq, id) seq, finished from jobs where id in (select value from json_each(?)) order by id`,
    )
    .all(ids) as any[];
  const jobs = rows.map(r => ({ ...r, created: Date.parse(r.created), finished: Date.parse(r.finished) }));
  const pr = { number: 9300 + tasks[0]!.id, branch: jobs[0].branch, merged: X + 120 * MIN };
  const runs = new Map(
    tasks.map(t => [
      t.id,
      [t.run, ...(t.again ? [t.again] : [])].map(([start, end]) => ({ start: X + start * MIN, end: X + end * MIN })),
    ]),
  );
  const group = { key: jobs[0].thread, prs: [pr], tasks: jobs, work: jobs, reviews: [] };
  const { waiting_split, line_split, side_by_side } = waitingSplit([group], runs, new Map([[pr.branch, [pr]]]));
  const parts = Object.entries(waiting_split).filter(([, p]) => p.minutes);
  const inLine = Object.entries(line_split.line).filter(([, p]) => p.minutes);
  return {
    parts: Object.fromEntries(parts.map(([k, p]) => [k, p.minutes])),
    inLine: Object.fromEntries(inLine.map(([k, p]) => [k, p.minutes])),
    held: side_by_side.held.count,
    heldFor: side_by_side.held.total,
  };
}
// One task queued at minute 0, waiting for an event, started at 90
function waiting(thread: string, kind: string, arg: string) {
  const id = h.pastJob({ agent: 'kit', thread, created: X, run: { started: X + 90 * MIN, ended: X + 100 * MIN } });
  h.db.prepare('insert into wakes (job, kind, arg, since, met) values (?, ?, ?, ?, ?)').run(id, kind, arg, X, 'met');
  return split([{ id, run: [90, 100] }]);
}

test("a wake holds a job until it was met as wakes.ts meets it: the n-th deploy, the one recreating its service, its owner's sort", () => {
  for (const [minute, recreated] of [
    [10, '[]'],
    [30, '["hq"]'],
  ] as const)
    h.db
      .prepare('insert into deploys (file, sha, fetched, finished, ok, recreated) values (?, ?, ?, ?, 1, ?)')
      .run(`deploy-${minute}`, 'abc', at(minute - 1), at(minute), recreated);
  const after30 = { card_or_time: 30, line: 60, other: 20 };
  assert.deepEqual(waiting('hq/two-deploys', 'deploy', '2').parts, after30, 'the second deploy, not the first');
  assert.deepEqual(waiting('hq/recreated', 'recreated', 'hq').parts, after30, 'the deploy that recreated hq');
  const sorted = h.pastJob({
    agent: 'kit',
    thread: 'hq/sorted',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  h.db.prepare("insert into wakes (job, kind, arg, since, met) values (?, 'sorted', '', ?, 'sorted')").run(sorted, X);
  // (each proposal the job waits for, sorting.ts: its sorts row, decided when the owner accepts it)
  const sort = (made: number, decided: number) => {
    const proposal = h.db
      .prepare(
        "insert into proposals (created, agent, title, brief, status, decided, accepted) values (?, 'kit', 'A', 'B', 'accepted', ?, ?)",
      )
      .run(at(made), at(decided), sorted).lastInsertRowid;
    h.db.prepare('insert into sorts (proposal, job) values (?, ?)').run(proposal, sorted);
  };
  sort(0, 10);
  assert.deepEqual(split([{ id: sorted, run: [90, 100] }]).parts, { card_or_time: 10, line: 80, other: 20 });
  // held again at 20 by a new proposal, sorted at 50: from 10 to 20 it was ready for the machine
  sort(20, 50);
  assert.deepEqual(
    split([{ id: sorted, run: [90, 100] }]).parts,
    { card_or_time: 40, line: 50, other: 20 },
    'sorted again',
  );
});

test('a task before in its thread that waits for its time holds no later task: the turn puts it behind', () => {
  const a = h.pastJob({
    agent: 'kit',
    thread: 'hq/timed',
    seq: 1,
    created: X,
    run: { started: X + 60 * MIN, ended: X + 70 * MIN },
  });
  const b = h.pastJob({
    agent: 'ada',
    thread: 'hq/timed',
    seq: 2,
    branch: `job/${a}`,
    created: X,
    run: { started: X + 10 * MIN, ended: X + 20 * MIN },
  });
  h.db
    .prepare("insert into wakes (job, kind, arg, since, met) values (?, 'at', ?, ?, 'met')")
    .run(a, String(X + 60 * MIN), X);
  const { parts, held } = split([
    { id: a, run: [60, 70] },
    { id: b, run: [10, 20] },
  ]);
  assert.deepEqual(parts, { line: 10, card_or_time: 40, other: 50 });
  assert.equal(held, 0, 'B never waited for A');
});

test("a parked job's card holds it until the card is answered, not its last edit", () => {
  const card = Number(
    h.db
      .prepare(
        `insert into requests (created, agent, kind, title, body, status, changed) values (?, 'kit', 'question', 'Q', 'Q?', 'open', ?)`,
      )
      .run(at(0), at(10)).lastInsertRowid,
  );
  const id = h.pastJob({
    agent: 'kit',
    thread: 'hq/parked',
    request: card,
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  assert.deepEqual(split([{ id, run: [90, 100] }]).parts, { card_or_time: 90, other: 20 });
});

test('a task that started first holds a timed task of its thread once its time comes, until it ends', () => {
  // A (first in the thread) waits for minute 60; B starts at 10 and runs to 80, so A waits behind B from 60 to 80
  const a = h.pastJob({
    agent: 'kit',
    thread: 'hq/timed-behind',
    seq: 1,
    created: X,
    run: { started: X + 80 * MIN, ended: X + 90 * MIN },
  });
  const b = h.pastJob({
    agent: 'ada',
    thread: 'hq/timed-behind',
    seq: 2,
    branch: `job/${a}`,
    created: X,
    run: { started: X + 10 * MIN, ended: X + 80 * MIN },
  });
  h.db
    .prepare("insert into wakes (job, kind, arg, since, met) values (?, 'at', ?, ?, 'met')")
    .run(a, String(X + 60 * MIN), X);
  const { parts, held, heldFor } = split([
    { id: a, run: [80, 90] },
    { id: b, run: [10, 80] },
  ]);
  assert.deepEqual(parts, { line: 10, other: 30 });
  assert.deepEqual([held, heldFor], [1, 20], 'A held 20 minutes behind B');
});

test('a task that started first stays ahead of one before it in its thread when it is queued again', () => {
  // A (first in the thread) waits for minute 60 and runs 80-90; B runs 10-30, is queued again, and runs 70-80: B waits
  // in line from 60 to 70 (inTurn puts a started task ahead), and A never held it
  const a = h.pastJob({
    agent: 'kit',
    thread: 'hq/requeued',
    seq: 1,
    created: X,
    run: { started: X + 80 * MIN, ended: X + 90 * MIN },
  });
  const b = h.pastJob({
    agent: 'ada',
    thread: 'hq/requeued',
    seq: 2,
    branch: `job/${a}`,
    created: X,
    runs: [
      { started: X + 10 * MIN, ended: X + 30 * MIN },
      { started: X + 70 * MIN, ended: X + 80 * MIN },
    ],
  });
  h.db
    .prepare("insert into wakes (job, kind, arg, since, met) values (?, 'at', ?, ?, 'met')")
    .run(a, String(X + 60 * MIN), X);
  const { parts, held, heldFor } = split([
    { id: a, run: [80, 90] },
    { id: b, run: [10, 30], again: [70, 80] },
  ]);
  assert.deepEqual(parts, { line: 50, other: 30 });
  assert.deepEqual([held, heldFor], [1, 20], 'only A was held, behind B');
});

test("the line splits by what stood in the way: a minute with every seat drained is the seats', not the memory's", async () => {
  const { seatReported, roomReported } = await import('./startholds.ts');
  // the seat drains from minute 0 to 60, the worker is short of memory from 30 to 80, the task starts at 90
  const seat = (state: string, minute: number) => {
    h.db
      .prepare(
        "insert into seats (id, engine, state) values ('drain-1', 'claude', ?) on conflict(id) do update set state = ?",
      )
      .run(state, state);
    seatReported('drain-1', X + minute * MIN);
  };
  seat('draining', 0);
  seat('draining', 1);
  roomReported(true, X + 30 * MIN, X + 31 * MIN);
  roomReported(true, X + 25 * MIN, X + 32 * MIN);
  seat('ready', 60);
  roomReported(false, undefined, X + 80 * MIN);
  const spells = h.db.prepare("select state, began, ended from seat_spells where seat = 'drain-1' order by id").all();
  assert.deepEqual(
    spells.map(s => ({ ...s })),
    [
      { state: 'draining', began: X, ended: X + 60 * MIN },
      { state: 'ready', began: X + 60 * MIN, ended: null },
    ],
    'a spell a state, not a report',
  );
  assert.deepEqual(
    h.db
      .prepare('select began, ended from room_spells')
      .all()
      .map(s => ({ ...s })),
    [{ began: X + 30 * MIN, ended: X + 80 * MIN }],
    "a short spell from the worker's since",
  );
  const id = h.pastJob({
    agent: 'kit',
    thread: 'hq/drained',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  const { parts, inLine } = split([{ id, run: [90, 100] }]);
  assert.deepEqual(parts, { line: 90, other: 20 });
  assert.deepEqual(inLine, { seats: 60, memory: 20, slots: 10 });
  // a job of another engine had no seat at all; one queued before the records began is unrecorded
  const codex = h.pastJob({
    agent: 'kit',
    engine: 'codex',
    thread: 'hq/codex',
    created: X - 30 * MIN,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  assert.deepEqual(split([{ id: codex, run: [90, 100] }]).inLine, { unrecorded: 30, seats: 90 });
  h.db.exec('delete from seat_spells; delete from room_spells');
});
