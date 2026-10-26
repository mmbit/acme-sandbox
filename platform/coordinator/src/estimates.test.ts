// node --test src/estimates.test.ts   (uses a throwaway DATA_DIR): hq estimate, past jobs' agent time and the seats'
// headroom.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const HOUR = 3_600_000,
  T0 = Math.floor(Date.now() / HOUR) * HOUR;

const h = await harness('estimates');
mock.timers.enable({ apis: ['Date'], now: T0 - 5 * HOUR });
test.after(() => mock.timers.reset());

const usage = (cost: number) => ({
  models: { 'claude-opus-5-5': { input: 10, cacheWrite: 0, cacheRead: 100, output: 5, cost } },
  cost,
  resumed: false,
});
const later = (ms: number) => mock.timers.setTime(Date.now() + ms);
const earlier = await h.start({ agent: 'kit', title: 'Earlier chart', engine: 'claude' }, { seat: 'claude-a' });
later(5 * HOUR);
await h.finish(earlier, { usage: usage(3) });

let resumedJob: number;

// A done job: each run's minutes, with the gap before the next run (a wait for a seat).
async function done(title: string, runs: [minutes: number, gap: number][], cost: number | null = 1) {
  const id = h.queue({ agent: 'kit', title }),
    engine = (h.db.prepare('select engine from jobs where id = ?').get(id) as { engine: string }).engine;
  for (const [i, [minutes, gap]] of runs.entries()) {
    const job = (await h.claim(engine, { seat: 'claude-a' }))!;
    assert.equal(job.id, id);
    later(minutes * 60_000);
    const last = i === runs.length - 1;
    await h.finish(job, {
      status: last ? 'done' : 'interrupted',
      usage: cost === null ? undefined : usage(cost / runs.length),
      session: `s${id}-${i}`,
    });
    later(gap * 60_000);
  }
  return id;
}
// (a new reader each time: the clock moves hours on, so an earlier one's heartbeat is stale)
const reader = () => h.start({ agent: 'bolt', title: 'Sizing' });
const ask = async (query: string) => {
  const r = await h.agent(`estimate?${query}`, (await reader()).token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test("a job's agent time is its runs, without the wait for a seat between them", async () => {
  const id = await done('Seats in HQ: switch seats from the board', [
    [30, 180],
    [20, 0],
  ]);
  resumedJob = id;
  const found = await ask(`q=%23${id}`);
  const job = found.job;
  assert.deepEqual(job.timing_quality, ['resumed', 'interrupted']);
  assert.equal(
    (await ask('q=seats%20board')).jobs.some((j: { id: number }) => j.id === id),
    false,
  );
  assert.deepEqual([job.agent_minutes, job.wall_minutes, job.runs, job.rebuilt], [50, 230, 2, false]);
});

test("past jobs are matched by their title's words, by another job's title, and by the folder they changed", async () => {
  const mug = await done('Mug print file at 300 dpi', [[40, 0]]);
  const poster = await done('Poster print file with bleed', [[70, 0]]);
  h.db
    .prepare("insert into prs (number, branch, author, status, files) values (90, ?, 'kit', 'merged', ?)")
    .run(`job/${poster}`, JSON.stringify(['products/poster/print.ts']));
  assert.deepEqual((await ask('q=mug%20print')).jobs.map((j: any) => j.id).slice(0, 2), [mug, poster]);
  const like = await ask(`q=${encodeURIComponent(`#${mug}`)}`);
  assert.equal(like.job.id, mug);
  assert.equal(like.jobs[0].id, poster);
  assert.deepEqual(
    (await ask('q=print&path=products/poster/')).jobs.map((j: any) => j.id),
    [poster],
  );
});

test("the seats' headroom: each week's share left and its reported reset", async () => {
  await h.worker('seat', {
    seat: 'claude-a',
    engine: 'claude',
    state: 'idle',
    week: 0.4,
    weekResets: Date.now() + 72 * HOUR,
  });
  const { seats, engines } = (await ask('q=nothing%20like%20it')).seats;
  assert.equal(seats.find((s: any) => s.id === 'claude-a').week, 0.4);
  const claude = engines.find((e: any) => e.engine === 'claude');
  assert.deepEqual([claude.left_percent, claude.next_reset], [60, Date.now() + 72 * HOUR]);
});

test("a seat with no reading yet isn't counted as used up: what's left says how many seats it stands on", async () => {
  await h.worker('seat', { seat: 'codex-a', engine: 'codex', state: 'idle' });
  const { engines } = (await ask('q=nothing%20like%20it')).seats;
  const codex = engines.find((e: any) => e.engine === 'codex');
  assert.deepEqual([codex.left_percent, codex.measured_seats, codex.unmeasured_seats], [0, 0, 1]);
  const { out } = await h.hq(await reader(), 'estimate');
  assert.match(out, /codex: none of its 1 seat has a reading yet/);
  assert.match(out, /claude: .*60% of one seat's week left on 1 seat with a reading/);
});

test('hq estimate prints the past jobs and the seats', async () => {
  const { out, code } = await h.hq(await reader(), 'estimate', `#${resumedJob}`);
  assert.equal(code, 0, out);
  assert.match(out, /50 min of agent time in 2 runs, 3 h 50 min from its first start to its end/);
  assert.match(out, /claude-a \(claude, idle\): 40% of its week used/);
});

test('a done job with no usage reported has no spend, and is left out of the typical spend', async () => {
  await done('Meter sweep one', [[20, 0]], 2);
  await done('Meter sweep two', [[20, 0]], 4);
  await done('Meter sweep three', [[20, 0]], 6);
  const unmetered = await done('Meter sweep four', [[20, 0]], null);
  const found = await ask('q=meter%20sweep');
  assert.equal(found.jobs.find((j: any) => j.id === unmetered).spend, null);
  // counted as 0 it would pull the median from 4 down to 2
  assert.deepEqual([found.typical.spend, found.typical.unit], [4, '$']);
  const { out } = await h.hq(await reader(), 'estimate', 'meter sweep');
  assert.match(out, /seat spend not reported/);
});

test('credential-call follow-ups and jobs holding keys never expose estimate scopes to jobs or calls', async () => {
  const card = h.jobs.createRequest({
    agent: 'kit',
    kind: 'credential',
    title: 'Credential comparison',
    body: 'Enter the test key.',
    secrets: 'STRIPE_TEST_ESTIMATE_KEY',
  }) as { id: number };
  const first = (await h.voice(`call-context?agent=kit&request=${card.id}`)).body;
  const transcript = 'Board: the test key spoken aloud is otter space zebra.';
  assert.equal(
    (
      await h.voice('call-end', {
        agent: 'kit',
        request: card.id,
        token: first.token,
        lines: [transcript],
      })
    ).status,
    200,
  );
  const resumed = (await h.voice('call-context?agent=kit')).body;
  assert.equal(
    (
      await h.voice('call-end', {
        agent: 'kit',
        token: resumed.token,
        lines: [transcript],
      })
    ).status,
    200,
  );
  const follows: number[] = [];
  for (const call of [first.call, resumed.call]) {
    const id = (await h.board('/api/calls')).body.find((c: any) => c.id === call).job;
    const follow = await h.claimJob(id);
    assert.ok(follow.prompt.includes(transcript));
    assert.equal(
      (
        await h.agent('item', follow.token, {
          call,
          kind: 'decision',
          goal: 'The board wants it on time.',
          owner: 'kit',
          what: 'Record test credentials',
          quote: transcript,
        })
      ).status,
      200,
    );
    assert.equal((await h.agent('reply', follow.token, { text: 'Recorded the test credential.' })).status, 200);
    later(20 * 60_000);
    assert.equal((await h.finish(follow, { result: 'The test key is otter space zebra.' })).status, 200);
    assert.equal(h.jobs.holdsKeys(id), false, 'the call classification must also cover unmarked follow-ups');
    follows.push(id);
  }
  const run = { started: Date.now() - HOUR, ended: Date.now() - 60_000 };
  const marked = h.pastJob({ agent: 'kit', title: 'Credential comparison', about_keys: 1, run });
  const customer = h.pastJob({ agent: 'kit', title: 'Credential comparison', customers: 1, run });
  const safe = h.pastJob({
    agent: 'kit',
    title: 'Credential comparison',
    prompt: 'Public scope',
    result: 'Public report',
    run,
  });
  const privateJobs = [...follows, marked, customer];
  const queued = h.queue({ agent: 'kit', title: 'Credential comparison' });
  const sizes = await import('./sizes.ts');
  sizes.recordQueued(queued, 'kit', 'Compare historical scopes', {
    agent_ms: 60_000,
    refs: [...privateJobs, safe],
    why: 'Previously saved references',
  });
  const jobReader = await reader();
  const callReader = (await h.voice('call-context?agent=bolt')).body;
  for (const token of [jobReader.token, callReader.token]) {
    await privateComparisons(token, privateJobs, safe, queued);
  }
  assert.equal(h.jobs.holdsKeys(jobReader.id), false);
  // (the timing audit is counts only, no scopes: a call reads it as a job does.)
  const audited = await h.agent('estimate/audit', callReader.token);
  assert.equal(audited.status, 200);
  assert.doesNotMatch(JSON.stringify(audited.body), /Credential comparison|otter space zebra|Public scope/);
  // (a call revises a size as its agent does, server.ts MANAGE_ROUTES: only the CEO's, and a size names no scopes)
  const handed = (await h.agent('job', callReader.token, { agent: 'kit', title: 'Again', prompt: 'x' })).body.id;
  assert.equal((await h.agent('sizes', callReader.token, { job: handed, time: '30m', why: 'Slipped' })).status, 403);
});

async function privateComparisons(token: string, privateJobs: number[], safe: number, queued: number) {
  for (const id of privateJobs) {
    const response = await h.agent(`estimate?q=%23${id}`, token);
    assert.equal(response.status, 200);
    assert.deepEqual([response.body.job.brief, response.body.job.report], [null, null]);
    assert.deepEqual(response.body.job.timing_quality, []);
  }
  for (const query of ['agent=kit', 'q=Credential%20comparison', `q=%23${queued}`]) {
    const response = await h.agent(`estimate?${query}`, token);
    assert.equal(response.status, 200);
    const publicJob = response.body.jobs.find((j: any) => j.id === safe);
    assert.deepEqual([publicJob?.brief, publicJob?.report], ['Public scope', 'Public report']);
    assert.ok(response.body.jobs.every((j: any) => !privateJobs.includes(j.id)));
    assert.doesNotMatch(JSON.stringify(response.body), /otter space zebra/);
  }
}
