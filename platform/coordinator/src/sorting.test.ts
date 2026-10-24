// Queue-time estimate contract fixtures.
// node --test src/sorting.test.ts   (HQ's own work from a template waits for its owner's sort: sorting.ts)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
beforeEach(() => db.exec("update jobs set status = 'done' where status != 'done'"));

const say = (from: Running, to: string, text: string) => h.agent('message', from.token, { to, text });
// The open proposal that holds a job, as its owner's inbox lists it
const held = (job: number) =>
  db
    .prepare("select p.* from sorts s join proposals p on p.id = s.proposal where s.job = ? and p.status = 'open'")
    .get(job) as { id: number; title: string; brief: string; project: string | null } | undefined;
const claimable = async (job: number) => (await h.claim(h.job(job).engine))?.id === job;

test("a message no session took waits for its sort by its thread's project owner, who names it and lets it start", async () => {
  const bolt = await h.start({ agent: 'bolt', thread: 'game/world' });
  const r = await say(bolt, 'kit', 'The second level needs a door.\nAnd the first one a key.');
  assert.equal(r.body.state, 'job');
  const job = r.body.job as number;
  assert.equal(h.job(job).title, 'Message from bolt: The second level needs a door.', 'a template name to start with');
  const item = held(job)!;
  assert.equal(item.project, 'game');
  assert.match(item.brief, /bolt's message[\s\S]*The second level needs a door/);
  assert.equal(await claimable(job), false, 'nothing runs before its sort');
  assert.match((await h.hq(bolt, 'jobs', 'kit')).out, /once its project's owner sorts it into the plan/);
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
