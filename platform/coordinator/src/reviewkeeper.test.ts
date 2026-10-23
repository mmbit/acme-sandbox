// node --test src/reviewkeeper.test.ts (uses a throwaway DATA_DIR and local GitHub fixture): the foundation keeper
// (org.yaml's roles.foundation) reads a first round's foundation files beside whoever triage chose, and nothing else.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness, until } from './harness.ts';
import { leftoverJobs } from './reviewfixture.ts';

const h = await harness('reviewkeeper', {
  before: repo => {
    const file = `${repo}/company/org.yaml`;
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('  process: bolt\n', '  process: bolt\n  foundation: lark\n'),
    );
  },
});
const { db } = h;
await import('./review.ts');
const sha = () => randomBytes(20).toString('hex');
const pending = (pr: number) => h.jobs.listJobs().filter(job => job.pr === pr && job.status === 'queued');
const reads = (pr: number) =>
  (
    db.prepare("select agent, judges from jobs where pr = ? and kind = 'review' and status = 'queued'").all(pr) as {
      agent: string;
      judges: string;
    }[]
  ).map(job => ({ agent: job.agent, files: JSON.parse(job.judges) }));
const cancelLeftovers = leftoverJobs(db);
afterEach(cancelLeftovers);

async function triaged(pr: number, author: string, files: string[]) {
  // (the reads queued for an earlier pull request here are out of the way: a claim takes the first queued job)
  db.prepare("update jobs set status = 'cancelled' where status = 'queued' and kind = 'review'").run();
  const run = await h.start({ agent: author, branch: `review/${pr}` });
  assert.equal((await h.finish(run, { pr, branch: `review/${pr}`, files, sha: sha() })).status, 200);
  await until(() => pending(pr).some(job => job.stage === 'triage'), 'round triage');
  const queued = pending(pr).find(job => job.stage === 'triage')!;
  const claimed = await h.claim(queued.engine, { seat: 'claude-1' });
  const selection = {
    decision: 'review',
    reason: 'Read the actual diff',
    consolidator: 'quill',
    reviewers: [{ agent: 'rook', reason: 'Read the changed behavior', files, domain: 'hq', security: false }],
  };
  assert.equal((await h.finish(claimed!, { output: JSON.stringify(selection) })).status, 200);
  await until(() => reads(pr).length > 0, 'the reads');
}

test("the keeper reads a first round's foundation files only, beside triage's choice; not its own work, nor product-only work", async () => {
  await triaged(201, 'bolt', ['platform/hq/room.js', 'products/shop/app/src/server.ts']);
  assert.deepEqual(reads(201), [
    { agent: 'rook', files: ['platform/hq/room.js', 'products/shop/app/src/server.ts'] },
    { agent: 'lark', files: ['platform/hq/room.js'] },
  ]);
  await triaged(202, 'bolt', ['products/shop/app/src/server.ts']);
  assert.deepEqual(
    reads(202).map(read => read.agent),
    ['rook'],
  );
  await triaged(203, 'lark', ['platform/hq/room.js']);
  assert.deepEqual(
    reads(203).map(read => read.agent),
    ['rook'],
  );
});
