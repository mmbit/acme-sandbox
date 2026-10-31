// node --test src/room.test.ts   (the test company): the worker's room report, and starvation in HQ, hq jobs and HQ's feed
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { memoryFixture } from '../../worker/src/memory.fixture.ts';
import { roomRecords } from '../../worker/src/roomrecords.ts';

const h = await harness('room');
const { reportRoom } = await import('./room.ts');
// A free slot's claim on a ready seat, as the worker reports it while memory is short
const claimOn = (engine: string) => ({ seat: `${engine}-seat`, engine });
const engineOf = (id: number) => h.job(id).engine as string;

test('no slot starting for five minutes while work waits shows in HQ and hq jobs, and on the feed once a spell, with no job for anyone', async context => {
  const M = 60_000,
    T0 = Date.now();
  const clock = context.mock.method(Date, 'now', () => T0);
  const roomLine = async (at: number) => {
    clock.mock.mockImplementation(() => at);
    return (await h.board('/api/room')).body.line;
  };
  const hog = await h.start({ agent: 'bolt' });
  const waiting = h.queue({ agent: 'bolt' });
  const jobs = async () => ((await h.board('/api/jobs')).body as any[]).length;
  const before = await jobs();
  const said = () =>
    h.db.prepare("select count(*) n from events where type = 'log' and text like 'No new jobs can start%'").get() as {
      n: number;
    };
  const short = (at: number, since: number) =>
    reportRoom(
      {
        short: true,
        since,
        free: 900,
        jobs: [
          { job: 1, mb: 300, cores: 0.2 },
          { job: hog.id, mb: 3100, cores: 7.6 },
        ],
        claims: [claimOn(engineOf(waiting))],
      },
      at,
    );

  assert.equal(short(T0, T0 - 2 * M).waiting, 1, 'it answers how much work only memory keeps waiting');
  assert.equal(await roomLine(T0), null, 'two minutes short is not yet starvation');
  short(T0 + 4 * M, T0 - 2 * M);
  const line = await roomLine(T0 + 4 * M);
  assert.match(
    line ?? '',
    new RegExp(
      `^No new jobs can start: the worker has been short of memory for 6 min, mostly from Bolt's job\\. \\d+ jobs? could start if memory allowed\\.$`,
    ),
  );
  short(T0 + 5 * M, T0 - 2 * M);
  assert.equal(said().n, 1, 'said once for the spell');

  assert.equal(await roomLine(T0 + 10 * M), null, 'a report older than three minutes says nothing');
  reportRoom({ short: false, free: 2400, jobs: [], claims: [] }, T0 + 6 * M);
  assert.equal(await roomLine(T0 + 6 * M), null, 'room again: gone');
  short(T0 + 20 * M, T0 + 12 * M);
  assert.equal(said().n, 2, 'a new spell is said again');
  assert.equal(await jobs(), before, 'no job for the CEO or anyone');
});

test("only work a free slot's claim would start counts, as the stall alarm counts it", async () => {
  const at = Date.now(),
    since = at - 9 * 60_000;
  const waitingFor = (claims: ReturnType<typeof claimOn>[], short = true) =>
    reportRoom({ short, since, free: 800, jobs: [], claims }, at).waiting;
  const work = h.queue({ agent: 'bolt' });
  const engine = engineOf(work);
  assert.equal(waitingFor([claimOn(engine)]), 1);
  assert.equal(waitingFor([claimOn(engine), claimOn(engine)]), 1, 'a job counts once');
  assert.equal(waitingFor([]), 0, 'every slot full, or no seat ready: memory is not what holds it');
  assert.equal((await h.board('/api/room')).body.line, null);
  assert.equal(waitingFor([claimOn('engine-elsewhere')]), 0, "a free slot of another engine can't start it");
  assert.equal(waitingFor([claimOn(engine)], false), 0, 'room enough: nothing waits for memory');

  h.db
    .prepare("insert or replace into settings (key, value) values ('company.paused', ?)")
    .run(JSON.stringify({ since: 'now' }));
  try {
    assert.equal(waitingFor([claimOn(engine)]), 0, 'the company is paused');
  } finally {
    h.db.prepare("delete from settings where key = 'company.paused'").run();
  }

  const spare = h.queue({ agent: 'bolt', downtime: true });
  assert.equal(waitingFor([claimOn(engineOf(spare))]), 0, 'downtime work waits for spare capacity by design');
});

test('the worker reports through its own route; agents and the board read the line', async () => {
  const r = await h.worker('room', {
    short: true,
    since: Date.now() - 9 * 60_000,
    free: 1000,
    jobs: [{ job: 'x', mb: 1 }],
    claims: [{ seat: 'a-seat', engine: 'nothing-here' }, { seat: 7 }],
  });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.waiting, 'number');
  const bolt = await h.start({ agent: 'bolt' });
  const waiting = h.queue({ agent: 'bolt' });
  await h.worker('room', {
    short: true,
    since: Date.now() - 9 * 60_000,
    free: 1000,
    jobs: [{ job: bolt.id, mb: 3000, cores: 4 }],
    claims: [claimOn(engineOf(waiting))],
  });
  const agentRoom = await h.agent('room', bolt.token);
  const boardRoom = await h.board('/api/room');
  assert.equal(agentRoom.status, 200);
  assert.equal(boardRoom.status, 200);
  assert.match(agentRoom.body.line, new RegExp(`short of memory for 9 min, mostly from job #${bolt.id} \\(bolt\\)\\.`));
  assert.match(boardRoom.body.line, /short of memory for 9 min, mostly from Bolt's job\./);
  assert.ok(!boardRoom.body.line.includes('#'), `the board's line names no job: ${boardRoom.body.line}`);
});

test('the planner uses reported slots and memory room, and an old report becomes unknown', async () => {
  const { plannerCapacity } = await import('./room.ts');
  const at = Date.now(),
    capacity = {
      slots: { claude: 10, codex: 4 },
      seatRuns: { codex: 2 },
      room: 7,
      memory: {
        at,
        availableMb: 3000,
        freeReserveMb: 1500,
        defaultRunMb: 700,
        totalSlots: 10,
        heldSlots: 0,
        heldMb: 0,
        starting: [{ until: at + 30_000, mb: 700 }],
        runningMb: { 999999: 2400, 999998: null },
      },
    };
  assert.equal((await h.worker('room', { short: false, free: 3000, capacity })).status, 200);
  assert.deepEqual(plannerCapacity(at + 1000), capacity);
  const { snapshot } = await import('./backlog.ts');
  assert.deepEqual(
    snapshot(at + 1000).memory,
    capacity.memory,
    'the plan retains timed reservations and per-run demand',
  );
  assert.equal(plannerCapacity(at + 4 * 60_000), null);
  reportRoom({ capacity: { ...capacity, room: 0 } }, at);
  assert.equal(plannerCapacity(at)?.room, 0, 'no memory room remains a measured zero');
});

test("a job's measured memory: its own peak, else its agent's median for its kind, else unmeasured", async () => {
  const { measuredMb } = await import('./room.ts');
  const done = async (peak: number | null, kind = 'work', agent = 'juno') => {
    const id = h.ended({ agent, kind });
    if (peak !== null) assert.equal((await h.worker('room', { jobs: [{ job: id, mb: peak, cores: 1 }] })).status, 200);
    return id;
  };
  const next = h.queue({ agent: 'juno' });
  assert.equal(measuredMb(next), null, "neither it nor its agent's done work measured: it isn't");
  await done(null);
  await done(9000, 'review');
  await done(9000, 'work', 'bolt');
  assert.equal(measuredMb(next), null, "unmeasured jobs, another kind's and another agent's don't count");
  for (const mb of [700, 400, 500]) await done(mb);
  assert.equal(measuredMb(next), 500, "its agent's median for its kind");
  await done(600);
  assert.equal(measuredMb(next), 550, 'an even count: the middle two halved');
  for (let i = 0; i < 20; i++) await done(300);
  assert.equal(measuredMb(next), 300, 'only the last 20');
  reportRoom({ jobs: [{ job: next, mb: 1200.4, cores: 1 }] });
  reportRoom({ jobs: [{ job: next, mb: 800, cores: 1 }] });
  assert.equal(measuredMb(next), 1200, 'its own peak: the most a report ever gave it');
});

test('memory really low: each running job hears it once, the job that caused it its nudge (firmer the next time), and that it is back; nothing otherwise, nor as a session stops', async () => {
  const hog = await h.start({ agent: 'bolt' }),
    other = await h.start({ agent: 'juno' });
  const said = async (j: { token: string }, stopping = false) =>
    ((await h.agent('inbox', j.token, { stopping })).body as { memory?: number; text: string }[])
      .filter(m => m.memory)
      .map(m => m.text);
  const room = (memory: unknown, free: number) =>
    h.worker('room', { short: false, free, jobs: [], claims: [], memory });

  await room({ verdict: 'between' }, 2500);
  assert.deepEqual(await said(other), [], 'not low: nothing');
  await room({ verdict: 'low', cause: { job: hog.id, tookMb: 3500, freeMb: 5120 } }, 1536);
  assert.deepEqual(await said(other, true), [], 'nothing as a session stops');
  const [low] = await said(other);
  assert.match(low, /server is full right now \(memory short: 1\.5 GB free\)/);
  assert.match(low, /Wait a few minutes before starting one/);
  assert.deepEqual(await said(other), [], 'once a spell');
  const [nudge] = await said(hog);
  assert.match(
    nudge,
    /server is full right now[^\n]*\n.*own use is what brought .* it took 3\.4 GB of the 5\.0 GB that was free/,
  );

  await room({ verdict: 'low', cause: { job: other.id, tookMb: 3000, freeMb: 5120 } }, 1400);
  await room({ verdict: 'between' }, 2500);
  assert.deepEqual([await said(hog), await said(other)], [[], []], 'still the one spell, and no end yet');
  await room({ verdict: 'calm' }, 3500);
  for (const j of [hog, other]) {
    assert.match((await said(j)).join(), /pressure is clear again \(3\.4 GB free\)/);
    assert.deepEqual(await said(j), [], 'that it is back, once');
  }

  await room({ verdict: 'low', cause: { job: hog.id, tookMb: 2048, freeMb: 4096 } }, 1800);
  await room({ verdict: 'calm' }, 3600);
  const firmer = await said(hog);
  assert.equal(firmer.length, 1);
  assert.match(
    firmer[0],
    /^HQ: this job has now brought the server short of memory 2 times: this time it took 2\.0 GB/,
  );
  assert.deepEqual(
    [await said(hog), await said(other)],
    [[], []],
    'a spell over before their next step: only its cause hears of it',
  );
});

test('a finish between room reports releases the stale occupant in a fresh plan without changing the report', async () => {
  const { snapshot } = await import('./backlog.ts');
  const { play } = await import('./eta.ts');
  const run = await h.start({ agent: 'kit', engine: 'reconcile' });
  const waiting = h.queue({ agent: 'kit', engine: 'reconcile' });
  await h.worker('seat', { seat: run.seat, engine: 'reconcile', state: 'ready', util: 0, week: 0 });
  const at = Date.now();
  const memory = {
    at,
    availableMb: 1500,
    freeReserveMb: 1500,
    defaultRunMb: 700,
    totalSlots: 1,
    heldSlots: 0,
    heldMb: 0,
    starting: [],
    runningMb: { [run.id]: 700 },
  };
  reportRoom({ capacity: { slots: { [h.job(waiting).engine]: 1 }, seatRuns: {}, room: 0, memory } }, at);
  await h.finish(run);
  const input = snapshot(at + 1000);
  assert.equal(input.memory!.availableMb, 2200);
  assert.deepEqual(input.memory!.runningMb, {});
  assert.deepEqual(memory.runningMb, { [run.id]: 700 }, 'the worker observation stays intact');
  input.jobs = input.jobs.filter(job => job.id === waiting);
  const sizes = new Map(input.jobs.map(job => [job.id, { agent_ms: 60_000 }]));
  const outcome = play(input, sizes).get(waiting)!;
  assert.equal(outcome.start, input.now);
});

test('server CPU pressure reaches every running job once, including reviews and late arrivals, then clears once', async t => {
  h.declareKinds(
    t,
    `
    pages:
      checkout: true
      browsers: true
      about: browser checks
    suites:
      checkout: true
      about: full test runs, gates with hq run --kind suites -- npm run gates
`,
  );
  const machine = await h.board('/api/machines/add', { name: 'Skynet' });
  assert.equal(machine.status, 200);
  t.after(async () => {
    await h.board('/api/machines/remove', { machine: machine.body.id });
  });
  const first = await h.start({ agent: 'bolt' });
  const review = await h.start({ agent: 'quill', kind: 'review' });
  assert.equal(h.job(review.id).kind, 'review');
  const inbox = async (token: string) => {
    const response = await h.agent('inbox', token, { stopping: false });
    assert.equal(response.status, 200);
    return (response.body as { memory?: number; text: string }[])
      .filter(message => message.memory)
      .map(message => message.text);
  };
  const report = (verdict: string, reasons: string[] = []) =>
    h.worker('room', { free: 6000, memory: { verdict, reasons } });
  await report('low', ['CPU pressure 75% over ten seconds']);
  const warning = await inbox(first.token);
  assert.equal(warning.length, 1);
  assert.match(warning[0], /server is full/);
  assert.match(warning[0], /CPU pressure 75%/);
  assert.match(warning[0], /Skynet/);
  assert.match(warning[0], /hq run --kind pages -- <command>/);
  assert.match(warning[0], /hq run --kind suites -- <command>/);
  assert.match(warning[0], /hq run --kind suites -- npm run gates/);
  assert.match(warning[0], /everyone's work/);
  const reviewWarning = await inbox(review.token);
  assert.equal(reviewWarning.length, 1);
  assert.match(reviewWarning[0], /CPU pressure 75%/);
  assert.deepEqual(await inbox(review.token), []);
  assert.deepEqual(await inbox(first.token), []);
  const late = await h.start({ agent: 'juno' });
  await report('between', ['memory recovering: 5.9 GB free']);
  const lateWarning = await inbox(late.token);
  assert.equal(lateWarning.length, 1, 'a running spell still reaches a job at its next step');
  assert.match(lateWarning[0], /memory recovering: 5\.9 GB free/);
  assert.deepEqual(await inbox(first.token), []);
  await report('calm');
  for (const job of [first, review, late]) {
    assert.match((await inbox(job.token)).join(), /pressure is clear again/);
    assert.deepEqual(await inbox(job.token), []);
  }
  await report('low', ['CPU pressure 80% over ten seconds']);
  assert.equal((await inbox(first.token)).length, 1, 'a new spell warns again');
  await report('calm');
  await inbox(first.token);
});

test('each emitted notice keeps its actual report while a spell continues with newer reasons and later clears', async context => {
  const { inspectMemory } = await import('./lowmemory.ts');
  const first = await h.start({ agent: 'bolt' });
  const late = await h.start({ agent: 'juno' });
  const { memory, pressure, reading, write } = memoryFixture(context);
  const records = roomRecords();
  const report = (used: number, cpu = 0, uses = new Map<number, number>()) => {
    reading(8e9, used, 0, 8e9);
    write('cpu.pressure', `some avg10=${cpu} avg60=0 avg300=0 total=0`);
    const captured = memory.inspect(() => ({
      freeMb: memory.freeMb(false),
      uses,
      room: memory.room(),
    }));
    const verdict = pressure({ ...captured.value, inputs: captured.inputs });
    const outgoing = { free: captured.value.freeMb, memory: verdict };
    records.room({
      report: outgoing,
      pressure: verdict,
      inputs: captured.inputs.map(input => ({ ...input, phase: 'watch' })),
    });
    const record = records.latest().room!;
    reportRoom({ ...outgoing, records: records.latest() });
    return record;
  };
  const readRoom = async () => (await h.agent('room/records', first.token)).body.retained.room;
  const calm = report(2e9);
  const calmRoom = await readRoom();
  assert.deepEqual(calmRoom.record, calm);
  assert.deepEqual(calmRoom.notice.transition, { kind: 'none', spell: null });
  const opening = report(7e9);
  const openedRoom = await readRoom();
  assert.deepEqual(openedRoom.record, opening);
  assert.deepEqual(openedRoom.notice, inspectMemory().report);
  assert.equal('transition' in opening, false, 'the worker record remains unchanged');
  const inbox = (token: string) => h.agent('inbox', token, { stopping: false });
  assert.ok((await inbox(first.token)).body.some((line: any) => line.memory));
  const original = inspectMemory().notice!;
  assert.deepEqual(original.report!.transition, { kind: 'opened', spell: original.spell });
  assert.deepEqual(openedRoom.notice, original.report);
  assert.equal(original.kind, 'warning');
  assert.deepEqual(original.report?.worker?.identity, opening.identity);
  assert.deepEqual(original.openingIdentity, opening.identity);
  assert.equal(original.report?.worker?.pressure.inputs.cpuBusy, false);
  const continuing = report(2e9, 75);
  const continuedRoom = await readRoom();
  assert.deepEqual(continuedRoom.record, continuing);
  assert.deepEqual(continuedRoom.notice, inspectMemory().report);
  assert.deepEqual(inspectMemory().notice, original, 'a report alone does not replace an emitted-notice witness');
  assert.ok((await inbox(late.token)).body.some((line: any) => line.memory));
  const newer = inspectMemory().notice!;
  assert.deepEqual(newer.report!.transition, { kind: 'continued', spell: newer.spell });
  assert.equal(newer.spell, original.spell);
  assert.equal(newer.job, late.id);
  assert.deepEqual(newer.openingIdentity, opening.identity);
  assert.deepEqual(newer.report?.worker?.identity, continuing.identity);
  assert.equal(newer.report?.worker?.pressure.inputs.memoryVerdict, 'calm');
  assert.equal(newer.report?.worker?.pressure.inputs.cpuBusy, true);
  assert.deepEqual(newer.report?.worker?.pressure.inputs.source, continuing.pressure.inputs.source);
  records.decision({
    action: 'select claim',
    outcome: 'claim selected',
    slot: 'chat',
    claim: { seat: 'chat', engine: 'codex', kind: 'chat', room: null },
    job: null,
    inputs: [],
  });
  assert.deepEqual(inspectMemory().notice, newer, 'an unrelated selection cannot replace the emitting report');
  await inbox(late.token);
  assert.deepEqual(inspectMemory().notice, newer, 'an empty hook does not replace the witness');
  const cleared = report(2e9);
  const clearedRoom = await readRoom();
  assert.deepEqual(clearedRoom.record, cleared);
  assert.deepEqual(clearedRoom.notice, inspectMemory().report);
  assert.deepEqual(openedRoom.notice.transition, { kind: 'opened', spell: original.spell });
  assert.ok((await inbox(first.token)).body.some((line: any) => line.memory));
  const allClear = inspectMemory().notice!;
  assert.deepEqual(allClear.report!.transition, { kind: 'cleared', spell: allClear.spell });
  assert.equal(allClear.kind, 'all-clear');
  assert.equal(allClear.spell, original.spell);
  assert.deepEqual(allClear.clearingIdentity, cleared.identity);
  assert.deepEqual(allClear.report?.worker?.identity, cleared.identity);
  assert.deepEqual(
    original.report?.worker?.pressure,
    opening.pressure,
    'the first delivery preserves its original inputs',
  );
  reportRoom({ ...cleared.report, records: records.latest() });
  assert.deepEqual(await readRoom(), clearedRoom, 'the same record keeps its original transition');
  reportRoom({ memory: { verdict: 'low', reasons: ['old worker without record'] }, free: 1000 });
  assert.equal(inspectMemory().report?.worker, null, 'a missing source stays absent');
  assert.deepEqual(await readRoom(), clearedRoom, 'a report without records leaves the retained copy alone');
  const unanchored = await h.start({ agent: 'quill', kind: 'review' });
  assert.ok((await inbox(unanchored.token)).body.some((line: any) => line.memory));
  assert.equal(inspectMemory().notice?.report?.worker, null, 'a legacy report keeps its absent worker source');
  assert.equal(inspectMemory().notice?.openingIdentity, null);
  report(2e9);
  report(7e9, 0, new Map([[first.id, 3000]]));
  const causedSpell = inspectMemory().report!.transition.spell;
  report(2e9);
  const next = report(7e9);
  const nudge = (await inbox(first.token)).body;
  assert.equal(nudge.length, 1);
  assert.match(nudge[0].text, /this job's own use/);
  assert.doesNotMatch(nudge[0].text, /the server is full/);
  const inspected = (await h.agent('room/records', first.token)).body;
  assert.deepEqual(inspected.retained.room.record.identity, next.identity);
  assert.equal(inspected.notices.notice.spell, causedSpell);
  assert.equal(inspected.notices.notice.pressureLine, false);
  assert.deepEqual(inspected.notices.notice.cause, { job: first.id, tookMb: 3000, freeMb: 5722 });
  assert.equal(inspected.notices.notice.report, null, 'a cause-only nudge uses no report');
  assert.equal(inspected.joins.noticeToMeasurement, null, 'a newer spell supplies none of the nudge text');
  report(2e9);
});
