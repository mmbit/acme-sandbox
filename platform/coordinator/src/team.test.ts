// node --test src/team.test.ts   (the test company's org)
// A team member shows in HQ only while its lead's run is really going: a run that ends without the worker's word (a
// failed job, a restart that cut it, a session resumed later) leaves no one behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Running } from './harness.ts';

const h = await harness('team');
// a slot asking for work it won't find: the coordinator's sweeps run before any claim
const anotherClaim = () => h.claim('nothing-here');
const start = (job: Running, id: string, name = id) =>
  h.worker('team', { job: job.id, lead: 'wren', id, name, parent: 'wren', state: 'working', task: 'Sketching' });
// whom HQ shows in Studio (Wren's department) besides its staff, with their state
const shown = async () =>
  Object.fromEntries(
    ((await h.board('/api/org')).body.departments.find((d: { id: string }) => d.id === 'studio').agents as any[])
      .filter(a => a.temp)
      .map(a => [a.id, `${a.name} ${a.status.state}`]),
  );

test('a member shows while its lead runs, capitalised, and idle once its work came back', async () => {
  const job = await h.start({ agent: 'wren', title: 'Venture cycle' });
  await start(job, 'clove');
  await start(job, 'marzipan', 'marzipan');
  assert.deepEqual(await shown(), { clove: 'Clove working', marzipan: 'Marzipan working' });
  await h.worker('team', { job: job.id, lead: 'wren', id: 'clove', name: 'clove', state: 'idle', task: 'Done' });
  assert.deepEqual(
    await shown(),
    { clove: 'Clove idle', marzipan: 'Marzipan working' },
    'the id stays as the lead gave it',
  );
  await h.finish(job, { result: 'Done.' });
  await h.worker('team', { job: job.id, done: true });
  assert.deepEqual(await shown(), {});
});

test("a failed job's members go, though the worker's word that it ended never came", async () => {
  const job = await h.start({ agent: 'wren', title: 'A job that fails' });
  await start(job, 'gingham');
  assert.deepEqual(await shown(), { gingham: 'Gingham working' });
  await h.finish(job, { status: 'failed', result: 'It broke.' }); // no team done after it
  assert.deepEqual(await shown(), {}, 'gone from HQ as the job ends');
  assert.equal((await start(job, 'gingham')).status, 409, 'a report that comes in after the run ended adds no one');
  await anotherClaim();
  assert.deepEqual(await shown(), {});
});

test('a restart cuts a run and its session resumes later: the earlier run’s members are gone, its new ones show', async () => {
  const first = await h.start({ agent: 'wren', title: 'Cut by a restart' });
  await h.finish(first, { status: 'interrupted', session: 's-1' }); // an earlier run, handed back with its session
  const job = (await h.claim(first.engine))!;
  await start(job, 'clove');
  await start(job, 'marzipan');
  // the worker went down with its run (no finish, no team done): ten minutes on, its heartbeat is stale
  h.db.prepare('update jobs set heartbeat = 0 where id = ?').run(job.id);
  assert.deepEqual(
    await shown(),
    { clove: 'Clove working', marzipan: 'Marzipan working' },
    'still running, as far as anyone knows',
  );
  await anotherClaim(); // the stale run goes back to the queue, and its team with it
  assert.deepEqual(await shown(), {});
  const again = (await h.claim(first.engine))!;
  assert.equal(again.session, 's-1', 'the job resumes in its session');
  assert.deepEqual(await shown(), {}, 'nobody from the earlier run');
  await start(again, 'gingham');
  assert.deepEqual(await shown(), { gingham: 'Gingham working' });
  await h.finish(again, { result: 'Done.' });
});

test('a member of a run going for days still shows: only the run decides', async () => {
  const job = await h.start({ agent: 'wren', title: 'A long one' });
  await start(job, 'clove');
  h.db.prepare('update team set updated = ? where job = ?').run(Date.now() - 3 * 86_400_000, job.id); // (three days on: no route moves the clock)
  await h.heartbeat(job);
  await anotherClaim();
  assert.deepEqual(await shown(), { clove: 'Clove working' });
});
