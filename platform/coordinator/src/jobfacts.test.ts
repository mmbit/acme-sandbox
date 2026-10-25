// node --test src/jobfacts.test.ts   (a job's record for the back of its card: its times, agent time and size, and its
// pull request.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('jobfacts');
const facts = async (id: number) => (await h.board(`/api/jobs/facts?id=${id}`)).body as any;
const MIN = 60_000,
  T = Date.parse('2026-10-20T08:00:00Z');

test("a finished job's record: its first start, its last run's end, its runs' time against its size, its merged pull request", async () => {
  const id = h.pastJob({
    // (a second run, after a wait the agent time leaves out)
    runs: [
      { started: T, ended: T + 40 * MIN },
      { started: T + 50 * MIN, ended: T + 55 * MIN },
    ],
    merged: T + 60 * MIN,
    review: { added: 120, removed: 8, verdict: 'merge' },
    byBranch: true, // (a work job's pull request is its branch's)
    sized: 30 * MIN,
    pr: 7001,
  });
  assert.deepEqual(await facts(id), {
    started: '2026-10-20T08:00:00.000Z',
    finished: '2026-10-20T08:55:00.000Z',
    agent_ms: 45 * MIN,
    estimate_ms: 30 * MIN,
    pr: {
      number: 7001,
      status: 'merged',
      merged_at: '2026-10-20T09:00:00.000Z',
      added: 120,
      removed: 8,
      verdict: 'merge',
    },
  });
});

test('a job that never ran, with no size and no pull request, says so with nulls; an unknown one is a 404', async () => {
  const id = h.pastJob({ status: 'cancelled', finished: T });
  assert.deepEqual(await facts(id), {
    started: null,
    finished: '2026-10-20T08:00:00.000Z',
    agent_ms: null,
    estimate_ms: null,
    pr: null,
  });
  assert.equal((await h.board('/api/jobs/facts?id=999999')).status, 404);
});
