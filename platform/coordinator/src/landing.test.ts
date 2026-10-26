// node --test src/landing.test.ts   (uses a throwaway DATA_DIR): failed jobs replaced through hq job --lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.ts';
import { followthroughFixture } from './followthrough.fixture.ts';

const h = await harness('landing', {
  before: repo => {
    // (bolt's: its call's follow-up hands work into the game's threads, which only their owner draws)
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: game, name: The game, owner: bolt }\n');
    process.env.WORK_MIRROR_DIR = `${repo}/mirror.git`;
    execFileSync('git', ['init', '--bare', '-q', process.env.WORK_MIRROR_DIR]);
  },
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
  // (by bolt, who queued it and owns its thread: a task goes into a thread by its owner's hq job)
  const bolt = await h.start({ agent: 'bolt', title: 'y' });
  assert.equal((await lands(bolt, failed)).status, 200);
  const again = await lands(bolt, failed);
  assert.equal(again.status, 409);
  assert.equal(db.prepare('select count(*) n from jobs where instead_of = ?').get(failed)!.n, 1);
});

test("hq job --lands: the landing job takes over the failed job's item and thread, and its deadline's late line follows it", async () => {
  const { call, item, thread, failed } = await failedPush();
  assert.deepEqual(lateLines(), [], 'a failed job is no open work: the summary lists it as failed');

  // (by bolt, who queued it and owns its thread)
  const bolt = await h.start({ agent: 'bolt', title: 'Something else' });
  const landing = await lands(bolt, failed);
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
  await h.finish(bolt);
  const run = (await h.claim(jobEngine(landing.body.id)))!;
  assert.equal(run.id, landing.body.id);
  await h.finish(run, { status: 'done', pr: 63, branch: `job/${run.id}` });
  const ready = db.prepare('select status from call_items where id = ?').get(item) as { status: string };
  assert.equal(ready.status, 'ready', "the landing job's end: ready for the board's yes");
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
  assert.match(r.body.error, /pull request #64/);
});

const mirror = (...args: string[]) =>
  execFileSync('git', ['--git-dir', process.env.WORK_MIRROR_DIR!, ...args], { encoding: 'utf8' }).trim();
const commit = (parent?: string, at?: string) => {
  const tree = mirror('mktree');
  return execFileSync(
    'git',
    ['--git-dir', process.env.WORK_MIRROR_DIR!, 'commit-tree', tree, ...(parent ? ['-p', parent] : [])],
    {
      input: 'Thread work\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Chime',
        GIT_AUTHOR_EMAIL: 'chime@example.invalid',
        GIT_COMMITTER_NAME: 'Chime',
        GIT_COMMITTER_EMAIL: 'chime@example.invalid',
        ...(at && { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }),
      },
    },
  ).trim();
};

async function failedThreadTask(saved: 'nothing' | 'later' | 'pushed' | 'outgoing') {
  reset();
  const made = projects.createThread({ project: 'game', name: 'The shop', goal: 'The shop works' });
  if (typeof made === 'string') throw new Error(made);
  const first = await h.start({ agent: 'chime', title: 'Build the shop', thread: made.id });
  const branch = `job/${first.id}`,
    head = commit();
  mirror('update-ref', `refs/heads/${branch}`, head);
  mirror('update-ref', `refs/outgoing/${branch}`, head);
  await h.finish(first, { pr: 65, branch, sha: head, files: ['platform/shop.ts'] });
  h.cancelQueued();
  const { call, item, wire } = await handedOut({ kind: 'task', what: 'Fix the care route' }, made.id);
  const original = db.prepare('select prompt from jobs where id = ?').get(wire.id) as { prompt: string };
  const later = h.queue({ agent: 'chime', title: 'Check the shop', thread: made.id });
  if (saved === 'pushed' || saved === 'outgoing') {
    const own = commit(head);
    const ref = saved === 'pushed' ? `refs/heads/${branch}` : `refs/outgoing/${branch}`;
    mirror('update-ref', ref, own);
  }
  await h.finish(wire, { status: 'failed', branch });
  if (saved === 'later') {
    const next = commit(head, new Date(Date.now() + MIN).toISOString());
    mirror('update-ref', `refs/heads/${branch}`, next);
    mirror('update-ref', `refs/outgoing/${branch}`, next);
  }
  const owner = await h.start({ agent: 'bolt', title: 'Recover the failed task' });
  return { failed: wire.id, original, later, owner, branch, call, item, thread: made.id };
}

test('hq job --lands restores an empty failed task on an open thread PR with its own brief and place', async () => {
  const { failed, original, later, owner, branch, call, item, thread } = await failedThreadTask('nothing');
  const reply = await h.hq(owner, 'job', '--new', '--lands', String(failed), 'chime', 'Finish the care fix');
  assert.equal(reply.code, 0, reply.out);
  const replacement = h.jobs.replacementOf(failed)!;
  assert.ok(replacement);
  const queued = { ...h.job(replacement), ...db.prepare('select prompt from jobs where id = ?').get(replacement) };
  assert.equal(queued.thread, thread);
  assert.equal(queued.call, call);
  assert.equal(queued.item, item);
  const { codeOf } = await import('./jobcodes.ts');
  assert.equal(codeOf(replacement), codeOf(failed));
  assert.ok(queued.prompt.startsWith(original.prompt), 'the failed task supplies its whole stored brief');
  assert.doesNotMatch(queued.prompt, /git fetch origin refs\/outgoing/);
  const threadorder = await import('./threadorder.ts');
  const order = threadorder.tasksOf(thread).map(task => task.id);
  assert.equal(order.includes(failed), false);
  assert.ok(order.indexOf(replacement) < order.indexOf(later));
  const run = await h.claimJob(replacement);
  assert.equal(run?.id, replacement);
  assert.equal(run?.branch, branch);
  assert.equal((await lands(owner, failed)).status, 409);
});

test('hq job --lands can restore an empty failed task after later work reached the thread branch', async () => {
  const { failed, owner } = await failedThreadTask('later');
  const reply = await lands(owner, failed, { prompt: undefined });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(h.jobs.replacementOf(failed), reply.body.id);
});

for (const saved of ['pushed', 'outgoing'] as const) {
  test(`hq job --lands refuses a failed thread task with its own ${saved} work`, async () => {
    const { failed, owner } = await failedThreadTask(saved);
    assert.equal((await lands(owner, failed)).status, 409);
    assert.equal(h.jobs.replacementOf(failed), null);
  });
}

test("hq job --lands stops when the mirror can't show a failed thread task's work", async () => {
  const { failed, owner, branch } = await failedThreadTask('nothing');
  for (const ref of [`refs/heads/${branch}`, `refs/outgoing/${branch}`]) mirror('update-ref', '-d', ref);
  const reply = await lands(owner, failed);
  assert.equal(reply.status, 500, JSON.stringify(reply.body));
  assert.equal(h.jobs.replacementOf(failed), null);
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
  const bolt = await h.start({ agent: 'bolt', title: 'Something else' }); // (who queued it and owns its thread)
  const { ceo } = await import('./company.ts');
  const chief = await h.start({ agent: ceo(), title: 'Pause the game' });
  assert.equal(
    (await h.agent('pauses', chief.token, { project: 'game', why: 'Wait for the board', byHand: true })).status,
    200,
  );
  const reply = await lands(bolt, failed);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  await h.finish(bolt);
  assert.equal((await h.claim(jobEngine(reply.body.id)))?.id, undefined, 'the project pause holds the landing job');
  assert.equal(reply.body.thread, thread.id);
  assert.equal(reply.body.paused.target, 'game');
  assert.equal((await h.agent('pauses/resume', chief.token, { project: 'game' })).status, 200);
  assert.equal((await h.claim(jobEngine(reply.body.id)))?.id, reply.body.id);
});

test('a stopped carrier stays open with its owner and stop reason, opens no PR, and can be landed', async () => {
  reset();
  const made = projects.createThread({ project: 'game', name: 'The stopped key', goal: 'The key works' });
  if (typeof made === 'string') throw new Error(made);
  const { item, wire } = await handedOut({ kind: 'task', what: 'Wire the shop key' }, made.id);
  const chief = await h.start({ agent: 'juno', title: 'Stop the work' });
  const why = 'Wait for the board to judge the trial';
  assert.equal((await h.hq(chief, 'stop', String(wire.id), why)).code, 0);
  assert.equal((await h.heartbeat(wire)).body.stop, `juno: ${why}`);
  await h.finish(wire, { status: 'stopped', branch: `job/${wire.id}`, result: `Stopped by juno: ${why}` });
  assert.equal(h.job(wire.id).status, 'stopped');
  assert.equal(db.prepare('select count(*) n from prs').get()!.n, 0);
  const open = await h.agent('items', chief.token);
  const returned = open.body.find((i: { id: number }) => i.id === item);
  assert.ok(returned, 'the item is still in the open list');
  assert.equal(returned.owner, 'juno');
  assert.equal(returned.why, undefined);
  assert.equal(returned.stopped, wire.id);
  const summary = await h.agent('summary', chief.token);
  assert.match(summary.body.text, new RegExp(`returned by stopped job #${wire.id}`));
  assert.ok(!summary.body.text.includes(why));
  assert.deepEqual((await h.worker('ended', { ids: [wire.id, chief.id] })).body, [{ id: wire.id, kind: 'work' }]);
  const owner = await h.start({ agent: 'bolt', title: 'Land the saved work' });
  const landing = await lands(owner, wire.id);
  assert.equal(landing.status, 200, JSON.stringify(landing.body));
  assert.equal(db.prepare('select instead_of from jobs where id = ?').get(landing.body.id)!.instead_of, wire.id);
  await h.finish(wire, { status: 'done', pr: 888, branch: `job/${wire.id}` });
  assert.equal(h.job(wire.id).status, 'stopped', 'a repeated finish cannot mark stopped work done');
  assert.equal(db.prepare('select count(*) n from prs').get()!.n, 0);
  await h.finish(owner);
  const run = await h.claim(jobEngine(landing.body.id));
  assert.equal(run?.id, landing.body.id, 'the stopped task yields its place to its landing job');
  await h.finish(run!, { status: 'done', pr: 889, branch: `job/${run!.id}` });
  assert.equal(db.prepare('select status from call_items where id = ?').get(item)!.status, 'ready');
});

for (const status of ['handled', 'ready'])
  test(`stopping a carrier returns an already ${status} ancestor item to its owner`, async () => {
    reset();
    const lead = await h.start({ agent: 'bolt', title: 'Lead the build' });
    const { item } = agreed({
      kind: 'promise',
      status: status === 'ready' ? 'open' : status,
      job: lead.id,
      what: 'Build the key',
    });
    await h.finish(lead);
    const run = await h.start({ agent: 'chime', item, title: 'Build the key' });
    assert.equal((await h.hq(run, 'stop', String(run.id), 'The trial needs a judgment')).code, 0);
    await h.finish(run, { status: 'stopped' });
    const returned = db
      .prepare('select owner, status, why, closed_at, ready_at from call_items where id = ?')
      .get(item)!;
    assert.equal(returned.status, 'open');
    assert.equal(returned.owner, 'juno');
    assert.equal(returned.closed_at, null);
    assert.equal(returned.ready_at, null);
    assert.equal(returned.why, 'stopped: chime: The trial needs a judgment');
  });
