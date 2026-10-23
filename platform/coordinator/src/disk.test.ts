// node --test src/disk.test.ts   (the test company): which jobs' folders the worker may remove (POST /api/worker/ended),
// and the CEO's alarm when the disk fills up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('disk');
const { diskCheck } = await import('./disk.ts');   // (what the server runs every ten minutes: here with a disk and a time of the test's)
const ended = (ids: unknown) => h.worker('ended', { ids });

test('the worker hears which of its folders belong to jobs that have ended, and nothing else', async () => {
  const bolt = await h.start({ agent: 'bolt' });
  const run = async (status: string) => { const job = await h.start({ agent: 'bolt' }); await h.finish(job, { status, result: status }); return job.id; };
  const cancelled = h.queue({ agent: 'bolt', queuedBy: 'bolt' });
  assert.equal((await h.agent('cancel', bolt.token, { id: cancelled })).status, 200);
  const ids = [await run('done'), await run('failed'), cancelled, h.queue({ agent: 'bolt' }), (await h.start({ agent: 'bolt' })).id];
  const r = await ended([...ids, 99999]);
  assert.equal(r.status, 200);
  const sorted = (a: number[]) => a.sort((x, y) => x - y);
  assert.deepEqual(sorted(r.body.map((j: { id: number }) => j.id)), sorted(ids.slice(0, 3)));
  assert.equal(r.body[0].kind, 'work');
  assert.deepEqual((await ended([])).body, []);
  assert.equal((await ended('1,2')).status, 400);
  assert.equal((await ended([1.5])).status, 400);
});

test("one alarm for the CEO each time the disk stays past 85% for 20 minutes, shown in hq summary, and the next after it was under 80%", async () => {
  const alarms = () => (h.jobs.listJobs() as any[]).filter(j => j.agent === 'juno' && /disk is filling up/.test(j.title));
  const at = (used: number) => () => ({ blocks: 1000, bavail: Math.round(1000 * (1 - used)), bsize: 2 ** 20 });
  const M = 60_000, T0 = Date.parse('2026-10-08T12:00:00Z');
  diskCheck('x', at(0.84), T0);
  assert.equal(alarms().length, 0, 'below 85%: no alarm');
  diskCheck('x', at(0.92), T0); diskCheck('x', at(0.92), T0 + 10 * M); diskCheck('x', at(0.75), T0 + 15 * M);
  assert.equal(alarms().length, 0, "a deploy's build: high for a few minutes, then back");
  diskCheck('x', at(0.9), T0 + 20 * M); diskCheck('x', at(0.9), T0 + 30 * M);
  assert.equal(alarms().length, 0, '10 minutes high is not yet 20');
  diskCheck('x', at(0.9), T0 + 40 * M);
  const [job] = alarms();
  const brief = (await h.claim('claude'))!;
  assert.equal(brief.id, job.id);
  assert.match(brief.prompt, /90% full, 0\.1 GB free, past 85% for 20 minutes/);
  assert.match(brief.prompt, /Bolt's Process team/, 'what is already being done: the Process team');
  assert.match(brief.prompt, /is your call/);
  const reader = await h.start({ agent: 'juno', title: 'The morning round' });
  const summary = async () => (await h.agent('summary', reader.token)).body.text as string;
  assert.match(await summary(), new RegExp(`^- The server's disk is 90% full, 0\\.1 GB free \\(your job #${job.id}\\)$`, 'm'));
  diskCheck('x', at(0.7), T0 + 50 * M); diskCheck('x', at(0.9), T0 + 55 * M); diskCheck('x', at(0.9), T0 + 80 * M);
  assert.equal(alarms().length, 1, 'filling up again while its job is open: that job is still about it');
  await h.finish(brief);
  diskCheck('x', at(0.95), T0 + 90 * M);
  assert.equal(alarms().length, 1, 'its job done: no second job while the disk stays full');
  assert.match(await summary(), /disk is 95% full/, 'the summary shows it as it is');
  diskCheck('x', at(0.82), T0 + 100 * M); diskCheck('x', at(0.9), T0 + 110 * M); diskCheck('x', at(0.9), T0 + 140 * M);
  assert.equal(alarms().length, 1, 'a dip to 82% is no new filling up');
  diskCheck('x', at(0.7), T0 + 150 * M);
  // (its one-task thread's end may show among the finished)
  assert.doesNotMatch(await summary(), /disk is \d+% full/, 'under 80%: over');
  diskCheck('x', at(0.9), T0 + 160 * M); diskCheck('x', at(0.9), T0 + 180 * M);
  assert.equal(alarms().length, 2, 'back under 80%, then full for 20 minutes again: a new alarm');
  diskCheck('x', () => { throw new Error('no such dir'); });
  assert.equal(alarms().length, 2, 'an unreadable disk changes nothing');
  assert.deepEqual(((await h.board('/api/requests')).body as any[]).filter(c => /disk/.test(c.title)), [], 'and the board gets no card');
  await h.finish(reader);
});
