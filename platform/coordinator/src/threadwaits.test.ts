import { mock, test } from 'node:test';
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
    needs: { minutes: 0, share: 0 },
    after: { minutes: 360, share: 0.47 },
    card_or_time: { minutes: 12, share: 0.02 },
    paused: { minutes: 0, share: 0 },
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
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const X = T0 - 40 * HOUR;
const at = (minute: number) => new Date(X + minute * MIN).toISOString();

// A thread of these tasks, merged at minute 120, with the jobs as threadtime.ts reads them and their runs
function split(tasks: { id: number; run: [number, number]; again?: [number, number] }[]) {
  const ids = JSON.stringify(tasks.map(t => t.id));
  const rows = h.db
    .prepare(
      `select id, kind, agent, engine, pr, round, created, after, thread, coalesce(branch, 'job/' || id) branch,
      coalesce(seq, id) seq, finished, downtime from jobs where id in (select value from json_each(?)) order by id`,
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

test('a task before in its thread that waits for a card holds no later task: the turn puts it behind', () => {
  const card = Number(
    h.db
      .prepare(
        `insert into requests (created, agent, kind, title, body, status, changed, answered)
        values (?, 'kit', 'question', 'Q', 'Q?', 'answered', ?, ?)`,
      )
      .run(at(0), at(60), at(60)).lastInsertRowid,
  );
  const a = h.pastJob({
    agent: 'kit',
    thread: 'hq/carded',
    seq: 1,
    request: card,
    created: X,
    run: { started: X + 60 * MIN, ended: X + 70 * MIN },
  });
  const b = h.pastJob({
    agent: 'ada',
    thread: 'hq/carded',
    seq: 2,
    branch: `job/${a}`,
    created: X,
    run: { started: X + 10 * MIN, ended: X + 20 * MIN },
  });
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
  // (no report had every slot taken: the last 10 minutes held it for a reason not recorded)
  assert.deepEqual(inLine, { seats: 60, memory: 20, unexplained: 10 });
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

// (pauses, and the slots only as the worker reported them)
test("a paused deliverable's ready task waits for its pause, not in the line", () => {
  // hq/held is paused from minute 0 to 60 (its project paused too from 20, resumed at 40, inside it); the task starts at 90
  const id = h.pastJob({
    agent: 'kit',
    thread: 'hq/held',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  const pause = h.db.prepare(
    "insert into pauses (project, thread, why, by, at, resumed) values ('hq', ?, 'Waits for the board', 'juno', ?, ?)",
  );
  pause.run('hq/held', at(0), at(60));
  pause.run(null, at(20), at(40));
  assert.deepEqual(split([{ id, run: [90, 100] }]).parts, { paused: 60, line: 30, other: 20 });
  // a pause waiting for the board's decision lets go when the board answers it, though nobody resumes it
  const decision = h.db
    .prepare("insert into decisions (name, by, at, answered) values ('Which?', 'juno', ?, ?)")
    .run(at(0), at(30)).lastInsertRowid;
  const asked = h.pastJob({
    agent: 'kit',
    thread: 'margin/asked',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  h.db
    .prepare(
      "insert into pauses (project, thread, why, by, at, decision) values ('margin', 'margin/asked', 'Asks', 'juno', ?, ?)",
    )
    .run(at(0), decision);
  assert.deepEqual(split([{ id: asked, run: [90, 100] }]).parts, { paused: 30, line: 60, other: 20 });
  // a job in no thread waits for the desk's pause
  const loose = h.pastJob({ agent: 'kit', created: X, run: { started: X + 90 * MIN, ended: X + 100 * MIN } });
  h.db
    .prepare("insert into pauses (project, why, by, at, resumed) values ('unsorted', 'Waits', 'juno', ?, ?)")
    .run(at(0), at(60));
  assert.deepEqual(split([{ id: loose, run: [90, 100] }]).parts, { paused: 60, line: 30, other: 20 });
  h.db.exec('delete from pauses; delete from decisions');
});

test("a ready job with free slots isn't 'every slot taken': only the worker's report of every slot taken is", async () => {
  const { seatReported, slotsReported } = await import('./startholds.ts');
  h.db.prepare("insert into seats (id, engine, state) values ('free-1', 'claude', 'ready')").run();
  seatReported('free-1', X - 60 * MIN);
  // every slot taken from minute 20 to 50, as the room reports said
  slotsReported(true, X + 20 * MIN);
  slotsReported(true, X + 21 * MIN);
  slotsReported(false, X + 50 * MIN);
  assert.deepEqual(
    h.db
      .prepare('select began, ended from slot_spells')
      .all()
      .map(s => ({ ...s })),
    [{ began: X + 20 * MIN, ended: X + 50 * MIN }],
    'a spell, not a report',
  );
  const id = h.pastJob({
    agent: 'kit',
    thread: 'hq/free',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  assert.deepEqual(split([{ id, run: [90, 100] }]).inLine, { slots: 30, unexplained: 60 });
  // downtime work waits for a seat with spare room
  const spare = h.pastJob({
    agent: 'kit',
    thread: 'hq/spare',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  h.db.prepare('update jobs set downtime = 1 where id = ?').run(spare);
  assert.deepEqual(split([{ id: spare, run: [90, 100] }]).inLine, { slots: 30, downtime: 60 });
  h.db.exec("delete from seat_spells; delete from slot_spells; delete from seats where id = 'free-1'");
});

test('a task held behind a deliverable it needs waits for its merge, not in the line', () => {
  // hq/needed's task is queued at minute 0, runs 50-60 and merges at 70; hq/needing's task, queued at 0, starts at 90
  h.pastJob({
    agent: 'ada',
    thread: 'hq/needed',
    created: X,
    run: { started: X + 50 * MIN, ended: X + 60 * MIN },
    merged: X + 70 * MIN,
    byBranch: true,
  });
  const id = h.pastJob({
    agent: 'kit',
    thread: 'hq/needing',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  const parts = () => split([{ id, run: [90, 100] }]).parts;
  const edge = (drawn: number | null, dropped: number | null) => {
    h.db.exec("delete from thread_needs; delete from need_spells; delete from threads where id = 'hq/needed'");
    if (dropped === null)
      h.db.prepare("insert into thread_needs (thread, needs) values ('hq/needing', 'hq/needed')").run();
    if (drawn !== null || dropped !== null)
      h.db
        .prepare("insert into need_spells (thread, needs, drawn, dropped) values ('hq/needing', 'hq/needed', ?, ?)")
        .run(drawn === null ? null : at(drawn), dropped === null ? null : at(dropped));
  };
  edge(10, null);
  assert.deepEqual(parts(), { line: 30, needs: 60, other: 20 }, 'from the edge drawn at 10 until the merge');
  edge(10, 40);
  assert.deepEqual(parts(), { line: 60, needs: 30, other: 20 }, 'until hq plan unneed at 40');
  edge(null, null);
  assert.deepEqual(parts(), { line: 20, needs: 70, other: 20 }, 'an edge drawn before the recording, as it reads now');
  edge(null, 30);
  assert.deepEqual(parts(), { line: 60, needs: 30, other: 20 }, 'and one dropped since');
  // the needed deliverable closed at 40 without its merge holds nothing after
  edge(10, null);
  h.db
    .prepare(
      "insert into threads (id, project, name, goal, status, created, done) values ('hq/needed', 'hq', 'N', 'G', 'done', ?, ?)",
    )
    .run(at(0), at(40));
  assert.deepEqual(parts(), { line: 60, needs: 30, other: 20 });
  // a deliverable with no task drawn yet holds it until its first is queued, at 20 here
  h.db.prepare("update jobs set created = ? where thread = 'hq/needed'").run(at(20));
  h.db.exec("delete from threads where id = 'hq/needed'");
  assert.deepEqual(parts(), { line: 30, needs: 60, other: 20 }, 'held from 10 throughout');
  h.db.exec(
    "delete from thread_needs; delete from need_spells; update jobs set thread = null where thread = 'hq/needed'",
  );
});

test("a deliverable it needs holds only its thread's next task to start: the task before it holds it first", () => {
  // hq/ordered's A runs 0-50; B, queued at 0, waits for A and then for hq/also-needed, which merges at 70
  h.pastJob({
    agent: 'ada',
    thread: 'hq/also-needed',
    created: X,
    run: { started: X + 60 * MIN, ended: X + 65 * MIN },
    merged: X + 70 * MIN,
    byBranch: true,
  });
  const a = h.pastJob({
    agent: 'kit',
    thread: 'hq/ordered',
    seq: 1,
    created: X,
    run: { started: X, ended: X + 50 * MIN },
  });
  const b = h.pastJob({
    agent: 'kit',
    thread: 'hq/ordered',
    seq: 2,
    branch: `job/${a}`,
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  h.db.prepare("insert into thread_needs (thread, needs) values ('hq/ordered', 'hq/also-needed')").run();
  const { parts, held } = split([
    { id: a, run: [0, 50] },
    { id: b, run: [90, 100] },
  ]);
  assert.deepEqual(parts, { needs: 20, line: 20, other: 20 });
  assert.equal(held, 1, 'B held behind A, never behind the other deliverable');
  h.db.exec("delete from thread_needs; update jobs set thread = null where thread = 'hq/also-needed'");
});

test('a deliverable it needs settles as the claim reads it: done with nothing to merge, called off, or failed', () => {
  // hq/settled's task is queued at 0 and ends at 20; hq/settling's, queued at 0, starts at 90
  const needed = h.pastJob({
    agent: 'ada',
    thread: 'hq/settled',
    created: X,
    run: { started: X + 10 * MIN, ended: X + 20 * MIN },
  });
  const id = h.pastJob({
    agent: 'kit',
    thread: 'hq/settling',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  h.db.prepare("insert into thread_needs (thread, needs) values ('hq/settling', 'hq/settled')").run();
  const parts = (status: string) => {
    h.db.prepare('update jobs set status = ? where id = ?').run(status, needed);
    return split([{ id, run: [90, 100] }]).parts;
  };
  assert.deepEqual(parts('done'), { needs: 20, line: 70, other: 20 }, 'done with no pull request: until its end');
  h.db
    .prepare("insert into prs (number, branch, author, status) values (9480, ?, 'ada', 'dropped')")
    .run(`job/${needed}`);
  assert.deepEqual(parts('done'), { needs: 20, line: 70, other: 20 }, 'its latest pull request dropped');
  h.db.exec("update prs set status = 'open' where number = 9480");
  assert.deepEqual(parts('done'), { needs: 90, other: 20 }, 'one still in review holds on');
  h.db.exec('delete from prs where number = 9480');
  assert.deepEqual(parts('cancelled'), { needs: 20, line: 70, other: 20 }, 'called off: only that, it holds nothing');
  assert.deepEqual(parts('failed'), { needs: 90, other: 20 }, 'failed: held on past its end');
  // its redo, queued at 30 and merged at 50, doesn't settle it: the deliverable holds until it closes, at 60 here
  h.pastJob({
    agent: 'ada',
    thread: 'hq/settled',
    created: X + 30 * MIN,
    run: { started: X + 40 * MIN, ended: X + 45 * MIN },
    merged: X + 50 * MIN,
    byBranch: true,
  });
  assert.deepEqual(parts('stopped'), { needs: 90, other: 20 });
  h.db
    .prepare(
      "insert into threads (id, project, name, goal, status, created, done) values ('hq/settled', 'hq', 'S', 'G', 'done', ?, ?)",
    )
    .run(at(0), at(60));
  assert.deepEqual(parts('stopped'), { needs: 60, line: 30, other: 20 });
  h.db.exec(
    "delete from thread_needs; delete from threads where id = 'hq/settled'; update jobs set thread = null where thread = 'hq/settled'",
  );
});

test('an edge drawn and dropped through the plan holds its spell, and one drawn before the recording from the start', () => {
  // office/drawn's task is queued at 0 and merges at 70; office/drawing's, queued at 0, starts at 90
  for (const slug of ['drawn', 'drawing'])
    assert.equal(typeof projects.createThread({ project: 'office', name: slug, goal: 'It works', slug }), 'object');
  h.pastJob({
    agent: 'ada',
    thread: 'office/drawn',
    created: X,
    run: { started: X + 50 * MIN, ended: X + 60 * MIN },
    merged: X + 70 * MIN,
    byBranch: true,
  });
  const id = h.pastJob({
    agent: 'kit',
    thread: 'office/drawing',
    created: X,
    run: { started: X + 90 * MIN, ended: X + 100 * MIN },
  });
  const parts = () => split([{ id, run: [90, 100] }]).parts;
  const [need, unneed] = [
    () => plan.need('office/drawing', 'office/drawn', 'juno'),
    () => plan.unneed('office/drawing', 'office/drawn', 'juno', 'Apart'),
  ];
  // an edge an older coordinator drew, with no spell recorded, holds from the start, as the claim reads it now
  h.db.prepare("insert into thread_needs (thread, needs) values ('office/drawing', 'office/drawn')").run();
  assert.deepEqual(parts(), { line: 20, needs: 70, other: 20 });
  mock.timers.enable({ apis: ['Date'], now: X + 30 * MIN });
  try {
    assert.deepEqual(unneed(), { ok: true });
    assert.deepEqual(parts(), { line: 60, needs: 30, other: 20 }, 'until hq plan unneed at 30');
    mock.timers.setTime(X + 40 * MIN);
    assert.deepEqual(need(), { ok: true });
    assert.deepEqual(
      parts(),
      { line: 30, needs: 60, other: 20 },
      'and again from the edge drawn at 40 until the merge',
    );
    mock.timers.setTime(X + 60 * MIN);
    assert.deepEqual(unneed(), { ok: true });
    assert.deepEqual(parts(), { line: 40, needs: 50, other: 20 }, 'until its drop at 60');
  } finally {
    mock.timers.reset();
  }
  h.db.exec("delete from thread_needs; update jobs set thread = null where thread = 'office/drawn'");
});
