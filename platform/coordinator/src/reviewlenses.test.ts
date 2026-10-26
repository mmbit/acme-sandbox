// node --test src/reviewlenses.test.ts (uses a throwaway DATA_DIR and local GitHub fixture): the readability reader
// (org.yaml's roles.readability) reads a first round unless triage says why not, and the foundation question goes only
// to the reader triage gives it and to where engine constraints move its files
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness, until } from './harness.ts';
import { leftoverJobs } from './reviewfixture.ts';

const h = await harness('reviewlenses', {
  before: repo => {
    const file = `${repo}/company/org.yaml`;
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('  process: bolt\n', '  process: bolt\n  readability: lark\n') +
        '\nengineOnly:\n  - { id: pixels, what: pixel work, engine: claude, model: claude-opus-5-5, paths: ["platform/hq/renderers/**", "kits/pixels/**"] }\n',
    );
  },
});
const { db } = h;
await import('./review.ts');
const files = ['platform/hq/room.js', 'products/shop/app/src/server.ts'];
const pending = (pr: number) => h.jobs.listJobs().filter(job => job.pr === pr && job.status === 'queued');
const briefs = (pr: number) =>
  Object.fromEntries(
    (
      db.prepare("select agent, prompt from jobs where pr = ? and kind = 'review' and status = 'queued'").all(pr) as {
        agent: string;
        prompt: string;
      }[]
    ).map(job => [job.agent, job.prompt]),
  );
const read = (agent: string, domain: string, theirs = files) => ({
  agent,
  reason: `Read the ${domain}`,
  files: theirs,
  domain,
  security: false,
});
const selection = (more = {}) => ({
  decision: 'review',
  reason: 'Read the actual diff',
  consolidator: 'quill',
  reviewers: [read('rook', 'behavior'), read('lark', 'readability and structure')],
  foundation: null,
  ...more,
});
const cancelLeftovers = leftoverJobs(db);
afterEach(cancelLeftovers);

// The round's triage, claimed: what its answer check says of an output, and its finish
async function triage(pr: number, author = 'bolt', changed = files) {
  db.prepare("update jobs set status = 'cancelled' where status = 'queued' and kind = 'review'").run();
  const work = await h.start({ agent: author, branch: `review/${pr}`, engine: 'claude' });
  const sha = randomBytes(20).toString('hex');
  assert.equal((await h.finish(work, { pr, branch: `review/${pr}`, files: changed, sha })).status, 200);
  await until(() => pending(pr).some(job => job.stage === 'triage'), 'round triage');
  const run = await h.claim(pending(pr).find(job => job.stage === 'triage')!.engine, { seat: 'claude-1' });
  return {
    brief: run!.prompt,
    check: async (output: object) =>
      (await h.agent('review-output', run!.token, { output: JSON.stringify(output) })).body.error,
    finish: async (output: object) => {
      assert.equal((await h.finish(run!, { output: JSON.stringify(output) })).status, 200);
      await until(() => Object.keys(briefs(pr)).length > 0, 'the reads');
    },
  };
}

test('a first read chooses the readability reader, or says why not', async () => {
  const round = await triage(301);
  assert.ok(round.brief.includes("Readability and structure are lark's lens"));
  const without = selection({ reviewers: [read('rook', 'behavior')] });
  assert.equal(await round.check(without), 'omitted readability reader needs a reason');
  const excepted = { ...without, exceptions: [{ agent: 'lark', reason: 'Only a note changed' }] };
  assert.equal(await round.check(excepted), null);
  await round.finish(selection());
  assert.ok(briefs(301).lark.includes('## Your lens: readability and structure'));
});

test("the readability reader's own work goes without them", async () => {
  const round = await triage(302, 'lark');
  assert.ok(!round.brief.includes('Readability and structure are'));
  await round.finish(selection({ reviewers: [read('rook', 'behavior')] }));
  assert.deepEqual(Object.keys(briefs(302)), ['rook']);
});

test('the foundation question goes to the one reader triage gives it, and to nobody by default', async () => {
  const round = await triage(303);
  assert.ok(round.brief.includes('The foundation question'));
  assert.equal(
    await round.check(selection({ foundation: 'quill' })),
    'the foundation question goes to one of the readers',
  );
  await round.finish(selection({ foundation: 'lark' }));
  const question = 'Triage also gave you the foundation question';
  assert.ok(briefs(303).lark.includes(question));
  assert.ok(!briefs(303).rook.includes(question));
  const plain = await triage(304);
  await plain.finish(selection());
  assert.deepEqual(Object.keys(briefs(304)).sort(), ['lark', 'rook'], 'a foundation file adds no reader by itself');
  assert.ok(!Object.values(briefs(304)).some(brief => brief.includes(question)));
});

test('the foundation question follows its files when engine constraints move them from the reader it went to', async () => {
  const renderer = 'platform/hq/renderers/brownstone/rooms.js',
    server = 'products/shop/app/src/server.ts';
  const round = await triage(305, 'bolt', [renderer, server]);
  assert.ok(round.brief.includes('goes with those files to their reader too'));
  await round.finish(
    selection({
      reviewers: [read('nib', 'behavior', [renderer, server]), read('lark', 'readability and structure', [server])],
      foundation: 'nib',
    }),
  );
  const question = 'Triage also gave you the foundation question';
  const reads = db
    .prepare("select agent, judges from jobs where pr = 305 and kind = 'review' and status = 'queued'")
    .all();
  assert.deepEqual(
    Object.fromEntries((reads as { agent: string; judges: string }[]).map(job => [job.agent, JSON.parse(job.judges)])),
    { nib: [server], lark: [server, renderer] },
    'the pixel rule moves the renderer to the Claude reader',
  );
  assert.ok(briefs(305).lark.includes(question), 'the moved foundation file brings the question');
  assert.ok(briefs(305).nib.includes(question), 'the chosen reader keeps it for our own folders');
});

test('the foundation question follows code in our own folders that engine constraints move', async () => {
  const sheet = 'kits/pixels/sheet.ts',
    server = 'products/shop/app/src/server.ts';
  const round = await triage(306, 'bolt', [sheet, server]);
  await round.finish(
    selection({
      reviewers: [read('nib', 'structure', [sheet, server]), read('lark', 'readability and structure', [server])],
      foundation: 'nib',
    }),
  );
  const question = 'Triage also gave you the foundation question';
  assert.ok(briefs(306).lark.includes(question), 'the moved kit code brings the question');
  assert.ok(briefs(306).nib.includes(question));
});
