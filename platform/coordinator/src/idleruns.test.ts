// node --test src/idleruns.test.ts   (the test company): runs idle an hour in the CEO's summary with what they wait on,
// and a dead session ended for a fresh one
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Running } from './harness.ts';

const RUNS_TOKEN = 'runs-secret';
const h = await harness('idleruns', { env: { RUNS_TOKEN } });
const { idleLines } = await import('./idleruns.ts');
const { db } = await import('./db.ts');
const { logStep } = await import('./log.ts');
const threats = await import('./threats.ts');
const forecast = await import('./forecast.ts');
(await import('./storage.ts')).FLOOR.bytes = 0; // (runs' bundles are taken whatever this machine's disk has free)
const MIN = 60_000,
  HOUR = 60 * MIN;

// The clock held at now, for a case to move (Date: what HQ stamps its runs and steps with), and let go after it
const held = () => {
  const now = Date.now();
  mock.timers.enable({ apis: ['Date'], now });
  return now;
};
afterEach(() => mock.timers.reset());

// The worker's room report: the jobs in their push's checks, and who waits for whose tests turn
async function report(checks: number[], resourceWaits: { job: number; on: number; resource: string }[] = []) {
  const at = Date.now(),
    memory = { at, availableMb: 3000, freeReserveMb: 1500, defaultRunMb: 700, totalSlots: 15, heldSlots: 0, heldMb: 0 };
  const capacity = {
    slots: { claude: 15 },
    seatRuns: { claude: 15 },
    room: 15,
    resourceWaits,
    memory: { ...memory, starting: [], runningMb: {}, checks },
  };
  assert.equal((await h.worker('room', { short: false, free: 3000, capacity })).status, 200);
}
const linesOf = (job: Running, now = Date.now()) => idleLines(now).filter(l => l.startsWith(`#${job.id} `));
const beat = async (job: Running) => (await h.heartbeat(job)).body as { yield?: string; immediate?: boolean };

test("a run held in its push's checks says whose tests turn it waits for, and isn't ended", async () => {
  const start = held();
  const waiter = await h.start({ agent: 'bolt' });
  mock.timers.setTime(start + 22 * HOUR - MIN);
  await beat(waiter); // (its session alive all along: a claim takes back a run whose heartbeat stopped)
  const holder = await h.start({ agent: 'bolt' });
  logStep(holder.id, 'bolt', 'Running a command: npm');
  mock.timers.setTime(start + 25 * HOUR);
  await report([holder.id, waiter.id], [{ job: waiter.id, on: holder.id, resource: 'tests' }]);
  assert.deepEqual(
    idleLines().filter(l => l.startsWith(`#${holder.id} `) || l.startsWith(`#${waiter.id} `)),
    [
      `#${waiter.id} (bolt: bolt's job) has done nothing for 25 h: its session ended, and its push's tests wait for the worker's tests turn, which #${holder.id}'s push holds`,
      `#${holder.id} (bolt: bolt's job) has done nothing for 3 h: its session ended, and its push's tests hold the worker's tests turn, 1 push waits behind them`,
    ],
    'the longest idle first',
  );
  for (const job of [holder, waiter]) assert.equal((await beat(job)).yield, undefined, `#${job.id} goes on`);
  await report([holder.id]);
  assert.match(linesOf(holder)[0], /: its session ended, and its push's checks are still running$/);
  for (const job of [holder, waiter]) await h.finish(job);
});

test("a session waiting on its hq run says so, and isn't ended", async () => {
  const start = held();
  const job = await h.start({ agent: 'bolt' });
  logStep(job.id, 'bolt', 'Running a command: hq');
  const spec = Buffer.from(JSON.stringify({ command: 'npm test', cwd: '', bring: [], minutes: 60 })).toString(
    'base64url',
  );
  const run = await h.send('/api/agent/runs', { authorization: `Bearer ${job.token}`, 'x-run': spec }, 'bundle');
  assert.equal(run.status, 200, run.text);
  mock.timers.setTime(start + 2 * HOUR);
  await report([]);
  assert.deepEqual(linesOf(job), [
    `#${job.id} (bolt: bolt's job) has done nothing for 2 h: its session waits on run #${run.json.id} (${run.json.kind}), which no helper has taken`,
  ]);
  assert.equal((await beat(job)).yield, undefined);
  // this server's helper takes the run and finishes it
  const helper = { authorization: `Bearer ${RUNS_TOKEN}` };
  const taken = await h.send(
    '/api/helper/take',
    { ...helper, 'content-type': 'application/json' },
    { kind: run.json.kind },
  );
  assert.equal(taken.status, 200, taken.text);
  const finished = await h.send(`/api/helper/runs/${taken.json.id}/finish`, { ...helper, 'x-run-exit': '0' }, 'files');
  assert.equal(finished.status, 200, finished.text);
  assert.deepEqual(linesOf(job), [], 'a run that just finished is activity');
  assert.equal((await beat(job)).yield, undefined, 'its session collects the result before an idle hour counts');
  await h.finish(job);
});

test('a run under an hour idle shows nothing, and one whose worker report is out of date is never ended', async () => {
  const start = held();
  const job = await h.start({ agent: 'bolt' });
  mock.timers.setTime(start + 59 * MIN);
  await report([]);
  assert.deepEqual(linesOf(job), []);
  assert.equal((await beat(job)).yield, undefined);
  mock.timers.setTime(start + 69 * MIN);
  assert.deepEqual(linesOf(job), [
    `#${job.id} (bolt: bolt's job) has done nothing for 1 h: what it waits on isn't known: the worker hasn't reported its push checks lately`,
  ]);
  assert.equal((await beat(job)).yield, undefined);
  await h.finish(job);
});

// A run idle an hour on a step that waits on nothing, which its heartbeat then ends
async function deadRun(now: number, fields: Record<string, unknown> = {}) {
  const job = await h.start({ agent: 'bolt', ...fields });
  logStep(job.id, 'bolt', 'Running a command: npm');
  mock.timers.setTime(now + HOUR + 5 * MIN);
  await report([]);
  return job;
}
const RESTARTED =
  /^HQ ended your last session on this job: it had done nothing for 1 h and waited on nothing \(its last step: Running a command: npm\)\. This is a new session in the same clone/;

test('a session idle an hour that waits on nothing ends at once, and a fresh session takes its job in its kept clone, told why', async () => {
  const job = await deadRun(held());
  const idle = `#${job.id} (bolt: bolt's job) has done nothing for 1 h: its session waits on nothing (its last step: Running a command: npm). HQ ends it at its next heartbeat, and a fresh session takes the job`;
  assert.deepEqual(linesOf(job), [idle]);
  assert.ok(threats.lines(forecast.refresh(Date.now())).includes(idle), "in the summary's threats");
  assert.deepEqual(await beat(job), { ok: true, yield: 'waiting', immediate: true });
  assert.equal((await h.finish(job, { status: 'yielded', session: 'dead-session' })).status, 200);
  assert.match(
    linesOf(job)[0],
    /^#\d+ \(bolt: bolt's job\): HQ ended its session at .+, idle 1 h and waiting on nothing \(its last step: Running a command: npm\)\. A fresh session takes the job$/,
  );
  const fresh = (await h.claim(job.engine))!;
  assert.equal(fresh.id, job.id);
  assert.equal(fresh.session, null, 'its next run starts a new session');
  assert.equal(fresh.note, null, 'with no "you were paused"');
  assert.match(fresh.restarted, RESTARTED, "in its kept clone, with why (the worker's keptclone.ts)");
  await h.finish(fresh, { status: 'yielded' });
  const again = (await h.claim(job.engine))!;
  assert.match(again.restarted, RESTARTED, 'told again while it has no session of its own');
  await h.finish(again, { status: 'yielded', session: 'fresh-session' });
  const own = (await h.claim(job.engine))!;
  assert.equal(own.session, 'fresh-session');
  assert.equal(own.restarted, undefined, 'its own session goes on untold');
  await h.finish(own);
});

for (const status of ['limited', 'interrupted'])
  test(`a dead run handed back ${status} starts a fresh session in its kept clone too`, async () => {
    const job = await deadRun(held());
    assert.equal((await beat(job)).yield, 'waiting');
    assert.equal((await h.finish(job, { status, session: 'dead-session' })).status, 200);
    db.prepare('update jobs set held_by = null where id = ?').run(job.id); // (a limit's seat lets it go: jobs.ts setSeat)
    const fresh = (await h.claim(job.engine))!;
    assert.equal(fresh.id, job.id);
    assert.equal(fresh.session, null);
    assert.match(fresh.restarted, RESTARTED);
    await h.finish(fresh);
  });

// A job queued on a lighter model (hq job --model), and its run handing it up (hq up: jobs.ts handUp)
const LIGHT = { model: 'claude-sonnet-5-5', light: true };
async function handUp(job: Running) {
  assert.equal((await h.finish(job, { status: 'up', session: 'light-session', up: 'Bigger.' })).status, 200);
}

test('a hand-up after HQ ended a dead session is told alone, and so is a dead session ended after a hand-up', async () => {
  const dead = await deadRun(held(), LIGHT);
  await beat(dead);
  await h.finish(dead, { status: 'yielded', session: 'dead-session' });
  const restarted = (await h.claim(dead.engine))!;
  assert.match(restarted.restarted, RESTARTED);
  await handUp(restarted);
  const up = (await h.claim(dead.engine))!;
  assert.equal(up.id, dead.id);
  assert.ok(up.handedUp, 'told of its hand-up');
  assert.equal(up.restarted, undefined, 'not of the dead session before it');
  await h.finish(up);

  const light = await h.start({ agent: 'bolt', ...LIGHT });
  await handUp(light);
  const after = (await h.claim(light.engine))!;
  assert.ok(after.handedUp);
  logStep(after.id, 'bolt', 'Running a command: npm');
  mock.timers.setTime(Date.now() + HOUR + 5 * MIN);
  await report([]);
  assert.equal((await beat(after)).yield, 'waiting');
  await h.finish(after, { status: 'yielded', session: 'dead-session' });
  const fresh = (await h.claim(light.engine))!;
  assert.match(fresh.restarted, RESTARTED);
  assert.equal(fresh.handedUp, undefined, 'not of the hand-up before it');
  await h.finish(fresh);
});
