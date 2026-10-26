// Queue-time estimate contract fixtures.
// node --test src/sorting.test.ts   (HQ's own work from a template waits for its owner's sort: sorting.ts)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness, type Running } from './harness.ts';

const h = await harness('sorting', {
  before: repo =>
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: game, name: The game, owner: wren }\n'),
});
const { db } = h;
const proposals = await import('./proposals.ts');
const projects = await import('./projects.ts');

projects.createThread({
  project: 'game',
  name: 'The first world plays',
  goal: 'The first world can finish',
  slug: 'world',
});
beforeEach(() => db.exec("update jobs set status = 'done' where status != 'done'; delete from messages"));

const say = (from: Running, to: string, text: string) => h.agent('message', from.token, { to, text });
// The open proposal that holds a job, as its owner's inbox lists it
const held = (job: number) =>
  db
    .prepare("select p.* from sorts s join proposals p on p.id = s.proposal where s.job = ? and p.status = 'open'")
    .get(job) as { id: number; title: string; brief: string; project: string | null } | undefined;
const claimable = async (job: number) => (await h.claim(h.job(job).engine))?.id === job;

for (const owner of ['juno', 'wren']) {
  test(`a message-made job holding a deadline thread gives ${owner} a planning job with that deadline`, async () => {
    const { set } = await import('./windows.ts');
    const { orderingSnapshot } = await import('./backlog.ts');
    const deadline = Date.now() + 3_600_000;
    const thread = owner === 'juno' ? h.dueThread({ deadline }) : 'game/world';
    if (owner === 'wren') set(projects.findThread(thread)!, { deadline, aim: deadline }, 'juno');
    const bolt = await h.start({ agent: 'bolt', thread });
    const made = await say(bolt, 'kit', 'Draw the seat answer before the deadline.');
    assert.equal(made.status, 200);
    assert.equal(made.body.state, 'job');
    const item = held(made.body.job)!;
    proposals.sweep();
    const planning = h.jobs
      .listJobs()
      .filter(j => j.agent === owner && j.status === 'queued' && j.id !== made.body.job);
    assert.equal(planning.length, 1, 'the owner need not wait for an hourly summary');
    assert.equal(h.job(planning[0].id).title, 'Sort new proposals into the plan');
    assert.equal(orderingSnapshot(Date.now()).jobs.find(j => j.id === planning[0].id)!.due, deadline);
    proposals.sweep();
    assert.equal(h.jobs.listJobs().filter(j => j.agent === owner && j.status === 'queued').length, 1);
    const code = owner === 'juno' ? 'SEATCEO' : 'SEATOWN';
    assert.deepEqual(proposals.accept(item.id, owner, { title: 'Draw the seat answer', code }), {
      job: made.body.job,
      code,
      thread,
      sorted: true,
    });
    assert.equal(orderingSnapshot(Date.now()).jobs.find(j => j.id === planning[0].id)!.due, null);
  });

  test(`a deadline proposal reaches ${owner}'s running session ahead of its queued planning job`, async () => {
    const { planningJob } = await import('./planning.ts');
    const deadline = Date.now() + 3_600_000;
    const thread = h.dueThread({ deadline });
    if (owner === 'wren') {
      const plan = await import('./plan.ts');
      plan.setOwner('due', owner, { agent: 'juno', job: 0 }, agent => !!h.jobs.findAgent(agent));
    }
    const session = await h.start({ agent: owner, engine: 'claude' });
    const planning = planningJob(owner, 'due');
    const bolt = await h.start({ agent: 'bolt', thread });
    const made = await say(bolt, 'kit', 'Draw the seat answer before the deadline.');
    const item = held(made.body.job)!;
    proposals.sweep();
    const inbox = (await h.agent('inbox', session.token, {})).body;
    assert.equal(inbox.length, 1);
    assert.match(inbox[0].text, new RegExp(`hq inbox ${item.id}`));
    await h.finish(session);
    proposals.sweep();
    const { orderingSnapshot } = await import('./backlog.ts');
    assert.equal(orderingSnapshot(Date.now()).jobs.find(j => j.id === planning)!.due, deadline);
    assert.equal(h.jobs.listJobs().filter(j => j.agent === owner && j.status === 'queued').length, 1);
    if (owner === 'wren') {
      const plan = await import('./plan.ts');
      plan.setOwner('due', 'juno', { agent: 'juno', job: 0 }, agent => !!h.jobs.findAgent(agent));
    }
  });
}

test('an urgent HQ notice redacts unsaved credentials before storage and delivery to the CEO', async () => {
  const sorting = await import('./sorting.ts');
  const session = await h.start({ agent: 'juno', engine: 'claude' });
  const thread = h.dueThread({ deadline: Date.now() + 3_600_000 });
  const title = `Check ${'sk-' + 'noticefixture123'} and NOTICE_TOKEN=unsavedfixture456`;
  const job = h.queue({ agent: 'kit', thread, title });
  sorting.hold(job, { from: 'bolt', project: 'due', why: 'This task needs a place in the plan.' });
  const item = held(job)!;
  assert.equal(item.title, title);
  proposals.sweep();
  const stored = db.prepare('select id, text from messages where job = ? and held = ?').get(session.id, item.id) as {
    id: number;
    text: string;
  };
  const redactedTitle = 'Check [redacted] and NOTICE_TOKEN=[redacted]';
  assert.ok(stored.text.includes(redactedTitle));
  const inbox = (await h.agent('inbox', session.token, {})).body;
  assert.equal(inbox.find((message: { message: number }) => message.message === stored.id)?.text, stored.text);
  await h.finish(session);
});

test("a message no session took waits for its sort by its thread's project owner, who names it and lets it start", async () => {
  const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
  const r = await say(bolt, 'kit', 'The second level needs a door.\nAnd the first one a key.');
  assert.equal(r.body.state, 'job');
  const job = r.body.job as number;
  assert.equal(h.job(job).title, 'Message from bolt: The second level needs a door.', 'a template name to start with');
  const item = held(job)!;
  assert.equal(item.project, 'game');
  assert.match(item.brief, /bolt's message[\s\S]*The second level needs a door/);
  assert.match((await h.hq(bolt, 'jobs', 'kit')).out, /once its project's owner sorts it into the plan/);
  // (bolt's job, the thread's task before it, ends first: in a thread a task starts only after the one before it)
  await h.finish(bolt);
  assert.equal(await claimable(job), false, 'nothing runs before its sort');
  // the owner hears of it at the minute's sweep: its planning job, the one sort step
  proposals.sweep();
  const planning = h.jobs.listJobs().find(j => j.agent === 'wren' && j.status === 'queued')!;
  assert.equal(h.job(planning.id).title, 'Sort new proposals into the plan');
  proposals.sweep();
  assert.equal(h.jobs.listJobs().filter(j => j.agent === 'wren' && j.status === 'queued').length, 1, 'told once');
  // a template keeps no title: the owner writes one
  assert.match(String(proposals.accept(item.id, 'wren', {})), /--title/);
  assert.match(String(proposals.accept(item.id, 'bolt', { title: 'Put doors in' })), /wren's to decide/);
  const sorted = proposals.accept(item.id, 'wren', {
    title: 'Give the second level its door and the first its key',
    code: 'DOORS',
  });
  assert.deepEqual(sorted, { job, code: 'DOORS', thread: 'game/world', sorted: true });
  assert.equal(h.job(job).title, 'Give the second level its door and the first its key');
  assert.equal(await claimable(job), true);
});

test("a message from a job on a windowed thread no pause holds gets its sort and runs while the desk and the CEO's project are paused", async () => {
  const pauses = await import('./pauses.ts');
  const { ceo } = await import('./company.ts');
  const { set } = await import('./windows.ts');
  const { orderingSnapshot } = await import('./backlog.ts');
  const deadline = Date.now() + 3_600_000;
  set(projects.findThread('game/world')!, { deadline, aim: deadline }, ceo());
  const desks = [{ project: 'unsorted' }, { project: h.dueThread().split('/')[0] }];
  for (const target of desks) pauses.pause({ ...target, why: 'Until both trials report', byHand: true }, ceo());
  try {
    const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
    const made = await say(bolt, 'kit', 'The scope is bigger than its size: judge it.');
    const job = made.body.job as number;
    assert.equal(h.job(job).thread, 'game/world', "it takes its sender's thread");
    proposals.sweep();
    const sorter = h.jobs.listJobs().find(j => j.agent === 'wren' && j.status === 'queued')!.id;
    assert.equal(h.jobs.pausedOn(sorter), null, 'the hold lets its owner sort it');
    let play = orderingSnapshot(Date.now()).jobs;
    assert.deepEqual(play.find(j => j.id === job)!.dependencies, [{ job: sorter, until: 'done' }], 'after its sort');
    assert.equal(play.find(j => j.id === sorter)!.due, deadline, "the sort takes the thread's window");
    assert.equal(play.find(j => j.id === job)!.due, deadline);
    // the sort is game's, in a thread of its own there: game's pause holds it, the desk's never
    assert.match(h.job(sorter).thread, /^game\//);
    pauses.pause({ project: 'game', why: 'Wait', byHand: true }, ceo());
    assert.equal(h.jobs.pausedOn(sorter), 'game', "with its project paused, the project's pause holds it");
    pauses.resume({ project: 'game' }, ceo());
    assert.equal(await claimable(sorter), true);
    proposals.accept(held(job)!.id, 'wren', { title: 'Judge the bigger scope', code: 'SCOPE' });
    play = orderingSnapshot(Date.now()).jobs;
    assert.equal(play.find(j => j.id === job)!.dependencies, undefined);
    await h.finish(bolt); // (the task before it in its thread)
    assert.equal(await claimable(job), true);
  } finally {
    for (const target of desks) pauses.resume(target, ceo());
  }
});

test('a later message joining a sorted job that has not started holds it for its sort again', async () => {
  const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
  const job = (await say(bolt, 'kit', 'Draw the door.')).body.job as number;
  const first = held(job)!;
  proposals.accept(first.id, 'wren', { title: 'Draw the door', code: 'DOOR' });
  assert.equal(held(job), undefined);
  const again = await say(bolt, 'kit', 'And a window beside it.');
  assert.equal(again.body.job, job);
  const second = held(job)!;
  assert.notEqual(second.id, first.id);
  assert.match(second.brief, /And a window beside it/);
  await h.finish(bolt); // (the thread's task before it ends first)
  assert.equal(await claimable(job), false);
  proposals.accept(second.id, 'wren', { title: 'Draw the door and the window beside it' });
  assert.equal(h.job(job).code, 'DOOR', 'it keeps the code it was given');
  assert.equal(await claimable(job), true);
});

test("a held job that grows while its owner's planning job left it open is told again", async () => {
  const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
  const job = (await say(bolt, 'kit', 'Paint the gate.')).body.job as number;
  const planning = () => h.jobs.listJobs().filter(j => j.agent === 'wren' && j.status === 'queued');
  proposals.sweep();
  assert.equal(planning().length, 1);
  const first = planning()[0].id,
    run = await h.claim(h.job(first).engine);
  assert.equal(run?.id, first);
  await h.finish(run!);
  assert.equal((await say(bolt, 'kit', 'And the fence beside it.')).body.job, job);
  assert.match(held(job)!.brief, /And the fence beside it/);
  proposals.sweep();
  assert.equal(planning().length, 1, 'its owner hears of the addition');
});

test('a held job split into tasks is dropped, which cancels it', async () => {
  const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
  const job = (await say(bolt, 'kit', 'Fix the door, and redo the menu music.')).body.job as number;
  const owner = await h.start({ agent: 'wren' });
  const dropped = proposals.drop(
    held(job)!.id,
    { agent: 'wren', job: owner.id },
    'split into the door fix and the music',
  );
  assert.deepEqual(dropped, { ok: true, told: false });
  assert.equal(h.job(job).status, 'cancelled');
});

test('a held job that ends before its sort leaves the inbox', async () => {
  const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
  const job = (await say(bolt, 'kit', 'Check the lift.')).body.job as number;
  const item = held(job)!;
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(job);
  proposals.sweep();
  const after = db.prepare('select status, why from proposals where id = ?').get(item.id);
  assert.deepEqual({ ...after }, { status: 'dropped', why: 'its job ended before it was sorted' });
});

test("an ordinary proposal takes the accepter's title when given one", async () => {
  const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
  const made = await h.agent('proposals', bolt.token, { title: 'Doors', brief: 'Doors everywhere.', project: 'game' });
  const accepted = proposals.accept(made.body.id, 'wren', {
    title: 'Doors on every level',
    size: '30m',
    why: 'Add the same door interaction to each level',
    code: 'EVERY',
    thread: 'game/world',
  }) as { job: number };
  assert.equal(h.job(accepted.job).title, 'Doors on every level');
});

// The Front Desk is the CEO's own work alone: HQ's work in no thread is sorted into the project it's for, and only the
// CEO's own may stay.
test("HQ's work in no project is placed in its project's thread before it's sorted, but for the CEO's own", async () => {
  const file = `${h.repo}/company/projects.yaml`;
  writeFileSync(file, `requireThread: true\n${readFileSync(file, 'utf8')}`);
  try {
    const { ceo } = await import('./company.ts');
    const lone = await h.start({ agent: 'bolt' });
    const job = (await say(lone, 'kit', 'The lift is slow.')).body.job as number;
    const item = held(job)!;
    assert.equal(item.project, null, "the CEO's to sort");
    const refused = String(proposals.accept(item.id, ceo(), { title: 'Make the lift quick', code: 'LIFT' }));
    assert.match(refused, /belongs to the project its work is for.*hq job move/s);
    assert.equal(await claimable(job), false);
    const lead = await h.start({ agent: ceo() });
    assert.equal((await h.hq(lead, 'job', 'move', String(job), 'game/world')).code, 0);
    const sorted = proposals.accept(item.id, ceo(), { title: 'Make the lift quick', code: 'LIFT' });
    assert.deepEqual(sorted, { job, code: 'LIFT', thread: 'game/world', sorted: true });
    // A needed answer creates independent CEO work to sort.
    const answer = await h.agent('message', lone.token, {
      to: ceo(),
      text: 'The intercom needs a reply during this run.',
      needsAnswer: true,
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.state, 'job');
    const own = answer.body.job as number;
    const mine = proposals.accept(held(own)!.id, ceo(), { title: 'Answer the intercom', code: 'REPLY' });
    assert.deepEqual(mine, { job: own, code: 'REPLY', thread: null, sorted: true });
  } finally {
    writeFileSync(file, 'projects:\n  - { id: game, name: The game, owner: wren }\n');
  }
});
