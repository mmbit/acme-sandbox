// node --test src/landing.test.ts   (uses a throwaway DATA_DIR): failed jobs replaced through hq job --lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.ts';
import { followthroughFixture } from './followthrough.fixture.ts';
import { recordedDeploy } from './reviewfixture.ts';

const h = await harness('landing', {
  before: repo => {
    // (bolt's: its call's follow-up hands work into the game's threads, which only their owner draws)
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: game, name: The game, owner: bolt }\n');
    // (work only one engine and model do, which a redo carries: engineonly.ts)
    appendFileSync(
      `${repo}/company/org.yaml`,
      '\nengineOnly:\n  - { id: pixels, what: pixel work, engine: claude, model: claude-opus-test, paths: ["pixels/**"] }\n',
    );
  },
});
const { db } = h;
const windows = await import('./windows.ts');
const forecast = await import('./forecast.ts');
const threats = await import('./threats.ts');
const projects = await import('./projects.ts');
const { MIN, HOUR, t0, reset, agreed, handedOut, jobEngine } = await followthroughFixture(h);

// What's late, for the CEO's summary (summary.ts): its threads' lines, those past their windows
const lateLines = (now = Date.now()) => threats.lines(forecast.refresh(now)).filter(l => l.startsWith('deliverable '));

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
  h.cancelJudges(); // (the deliverable's end woke its owner's judge)
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
  assert.match(lines[0], new RegExp(`^deliverable ${thread} \\(`));

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
  const { failed, thread: shop } = await failedPush();
  // (the failure woke the shop key's owner to judge it, a job no pause holds: threadorder.test.ts)
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(projects.findThread(shop)!.judge);
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

// A deliverable of chime's own project: its first task (chime's, or `agent`'s, on the work only one engine does it's
// declared to do) running, a later one drawn before it started
const plan = await import('./plan.ts');
const { ceo } = await import('./company.ts');
async function runningTask(agent = 'chime', only?: string) {
  reset();
  if (!projects.findProject('ads'))
    assert.equal(
      typeof plan.newProject({ id: 'ads', name: 'Ads', owner: 'chime', code: 'AD' }, ceo(), () => true),
      'object',
    );
  const made = projects.createThread({ project: 'ads', name: 'The round', goal: 'The ads run' });
  if (typeof made === 'string') throw new Error(made);
  const first = h.queue({ agent, title: 'Act on the card', thread: made.id, only });
  const later = h.queue({ agent: 'chime', title: 'Read the spend', thread: made.id });
  const act = (await h.claim(h.job(first).engine))!;
  assert.equal(act.id, first);
  return { thread: made.id, act, later };
}
// What holds a queued task in its deliverable's order, in hq jobs' words (threadorder.ts words)
const heldBy = async (id: number) => {
  const threadorder = await import('./threadorder.ts');
  return threadorder.words()(
    db.prepare('select id, kind, pr, thread, branch, status from jobs where id = ?').get(id) as any,
  );
};
// chime's redo, queued from a running job into its task's deliverable (hq job): its number and hq job's answer
const redo = async (by: Running, ...where: string[]) => {
  const queued = await h.hq(by, 'job', '--new', ...where, 'chime', 'Act on the card');
  assert.equal(queued.code, 0, queued.out);
  return { next: Number(/Queued job #(\d+)/.exec(queued.out)![1]), out: queued.out };
};
type Running = NonNullable<Awaited<ReturnType<typeof h.claim>>>;
// Once the stopped run has ended: the later task waits for the redo, which runs
async function redoesIt(act: Running, next: number, later: number) {
  await h.finish(act, { status: 'stopped', result: 'Stopped by chime' });
  assert.deepEqual(await heldBy(later), [`after #${next} in its deliverable`], 'the later task waits for the redo');
  assert.deepEqual(await heldBy(next), []);
  assert.equal((await h.claimJob(next))?.id, next);
}

test('a task that queues its redo and then stops itself: the redo takes its place, the deliverable unheld', async () => {
  const { act, later, thread } = await runningTask();
  const { codeOf } = await import('./jobcodes.ts');
  // (a redo with no code of its own goes on under the task's)
  const next = h.queue({ agent: 'chime', title: 'Act on the card', thread, word: undefined } as any);
  assert.equal(codeOf(next), null);
  const stopped = await h.hq(act, 'stop', String(act.id), 'Started before the card was answered');
  assert.equal(stopped.code, 0, stopped.out);
  assert.match(stopped.out, new RegExp(`#${next} takes its place and does its work again`));
  assert.equal(h.jobs.replacementOf(act.id), next);
  assert.ok(codeOf(act.id));
  assert.equal(codeOf(next), codeOf(act.id));
  assert.deepEqual(await heldBy(next), [`after #${act.id} in its deliverable`], 'behind the run still ending');
  assert.equal(await h.claimJob(next), null);
  await redoesIt(act, next, later);
});

test('a redo queued with no engine rule of its own goes on under the one its stopped task ran under', async () => {
  const { act, later, thread } = await runningTask('chime', 'pixels');
  const next = h.queue({ agent: 'chime', title: 'Act on the card', thread });
  const pin = (id: number) => ({ ...db.prepare('select engine, model, engine_only from jobs where id = ?').get(id) });
  assert.deepEqual(pin(act.id), { engine: 'claude', model: 'claude-opus-test', engine_only: 'pixels' });
  assert.match(String(pin(next).engine), /^engine-/, 'queued on its own engine, with no rule');
  assert.deepEqual([pin(next).model, pin(next).engine_only], [null, null]);
  assert.equal((await h.hq(act, 'stop', String(act.id), 'Started before the card was answered')).code, 0);
  assert.equal(h.jobs.replacementOf(act.id), next);
  assert.deepEqual(pin(next), { engine: 'claude', model: 'claude-opus-test', engine_only: 'pixels' });
  await h.finish(act, { status: 'stopped', result: 'Stopped by chime' });
  assert.deepEqual(await heldBy(later), [`after #${next} in its deliverable`]);
});

test('a task that stops itself and then queues its redo: the redo takes its place as it is queued', async () => {
  const { act, later } = await runningTask();
  const stopped = await h.hq(act, 'stop', String(act.id), 'Wait for the card');
  assert.equal(stopped.code, 0, stopped.out);
  assert.match(stopped.out, /The next job queued there for its agent does its work again and takes its place/);
  const { next, out } = await redo(act);
  assert.match(out, new RegExp(`It takes the place of #${act.id}, chime's task stopped in this deliverable`));
  assert.equal(h.jobs.replacementOf(act.id), next);
  await redoesIt(act, next, later);
});

test('the redo queued after the stopped task ended takes its place too', async () => {
  const { act, later, thread } = await runningTask();
  assert.equal((await h.hq(act, 'stop', String(act.id), 'Wait for the card')).code, 0);
  await h.finish(act, { status: 'stopped', result: 'Stopped by chime' });
  assert.deepEqual(await heldBy(later), [`task #${act.id} before it failed`], 'nothing in its place yet');
  const chime = await h.start({ agent: 'chime', title: 'Sort the round' });
  const { next, out } = await redo(chime, '--deliverable', thread);
  assert.match(out, new RegExp(`It takes the place of #${act.id}`));
  assert.deepEqual(await heldBy(later), [`after #${next} in its deliverable`]);
});

test('with several jobs queued since it started, hq stop names them and --for picks one, once', async () => {
  const { act, later } = await runningTask();
  const one = (await redo(act)).next,
    two = (await redo(act)).next;
  const stopped = await h.hq(act, 'stop', String(act.id), 'Started too early');
  assert.equal(stopped.code, 0, stopped.out);
  assert.match(
    stopped.out,
    new RegExp(
      `If #${one} or #${two}, queued there since it started, does its work again: hq stop ${act.id} "why" --for`,
    ),
  );
  assert.equal(h.jobs.replacementOf(act.id), null);
  await h.finish(act, { status: 'stopped', result: 'Stopped by chime' });
  assert.deepEqual(await heldBy(later), [`task #${act.id} before it failed`]);
  const chime = await h.start({ agent: 'chime', title: 'Sort the round' });
  const placed = await h.hq(chime, 'stop', String(act.id), 'Its redo', '--for', String(two));
  assert.equal(placed.code, 0, placed.out);
  assert.match(placed.out, new RegExp(`#${act.id} had ended already`));
  assert.match(placed.out, new RegExp(`#${two} takes its place`));
  assert.equal(h.jobs.replacementOf(act.id), two);
  assert.deepEqual(await heldBy(later), [`after #${two} in its deliverable`]);
  const again = await h.hq(chime, 'stop', String(act.id), 'Again', '--for', String(one));
  assert.match(again.out, new RegExp(`#${two} has taken over #${act.id}'s work already`));
});

test("--for names the agent's own unstarted work in the deliverable, placed by the project's owner or the CEO", async () => {
  const { act, thread } = await runningTask('kit');
  const theirs = h.queue({ agent: 'kit', title: 'Its redo', thread, queuedBy: 'chime' }),
    other = h.queue({ agent: 'chime', title: 'Not kit', thread }),
    elsewhere = h.queue({ agent: 'kit', title: 'Elsewhere' });
  const kit = await h.start({ agent: 'kit', title: 'Sort it' });
  for (const replacement of [other, elsewhere, act.id, theirs]) {
    const r = await h.hq(kit, 'stop', String(act.id), 'Its redo', '--for', String(replacement));
    assert.notEqual(r.code, 0, `${replacement}: ${r.out}`);
  }
  assert.match(
    (await h.hq(kit, 'stop', String(act.id), 'Its redo', '--for', String(theirs))).out,
    /drawn by its owner/,
    "chime's plan: kit doesn't reorder it",
  );
  assert.equal((await h.heartbeat(act)).body.stop, undefined, 'the refusal undoes the stop with it');
  assert.equal(h.jobs.replacementOf(act.id), null);
  const chief = await h.start({ agent: ceo(), title: 'Follow through' });
  const placed = await h.hq(chief, 'stop', String(act.id), 'Its redo', '--for', String(theirs));
  assert.equal(placed.code, 0, placed.out);
  assert.match((await h.heartbeat(act)).body.stop, /Its redo/);
  assert.equal(h.jobs.replacementOf(act.id), theirs);
});

// An urgent continuation starts within minutes, before anyone could put it in the stopped task's place
test("a continuation already under way takes the stopped task's place; its brief and engine stay as they ran", async () => {
  const { act, later, thread } = await runningTask('chime', 'pixels');
  const earlier = h.queue({ agent: 'chime', title: 'Done before it started', thread });
  db.prepare("update jobs set status = 'done', created = '2000-01-01', started = '2000-01-01' where id = ?").run(
    earlier,
  );
  const going = h.queue({ agent: 'chime', title: 'Act on the card, finished tonight', thread });
  db.prepare("update jobs set status = 'running', started = ? where id = ?").run(new Date().toISOString(), going);
  const brief = () => db.prepare('select prompt, engine, model, engine_only from jobs where id = ?').get(going);
  const was = { ...brief() };
  const stopped = await h.hq(act, 'stop', String(act.id), 'Its continuation is under way');
  assert.equal(stopped.code, 0, stopped.out);
  assert.match(stopped.out, new RegExp(`#${going} takes its place`));
  assert.equal(h.jobs.replacementOf(act.id), going);
  assert.deepEqual({ ...brief() }, was, 'it read its brief already');
  await h.finish(act, { status: 'stopped', result: 'Stopped by chime' });
  assert.deepEqual(await heldBy(later), [`after #${going} in its deliverable`]);
  // done already, after the stop ended: --for, never work from before the stopped task started
  const next = await runningTask();
  assert.equal((await h.hq(next.act, 'stop', String(next.act.id), 'Wait')).code, 0);
  await h.finish(next.act, { status: 'stopped', result: 'Stopped by chime' });
  const old = h.queue({ agent: 'chime', title: 'Before it', thread: next.thread }),
    done = h.queue({ agent: 'chime', title: 'Its continuation', thread: next.thread });
  db.prepare("update jobs set status = 'done', created = '2000-01-01', started = '2000-01-01' where id = ?").run(old);
  db.prepare("update jobs set status = 'done', started = ?, finished = ? where id = ?").run(
    new Date().toISOString(),
    new Date().toISOString(),
    done,
  );
  const chime = await h.start({ agent: 'chime', title: 'Sort the round' });
  const refused = await h.hq(chime, 'stop', String(next.act.id), 'Its redo', '--for', String(old));
  assert.notEqual(refused.code, 0, refused.out);
  assert.equal(h.jobs.replacementOf(next.act.id), null);
  const placed = await h.hq(chime, 'stop', String(next.act.id), 'Its redo', '--for', String(done));
  assert.equal(placed.code, 0, placed.out);
  assert.equal(h.jobs.replacementOf(next.act.id), done);
  assert.deepEqual(await heldBy(next.later), [], 'the stopped task holds it no longer');
});

test("the CEO gives a card's wait to a job of the agent who filed it; nobody else's", async () => {
  const { act } = await runningTask();
  const card = await h.ask(act);
  const chief = await h.start({ agent: ceo(), title: 'Follow through' }),
    kit = await h.start({ agent: 'kit', title: 'Not theirs' });
  const waits = await h.agent('job', chief.token, {
    agent: 'chime',
    title: 'After the card',
    prompt: 'x',
    afterRequest: card,
  });
  assert.equal(waits.status, 200, JSON.stringify(waits.body));
  assert.equal(await h.claimJob(waits.body.id), null, 'it waits for the card');
  assert.equal(
    (await h.agent('job', chief.token, { agent: 'kit', title: 'Not the filer', prompt: 'x', afterRequest: card }))
      .status,
    409,
  );
  const plain = h.queue({ agent: 'chime', title: 'Its redo', queuedBy: 'chime' });
  assert.equal((await h.agent('waits', kit.token, { id: plain, request: card })).status, 409);
  assert.equal(
    (await h.agent('waits', chief.token, { id: plain, request: card, why: 'Its redo waits too' })).status,
    200,
  );
  assert.equal(await h.claimJob(plain), null, 'it waits for the card too');
});

// A deliverable's task whose push GitHub refused, its commits left only on the mirror's refs/outgoing/job/<n>, with
// kit's work queued after it and on its deploy. `then` runs with the ref there, which goes after.
async function refusedPush(then: (f: { thread: string; task: number; after: number; live: number }) => Promise<void>) {
  reset();
  db.exec('delete from wakes'); // (kept by the fixture's reset, and job numbers start again)
  const wakes = await import('./wakes.ts');
  const made = projects.createThread({ project: 'game', name: 'The log span', goal: 'Logs read a past hour' });
  if (typeof made === 'string') throw new Error(made);
  const task = await h.start({ agent: 'chime', title: 'Read a past hour', thread: made.id, queuedBy: 'bolt' });
  const after = h.queue({ agent: 'kit', title: 'Build on it', after: task.id, queuedBy: 'bolt' });
  const live = h.queue({ agent: 'kit', title: 'Read it live', queuedBy: 'bolt' });
  wakes.hold(live, [{ kind: 'deployed', arg: String(task.id) }]);
  const ref = `refs/outgoing/job/${task.id}`;
  mirror('update-ref', ref, commit());
  try {
    await h.finish(task, {
      status: 'failed',
      branch: `job/${task.id}`,
      result: 'Done.\n\nThe run ended with an error: the push failed: refusing to allow a token to update a workflow',
    });
    await then({ thread: made.id, task: task.id, after, live });
  } finally {
    mirror('update-ref', '-d', ref);
  }
}
// Whether a queued job would start now, after the check every claim makes, and what its wake met
const startsNow = async (id: number) => {
  (await import('./wakes.ts')).check();
  return !!h.job(id).ready;
};
const metOf = (id: number) => (db.prepare('select met from wakes where job = ?').get(id) as { met: string | null }).met;

test("a failed push's saved work: HQ lands it, and the work after it and on its deploy waits for that landing", () =>
  refusedPush(async ({ thread, task, after, live }) => {
    const landing = h.jobs.replacementOf(task)!;
    assert.ok(landing, 'HQ queued its landing');
    const row = db.prepare('select agent, thread, step, prompt from jobs where id = ?').get(landing) as {
      agent: string;
      thread: string;
      step: string;
      prompt: string;
    };
    assert.deepEqual([row.agent, row.thread, row.step], ['chime', thread, 'Landing saved work']);
    assert.match(row.prompt, new RegExp(`git fetch origin refs/outgoing/job/${task}\``));
    assert.match(row.prompt, /refusing to allow a token to update a workflow/);
    assert.equal(projects.findThread(thread)!.judge, null, "no judge: the deliverable's work isn't in");
    assert.equal(h.job(after).after, landing, 'the work after it waits for the landing');
    assert.equal(await startsNow(after), false);
    assert.equal(await startsNow(live), false);
    assert.equal(metOf(live), null, 'its deploy is still to come');
    assert.equal(
      db.prepare("select count(*) n from jobs where title like 'Job #% ended without merged work%'").get()!.n,
      0,
    );

    const run = await h.claimJob(landing);
    await h.finish(run, { status: 'done', pr: 71, branch: `job/${landing}` });
    const merged = Date.now();
    h.mergedPr(71, merged);
    assert.equal(await startsNow(after), true, 'the landing merged: the work after it starts');
    assert.equal(await startsNow(live), false, 'not deployed yet');
    await recordedDeploy(h.dataDir, {
      fetched: merged + 1_000,
      finished: merged + 2_000,
      sha: 'e'.repeat(40),
      ok: true,
      services: [],
    });
    assert.equal(await startsNow(live), true);
    assert.match(metOf(live)!, new RegExp(`^#${task}'s work \\(pull request #71, merged .*\\) is deployed`));
  }));

test("HQ lands a failed push's work once: its landing failing the same way is left to its owner, not judged as in", () =>
  refusedPush(async ({ thread, task, after, live }) => {
    const landing = h.jobs.replacementOf(task)!;
    const run = await h.claimJob(landing);
    const ref = `refs/outgoing/job/${landing}`;
    mirror('update-ref', ref, commit());
    try {
      await h.finish(run, { status: 'failed', branch: `job/${landing}`, result: 'the push failed: refused again' });
    } finally {
      mirror('update-ref', '-d', ref);
    }
    assert.equal(h.jobs.replacementOf(landing), null, 'no second landing');
    assert.equal(projects.findThread(thread)!.judge, null, 'no judge while its work sits off its branch');
    assert.equal(await startsNow(live), true, 'nothing of it can land now');
    assert.match(
      metOf(live)!,
      new RegExp(`^#${task}'s work will never deploy: #${landing} ended \\(failed\\) without a pull request`),
    );
    assert.equal(await startsNow(after), true, 'the work after it hears of the failure');
    const { note } = db.prepare('select note from jobs where id = ?').get(after) as { note: string };
    assert.match(note, new RegExp(`Job #${landing} .*which this job waited for, failed`));
  }));

test("work queued after a failed push once its landing exists waits for the landing, and the landing's cancel wakes no judge", () =>
  refusedPush(async ({ thread, task }) => {
    const landing = h.jobs.replacementOf(task)!;
    const later = h.queue({ agent: 'kit', title: 'Check it', after: task, queuedBy: 'bolt' });
    assert.equal(h.job(later).after, landing, 'it waits for the job doing the work now');
    assert.equal(await startsNow(later), false);
    const held = h.queue({ agent: 'kit', title: 'Check it too', queuedBy: 'bolt' });
    assert.deepEqual(h.jobs.addWait(held, task, 'bolt'), { ok: true }, 'hq waits add on the failed task is taken');
    const wait = db.prepare('select on_job from waits where job = ?').get(held) as { on_job: number };
    assert.equal(wait.on_job, landing, 'it waits for the landing');
    const { cancelJob } = await import('./ledger.ts');
    cancelJob(landing, 'Not now');
    assert.equal(h.job(later).after, task, 'the cancel hands the wait back');
    assert.equal(projects.findThread(thread)!.judge, null, 'no judge while its work sits off its branch');
  }));

test("a failed task's pushed work holds what waits on it while its deliverable is open, until a landing or the close", async () => {
  reset();
  db.exec('delete from wakes'); // (as refusedPush)
  const wakes = await import('./wakes.ts');
  const made = projects.createThread({ project: 'game', name: 'The shop sign', goal: 'The sign reads' });
  if (typeof made === 'string') throw new Error(made);
  const task = await h.start({ agent: 'chime', title: 'Paint the sign', thread: made.id, queuedBy: 'bolt' });
  const after = h.queue({ agent: 'kit', title: 'Hang it', after: task.id, queuedBy: 'bolt' });
  const live = h.queue({ agent: 'kit', title: 'Read it live', queuedBy: 'bolt' });
  wakes.hold(live, [{ kind: 'deployed', arg: String(task.id) }]);
  await h.finish(task, { status: 'failed', branch: `job/${task.id}`, sha: 'a'.repeat(40), result: 'It crashed' });
  assert.equal(h.jobs.replacementOf(task.id), null);
  assert.equal(await startsNow(after), false, 'its work is on its branch, to land');
  assert.equal(await startsNow(live), false);
  db.prepare("update threads set status = 'done' where id = ?").run(made.id);
  assert.equal(await startsNow(after), true, 'its deliverable closed without it');
  assert.equal(await startsNow(live), true);
  assert.match(metOf(live)!, new RegExp(`will never deploy: #${task.id} ended \\(failed\\) without a pull request`));
});

test("a mirror that can't be read stops a failed push's run end, rather than reading as nothing saved", async () => {
  reset();
  const made = projects.createThread({ project: 'game', name: 'The shop bell', goal: 'The bell rings' });
  if (typeof made === 'string') throw new Error(made);
  const task = await h.start({ agent: 'chime', title: 'Hang the bell', thread: made.id, queuedBy: 'bolt' });
  const ref = `refs/outgoing/job/${task.id}`,
    dir = process.env.WORK_MIRROR_DIR!;
  mirror('update-ref', ref, commit());
  const end = { status: 'failed', branch: `job/${task.id}`, result: 'the push failed: refused' };
  try {
    renameSync(dir, `${dir}.away`);
    try {
      assert.equal((await h.finish(task, end)).status, 500);
    } finally {
      renameSync(`${dir}.away`, dir);
    }
    assert.equal(h.job(task.id).status, 'running', 'its end is not recorded: the worker sends it again');
    assert.equal((await h.finish(task, end)).status, 200);
    assert.ok(h.jobs.replacementOf(task.id), 'read again, its saved work is landed');
  } finally {
    mirror('update-ref', '-d', ref);
  }
});
