// node --test src/reviewkeeper.test.ts (uses a throwaway DATA_DIR and local GitHub fixture): the foundation keeper
// (org.yaml's roles.foundation) reads a first round's foundation files beside whoever triage chose, and nothing else.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { harness, until } from './harness.ts';
import { leftoverJobs } from './reviewfixture.ts';

const h = await harness('reviewkeeper', {
  before: repo => {
    const file = `${repo}/company/org.yaml`;
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('  process: bolt\n', '  process: bolt\n  foundation: lark\n'),
    );
    appendFileSync(
      file,
      '\nreview:\n  visual:\n' +
        '    - { paths: ["platform/hq/renderers/**"], run: "node preview.mjs", look: "lit in the dark", record: "qa/previews" }\n',
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

async function triaged(pr: number, author: string, files: string[], chosen = {}) {
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
    ...chosen,
  };
  assert.equal((await h.finish(claimed!, { output: JSON.stringify(selection) })).status, 200);
  await until(() => reads(pr).length > 0, 'the reads');
}

test("the keeper reads a first round's foundation files only, beside triage's choice; co-authored work included, sole-authored and product-only work excluded", async () => {
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
  h.ended({ agent: 'lark', branch: 'review/204' });
  await triaged(204, 'bolt', ['platform/hq/room.js']);
  assert.deepEqual(
    reads(204).map(read => read.agent),
    ['rook', 'lark'],
  );
});

test('a consolidator reading a foundation change that shows alone renders its previews itself, beside the keeper', async () => {
  const room = 'platform/hq/renderers/brownstone/rooms.js';
  await triaged(205, 'bolt', [room, 'qa/previews/review-205.md'], { reviewers: [], looker: 'quill' });
  assert.deepEqual(reads(205), [{ agent: 'lark', files: [room] }]);
  const keeper = await h.claim('claude', { seat: 'claude-1' });
  assert.ok(!keeper!.prompt.includes('node preview.mjs'), 'the keeper is no looker');
  await h.finish(keeper!, { output: JSON.stringify({ findings: [], summary: 'generic' }) });
  await until(() => pending(205).some(job => job.stage === 'ruling'), 'the ruling');
  const ruling = db.prepare("select prompt from jobs where pr = 205 and stage = 'ruling'").get() as { prompt: string };
  assert.ok(ruling.prompt.includes('node preview.mjs'), 'the ruling renders the previews');
  assert.ok(!ruling.prompt.includes('one reader to look'), 'and is told nobody looked before it');
});
