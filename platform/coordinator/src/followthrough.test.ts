// node --test src/followthrough.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';
import { followthroughFixture } from './followthrough.fixture.ts';

// The checks and their repairs go to the CEO's office, each a one-task thread there.
const PROJECTS = `made:\n  checks: { hq: office }\nprojects:\n  - { id: office, name: The office, owner: juno }\n`;
const h = await harness('followthrough', {
  before: repo => writeFileSync(`${repo}/company/projects.yaml`, PROJECTS),
});
const { db } = h;
const { followThroughSweep, read, recordVerdict, START_MS, FINISH_MS, RETELL_MS } = await import('./followthrough.ts');
const { ceo, roles } = await import('./company.ts');
const { MIN, HOUR, t0, reset, agreed, checks, alarm, told, startCheck } = await followthroughFixture(h);

test('with nothing the board agreed still standing, no check is queued', async () => {
  reset();
  agreed({ status: 'handled', kind: 'task' });
  const merged = await h.start({ agent: 'bolt' });
  await h.finish(merged, { status: 'done', pr: 41, branch: `job/${merged.id}` });
  db.prepare("update prs set status = 'merged' where number = 41").run();
  agreed({ status: 'handled', kind: 'promise', job: merged.id });
  agreed({ status: 'replaced' });
  agreed({ status: 'dropped' });
  followThroughSweep(t0);
  assert.deepEqual(checks(), []);
});

test("work the CEO queues from a check doesn't take the check's own thread and window", async () => {
  reset();
  agreed();
  followThroughSweep(Date.now());
  const check = await startCheck();
  const r = await h.agent('job', check.token, { agent: ceo(), title: 'Ask why the review is stuck' });
  assert.equal(r.status, 200);
  assert.equal(h.job(r.body.id).thread, null, "the CEO's own work, on the desk");
  await h.finish(check);
});

test('the next work excludes held, paused and downtime jobs', () => {
  reset();
  h.queue({ agent: 'bolt', title: 'Held work' });
  h.queue({ agent: 'chime', title: 'Downtime work', downtime: true });
  const ready = h.queue({ agent: 'chime', title: 'Eligible work' });
  db.prepare("insert into settings (key, value) values ('runs.held', ?)").run(
    JSON.stringify({ agents: ['bolt'], until: 'the run ends' }),
  );
  const text = () => read({ id: 0, agent: ceo() });
  assert.doesNotMatch(text(), /Held work|Downtime work/);
  assert.match(text(), /Eligible work/);
  db.prepare("insert into settings (key, value) values ('company.paused', ?)").run('{}');
  assert.doesNotMatch(text(), /Eligible work/);
  db.prepare("update settings set value = ? where key = 'company.paused'").run(JSON.stringify({ allow: [ready] }));
  assert.match(text(), /Eligible work/);
});

test('an open agreement gets the CEO one check an hour, due by the end of its hour, never a second beside an open one', () => {
  reset();
  agreed();
  followThroughSweep(t0);
  followThroughSweep(t0 + 30 * MIN);
  assert.equal(checks().length, 1);
  const [check] = checks();
  assert.equal(check.agent, ceo());
  assert.deepEqual([check.thread, check.deadline, check.aim], [`office/job-${check.job}`, t0 + HOUR, t0 + HOUR]);
  followThroughSweep(t0 + HOUR + MIN); // the first is still queued: it's the one to run
  assert.equal(checks().length, 1);
  db.prepare("update followthrough_checks set verdict = 'ok'").run();
  followThroughSweep(t0 + HOUR + 2 * MIN);
  assert.equal(checks().length, 2);
});

test("the check's prompt carries the company's own words for it (org.yaml's followThrough.prompt) after its own text", () => {
  const orgFile = `${h.repo}/company/org.yaml`,
    orgChart = readFileSync(orgFile, 'utf8');
  const prompt = () =>
    (db.prepare('select prompt from jobs where id = ?').get(checks().at(-1)!.job) as { prompt: string }).prompt;
  reset();
  agreed();
  followThroughSweep(t0);
  assert.match(prompt(), /^HQ's hourly check/);
  assert.doesNotMatch(prompt(), /Our own additions/);
  // A slip's cause, the scheduler's or the task's, never work cut by hand (board, call 120).
  assert.match(prompt(), /never hand-pick work to cut, pause or move ahead/);
  assert.match(prompt(), /The scheduler failed to act[^]*The scheduler acted and the task itself overruns/);
  // A quota wait or a server short of room is capacity, not a scheduler fault, and there are more than two causes.
  assert.match(prompt(), /could have used and should\s+have taken from it/);
  assert.match(prompt(), /The scheduler acted and capacity is short[^]*That is no scheduler\s+fault/);
  assert.doesNotMatch(prompt(), /one of two causes/);
  assert.doesNotMatch(prompt(), /cut what's in the way/);
  try {
    writeFileSync(orgFile, `${orgChart}\nfollowThrough:\n  prompt: |\n    Only ever this board's words.\n`);
    assert.deepEqual(recordVerdict(checks().at(-1)!.job, 'ok', ''), { ok: true });
    followThroughSweep(t0 + HOUR + MIN);
    assert.match(
      prompt(),
      /all is on track\.\n\nOur own additions:\nOnly ever this board's words\.\n\nThe summary as this check/,
    );
  } finally {
    writeFileSync(orgFile, orgChart);
  }
});

test('a company pause gives an unstarted check time to start after work resumes', () => {
  reset();
  agreed();
  followThroughSweep(t0);
  db.prepare("insert into settings (key, value) values ('company.paused', ?)").run(
    JSON.stringify({ since: new Date(t0 + 5 * MIN).toISOString() }),
  );
  followThroughSweep(t0 + 2 * HOUR);
  db.prepare("delete from settings where key = 'company.paused'").run();
  followThroughSweep(t0 + 2 * HOUR + MIN);
  assert.equal(alarm(), null);
  assert.deepEqual(told(), []);
  assert.equal(checks().length, 1);
});

test("seats at their limits give an unstarted check time to start once one is back; a signed-out seat doesn't", () => {
  const back = t0 + 4 * HOUR;
  const seats = (state: string, until?: number) => {
    h.jobs.setSeat('claude-1', 'claude', 'draining', t0 + 3 * 24 * HOUR);
    h.jobs.setSeat('claude-2', 'claude', state, until);
    h.jobs.setSeat('claude-3', 'claude', 'paused');
    h.jobs.setSeat('codex-1', 'codex', 'ready', 0);
  };
  reset();
  agreed();
  seats('sleeping', back);
  followThroughSweep(t0);
  followThroughSweep(t0 + 2 * HOUR);
  followThroughSweep(back - MIN); // the sweep's last minute with every seat out
  followThroughSweep(back + START_MS - 2 * MIN);
  assert.equal(alarm(), null);
  assert.deepEqual(told(), []);
  assert.equal(checks().length, 1);
  followThroughSweep(back + START_MS);
  assert.match(alarm(), /hasn't started 16 min after it was queued/);
  // a seat that lost its sign-in won't come back by itself
  reset();
  agreed();
  seats('login');
  followThroughSweep(t0);
  followThroughSweep(t0 + START_MS);
  assert.match(alarm(), /hasn't started 15 min after it was queued/);
});

test('persistent failures reach the desk phone once even while the repair job stays queued or running', () => {
  for (const status of ['queued', 'running']) {
    reset();
    agreed();
    followThroughSweep(t0);
    followThroughSweep(t0 + START_MS);
    db.prepare('update jobs set status = ? where id = ?').run(status, told()[0].id);
    const cards = () => db.prepare('select id, agent, body from requests').all();
    followThroughSweep(t0 + START_MS + RETELL_MS - MIN);
    assert.equal(cards().length, 0);
    followThroughSweep(t0 + START_MS + RETELL_MS);
    assert.equal(cards().length, 1, status);
    assert.equal(cards()[0].agent, roles().process);
    assert.match(String(cards()[0].body), /3 h/);
    followThroughSweep(t0 + START_MS + 2 * RETELL_MS);
    assert.equal(cards().length, 1);
    assert.equal(told().length, 1);
    recordVerdict(checks()[0].job, 'ok', '');
    followThroughSweep(t0 + 7 * HOUR);
    followThroughSweep(t0 + 7 * HOUR + START_MS);
    followThroughSweep(t0 + 7 * HOUR + START_MS + RETELL_MS);
    assert.equal(cards().length, 2);
  }
});

test('hq followthrough reads the agreement in the board words, the running work, and records the verdict once', async () => {
  reset();
  const queuer = await h.start({ agent: 'bolt', title: 'Queue the hold' });
  await h.finish(queuer);
  agreed({ job: queuer.id, status: 'handled' });
  const game = await h.start({ agent: 'bolt', title: 'Fixture game: a new level', engine: 'claude' });
  followThroughSweep(Date.now());
  const check = await startCheck();

  const read = await h.hq(check, 'followthrough');
  assert.equal(read.code, 0, read.out);
  assert.match(read.out, /No game work until the projects build lands · job #\d+ done/);
  assert.match(read.out, /The board's words: "Hold the game work tonight, all of it/);
  assert.match(read.out, new RegExp(`#${game.id} (?:[A-Z]{2,3}-)?[A-Z]{2,8} bolt, running: Fixture game: a new level`));

  assert.equal((await h.hq(check, 'followthrough', 'acted')).code, 1); // acted needs its line
  assert.equal((await h.hq(check, 'followthrough', 'acted', `stopped #${game.id}: game work during the hold`)).code, 0);
  assert.equal(checks()[0].verdict, 'acted');
  assert.equal((await h.hq(check, 'followthrough', 'ok')).code, 1);
  assert.equal(checks()[0].verdict, 'acted');
  assert.equal((await h.hq(game, 'followthrough', 'ok')).code, 1);
  assert.equal((await h.agent('followthrough', game.token)).status, 403);
});

test("a check that hasn't started in time is an alarm on the status line", () => {
  reset();
  agreed();
  followThroughSweep(t0);
  followThroughSweep(t0 + START_MS - MIN);
  assert.equal(alarm(), null);
  assert.deepEqual(told(), []);
  followThroughSweep(t0 + START_MS);
  assert.match(alarm(), /hasn't started 15 min after it was queued/);
  // the Process team is asked to mend it, due by the end of the hour, once while that job is open
  assert.equal(told().length, 1);
  const [repair] = told();
  assert.equal(repair.agent, roles().process);
  assert.deepEqual([repair.thread, repair.deadline, repair.aim], [`office/job-${repair.id}`, t0 + HOUR, t0 + HOUR]);
  followThroughSweep(t0 + HOUR + MIN); // still the one to run: no second check queues behind it
  assert.equal(checks().length, 1);
  followThroughSweep(t0 + START_MS + RETELL_MS);
  assert.equal(told().length, 1); // its job is still open
  db.prepare("update jobs set status = 'done' where id = ?").run(told()[0].id);
  followThroughSweep(t0 + START_MS + RETELL_MS + MIN);
  assert.equal(told().length, 2); // still broken after it ended: asked again
  const end = t0 + 4 * HOUR; // (the end of the hour it's made in, three hours on)
  assert.deepEqual([told()[1].deadline, told()[1].aim], [end, end]);
});

test('a check that ends without a verdict is an alarm, and the next hour queues a fresh one', async () => {
  reset();
  agreed();
  followThroughSweep(Date.now());
  const check = await startCheck();
  await h.finish(check);
  followThroughSweep(Date.now());
  assert.match(alarm(), /ended \(done\) without a verdict/);
  assert.equal(told().length, 1);
  db.prepare("update jobs set status = 'done' where id = ?").run(told()[0].id); // (out of the check's way in the queue)
  followThroughSweep(Date.now() + HOUR);
  assert.equal(checks().length, 2);
  const next = await startCheck();
  assert.match(
    (await h.hq(next, 'followthrough')).out,
    /The last check \(\d\d:00 UTC\) recorded no verdict: .*ended \(done\)/,
  );
  await h.hq(next, 'followthrough', 'ok');
  assert.equal(alarm(), null);
});

test('an ended check stops alarming when the last agreement closes', async () => {
  reset();
  const { item } = agreed();
  const t = Date.now();
  followThroughSweep(t);
  const check = await startCheck();
  await h.finish(check);
  followThroughSweep(t + MIN);
  assert.equal(told().length, 1);
  db.prepare("update jobs set status = 'done' where id = ?").run(told()[0].id);
  db.prepare("update call_items set status = 'dropped' where id = ?").run(item);
  followThroughSweep(t + 4 * HOUR);
  assert.equal(alarm(), null);
  assert.equal(told().length, 1);
  assert.equal(db.prepare('select count(*) n from requests').get()!.n, 0);
  assert.equal(checks().length, 1);
  agreed();
  followThroughSweep(t + 5 * HOUR);
  assert.equal(checks().length, 2);
});

test('a check that runs on past its time is stopped, so the next one can start', async () => {
  reset();
  agreed();
  followThroughSweep(Date.now());
  const check = await startCheck();
  followThroughSweep(Date.now() + FINISH_MS);
  assert.match(alarm(), /has run 45 min without a verdict/);
  const heartbeat = await h.heartbeat(check);
  assert.equal(heartbeat.status, 200);
  assert.ok(heartbeat.body.stop);
});

test('an expired check queued by a limit or interruption releases the next hourly check', async () => {
  for (const status of ['limited', 'interrupted'] as const) {
    reset();
    agreed();
    const t = Date.now();
    followThroughSweep(t);
    const check = await startCheck();
    followThroughSweep(t + FINISH_MS + MIN); // recovery must still run after the alarm was raised
    await h.finish(check, { status, resetAt: t + 6 * HOUR });
    followThroughSweep(t + FINISH_MS + 2 * MIN);
    assert.equal(h.job(check.id).status, 'failed');
    assert.match(alarm(), /ended \(failed\) without a verdict/);
    const before = db
      .prepare("select count(*) n from events where type = 'log' and text like '%without a verdict%'")
      .get();
    followThroughSweep(t + FINISH_MS + 3 * MIN);
    assert.deepEqual(
      db.prepare("select count(*) n from events where type = 'log' and text like '%without a verdict%'").get(),
      before,
    );
    followThroughSweep(t + HOUR);
    assert.equal(checks().length, 2);
  }
});

test("the hour's check starts before work whose window passed hours ago", async () => {
  reset();
  agreed();
  const late = h.queue({
    agent: 'bolt',
    engine: 'claude',
    title: 'Due at five',
    thread: h.dueThread({ deadline: Date.now() - 3 * HOUR }),
  });
  followThroughSweep(Date.now());
  assert.equal((await h.claim('claude'))?.id, checks()[0].job);
  assert.equal((await h.claim('claude'))?.id, late);
});

test('below the room line a claim takes the work whose measured memory fits the room, whatever its kind', async () => {
  reset();
  agreed();
  const measured = async (job: Running, mb: number, status: string) => {
    assert.equal((await h.worker('room', { jobs: [{ job: job.id, mb }] })).status, 200);
    await h.finish(job, { status, session: 'its-session' });
  };
  await measured(await h.start({ agent: ceo(), engine: 'claude', title: 'An earlier check' }), 300, 'done');
  const big = await h.start({ agent: 'bolt', engine: 'claude', title: 'A big build' });
  await measured(big, 2400, 'yielded');
  assert.equal(await h.claim('claude', { room: 900 }), null, "the build's own run took more than the room");
  followThroughSweep(Date.now());
  const check = await h.claim('claude', { room: 900 });
  assert.equal(check?.id, checks()[0].job, "the CEO's runs took less");
  assert.equal((await h.claim('claude'))?.id, big.id, 'above the line, it starts');
});
