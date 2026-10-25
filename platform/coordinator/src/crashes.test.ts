// node --test src/crashes.test.ts (throwaway DATA_DIR and the test company): a service that keeps crashing is one job
// for the process role, its later readings added to that job's brief, as stalljobs.ts does for a stall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('crashes');
const { crashCheck } = await import('./crashes.ts');
const file = `${h.dataDir}/containers.json`;
const jobs = () =>
  h.db.prepare("select id, title, prompt from jobs where title like '% keeps crashing%' order by id").all() as {
    id: number;
    title: string;
    prompt: string;
  }[];
const reading = (at: number, restarts: Record<string, number>, state = 'restarting') => {
  writeFileSync(
    file,
    JSON.stringify({
      at: new Date(at).toISOString(),
      containers: Object.entries(restarts).map(([service, n]) => ({ service, state, restarts: n })),
    }),
  );
  crashCheck(at, file);
};

test('a service restarting 3 times in its window is one job; later readings join its brief; a started job holds the alarm until its work is out', async () => {
  const t = Date.now();
  reading(t, { voice: 0, worker: 4 }, 'running');
  reading(t + 60_000, { voice: 2, worker: 4 });
  assert.deepEqual(jobs(), [], 'two restarts, and a count that was already there, are no crash');
  reading(t + 120_000, { voice: 3, worker: 4 });
  assert.deepEqual(
    jobs().map(j => j.title),
    ['voice keeps crashing: 3 restarts in 2 min'],
  );
  assert.equal(h.job(jobs()[0].id).agent, 'bolt', "the process role's (org.yaml)");
  reading(t + 180_000, { voice: 6, worker: 4 });
  assert.equal(jobs().length, 1, 'the same service again queues no second job');
  assert.match(
    jobs()[0].prompt,
    /3 restarts in 2 min, now restarting\.\n- At .*: 6 restarts in 3 min, now restarting\.$/,
  );

  const running = await h.claim(h.job(jobs()[0].id).engine);
  assert.equal(running?.id, jobs()[0].id);
  reading(t + 240_000, { voice: 9, worker: 4 });
  assert.equal(jobs().length, 1, 'a started job holds the alarm');
  assert.doesNotMatch(jobs()[0].prompt, /9 restarts/, 'and its brief, read already, stays as it was');

  assert.equal((await h.finish(running!)).status, 200);
  reading(t + 300_000, { voice: 12, worker: 4 });
  assert.equal(jobs().length, 2, 'ended with nothing to deploy, the next crash is a job again');
});

test("a reading older than the window, or a recreated container's lower count, starts nothing", () => {
  const before = jobs().length;
  const t = Date.now() + 3_600_000;
  reading(t, { stt: 0 });
  writeFileSync(
    file,
    JSON.stringify({
      at: new Date(t).toISOString(),
      containers: [{ service: 'stt', state: 'restarting', restarts: 5 }],
    }),
  );
  crashCheck(t + 16 * 60_000, file);
  reading(t + 17 * 60_000, { stt: 0 });
  reading(t + 18 * 60_000, { stt: 2 });
  assert.equal(jobs().length, before);
});
