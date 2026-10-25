// node --test src/room.test.ts   (the test company): the worker's room report, and starvation in HQ, hq jobs and HQ's feed
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

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
    capacity = { slots: { claude: 10, codex: 4 }, seatRuns: { codex: 2 }, room: 7 };
  assert.equal((await h.worker('room', { short: false, free: 3000, capacity })).status, 200);
  assert.deepEqual(plannerCapacity(at + 1000), capacity);
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
  assert.match(low, /short of memory right now \(1\.5 GB free\)\. Don't start anything heavy/);
  assert.deepEqual(await said(other), [], 'once a spell');
  const [nudge] = await said(hog);
  assert.match(
    nudge,
    /short of memory right now[^\n]*\n.*own use is what brought .* it took 3\.4 GB of the 5\.0 GB that was free/,
  );

  await room({ verdict: 'low', cause: { job: other.id, tookMb: 3000, freeMb: 5120 } }, 1400);
  await room({ verdict: 'between' }, 2500);
  assert.deepEqual([await said(hog), await said(other)], [[], []], 'still the one spell, and no end yet');
  await room({ verdict: 'calm' }, 3500);
  for (const j of [hog, other]) {
    assert.match((await said(j)).join(), /memory again \(3\.4 GB free\)/);
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
