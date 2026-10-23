// node --test src/landing.test.ts   (uses a throwaway DATA_DIR): hq job --lands, a job landing the saved work of one that
// failed before it opened a pull request, which replaces it (takeover.ts landing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { followthroughFixture } from './followthrough.fixture.ts';

const h = await harness('landing', {
  before: repo =>
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: game, name: The game, owner: wren }\n'),
});
const { db } = h;
const windows = await import('./windows.ts');
const forecast = await import('./forecast.ts');
const threats = await import('./threats.ts');
const projects = await import('./projects.ts');
const { MIN, HOUR, t0, reset, agreed, handedOut, jobEngine } = await followthroughFixture(h);

// What's late, for the CEO's summary (summary.ts): its threads' lines, those past their windows
const lateLines = (now = Date.now()) => threats.lines(forecast.refresh(now)).filter(l => l.startsWith('thread '));

// bolt's call's follow-up hands chime the item with a deadline, which goes on their thread; chime's job fails before it
// opens a pull request (a push GitHub refused), its commits left on the mirror's refs/outgoing/job/<n>, with the
// thread's deadline past
async function failedPush() {
  reset();
  // (its time, given on the call)
  const made = projects.createThread({ project: 'game', name: 'The shop key', goal: 'It works' });
  if (typeof made === 'string') throw new Error(made);
  const thread = made.id;
  const { call, item, followUp, handed, wire } = await handedOut(
    { kind: 'task', what: 'Wire the shop key', due: Date.now() + HOUR },
    thread,
  );
  assert.equal(handed.thread, thread);
  assert.ok(handed.deadline, "the time is the thread's deadline");
  const late = Date.now() - 30 * MIN;
  assert.deepEqual(windows.set(projects.findThread(thread)!, { deadline: late, aim: late }, 'bolt'), {
    thread,
    deadline: new Date(late).toISOString(),
    aim: new Date(late).toISOString(),
  });
  await h.finish(wire, { status: 'failed', result: `GitHub refused the push to job/${wire.id}` });
  return { call, item, thread, failed: wire.id, followUp };
}
// A running job's hq job --lands, for chime unless the body says otherwise
const lands = (by: { token: string }, failed: number, o: Record<string, unknown> = {}) =>
  h.agent('job', by.token, {
    agent: 'chime',
    title: `Land #${failed}'s work`,
    prompt: 'Land it',
    lands: failed,
    ...o,
  });

test("hq job --lands: only the failed job's own agent's, by someone responsible for it, and once", async () => {
  const { failed, followUp } = await failedPush();
  const chime = await h.start({ agent: 'chime', title: 'Something else' }),
    kit = await h.start({ agent: 'kit', title: 'x' });
  const own = agreed({ kind: 'task', what: 'Check the shop' }, t0, 'chime');
  db.prepare('update calls set job = ? where id = ?').run(chime.id, own.call);
  // not its own agent's, nobody's responsible for it, an item besides, a job that didn't fail: nothing is queued
  for (const [by, o] of [
    [chime, { agent: 'lark' }],
    [kit, {}],
    [chime, { item: own.item }],
    [chime, { lands: followUp }],
  ] as const)
    assert.equal((await lands(by, failed, o)).status, 409);
  assert.equal(db.prepare('select count(*) n from jobs where instead_of is not null').get()!.n, 0);
  assert.equal((await lands(chime, failed)).status, 200);
  const again = await lands(chime, failed);
  assert.equal(again.status, 409);
  assert.equal(db.prepare('select count(*) n from jobs where instead_of = ?').get(failed)!.n, 1);
});

test("hq job --lands: the landing job takes over the failed job's item and thread, and its deadline's late line follows it", async () => {
  const { call, item, thread, failed } = await failedPush();
  assert.deepEqual(lateLines(), [], 'a failed job is no open work: the summary lists it as failed');

  const chime = await h.start({ agent: 'chime', title: 'Something else' });
  const landing = await lands(chime, failed);
  assert.equal(landing.status, 200, JSON.stringify(landing.body));
  const row = db
    .prepare('select instead_of, call, item, thread, prompt from jobs where id = ?')
    .get(landing.body.id) as {
    instead_of: number;
    call: number;
    item: number;
    thread: string;
    prompt: string;
  };
  assert.deepEqual([row.instead_of, row.call, row.item, row.thread], [failed, call, item, thread]);
  assert.match(row.prompt, new RegExp(`git fetch origin refs/outgoing/job/${failed}\``));
  const lines = lateLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^thread ${thread} \\(`));

  // done and merged, the item is handled and the clock stops
  await h.finish(chime);
  const run = (await h.claim(jobEngine(landing.body.id)))!;
  assert.equal(run.id, landing.body.id);
  await h.finish(run, { status: 'done', pr: 63, branch: `job/${run.id}` });
  const handled = db.prepare('select status from call_items where id = ?').get(item) as { status: string };
  assert.equal(handled.status, 'handled');
  db.prepare("update prs set status = 'merged' where number = 63").run();
  assert.deepEqual(lateLines(Date.now() + 2 * HOUR), []);
});

test('hq job --lands takes no failed job that opened a pull request: its work goes on there', async () => {
  reset();
  const fix = await h.start({ agent: 'chime', title: 'The shop' }),
    chime = await h.start({ agent: 'chime', title: 'x' });
  await h.finish(fix, { status: 'done', pr: 64, branch: `job/${fix.id}` });
  db.prepare("update jobs set status = 'failed' where id = ?").run(fix.id);
  const r = await lands(chime, fix.id);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /opened pull request #64/);
});

for (const status of ['dropped', 'replaced']) {
  test(`hq job --lands refuses ${status} items without queuing a replacement`, async () => {
    const { item, failed } = await failedPush();
    const chime = await h.start({ agent: 'chime', title: 'Something else' });
    db.prepare('update call_items set status = ? where id = ?').run(status, item);
    const reply = await lands(chime, failed);
    assert.equal(reply.status, 409);
    assert.equal(db.prepare('select count(*) n from jobs where instead_of = ?').get(failed)!.n, 0);
  });
}

test("hq job --lands keeps the failed job's paused project until it resumes", async () => {
  const { failed } = await failedPush();
  const thread = projects.createThread({ project: 'game', name: 'Levels', goal: 'Levels work' });
  assert.equal(typeof thread, 'object');
  if (typeof thread === 'string') throw new Error(thread);
  db.prepare('update jobs set thread = ? where id = ?').run(thread.id, failed);
  const chime = await h.start({ agent: 'chime', title: 'Something else' });
  const { ceo } = await import('./company.ts');
  const chief = await h.start({ agent: ceo(), title: 'Pause the game' });
  assert.equal((await h.agent('pauses', chief.token, { project: 'game', why: 'Wait for the board' })).status, 200);
  const reply = await lands(chime, failed);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  await h.finish(chime);
  assert.equal((await h.claim(jobEngine(reply.body.id)))?.id, undefined, 'the project pause holds the landing job');
  assert.equal(reply.body.thread, thread.id);
  assert.equal(reply.body.paused.target, 'game');
  assert.equal((await h.agent('pauses/resume', chief.token, { project: 'game' })).status, 200);
  assert.equal((await h.claim(jobEngine(reply.body.id)))?.id, reply.body.id);
});
