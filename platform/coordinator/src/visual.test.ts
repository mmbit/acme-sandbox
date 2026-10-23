// node --test src/visual.test.ts   (what people see, checked in pictures, org.yaml review.visual: a push of it carries its
// author's record of the previews or goes back to them, and a review of it that names no picture it opened didn't run)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { harness } from './harness.ts';
import { completeTriage } from './reviewfixture.ts';

const h = await harness('visual', {
  before: repo =>
    appendFileSync(
      `${repo}/company/org.yaml`,
      '\nreview:\n  visual:\n' +
        '    - { paths: ["platform/hq/renderers/**"], except: ["**/*.test.js"], run: "node preview.mjs", look: "lit in the dark", record: "qa/previews" }\n' +
        '    - { paths: ["kits/pixels/**"], run: "node sprites.mjs", look: "crisp", record: "qa/sprites" }\n',
    ),
});
const { db } = h;
// Each pull request's readers and the one of them who looks at the previews (rook alone, by default)
const panels = new Map<number, { readers: string[]; looker: string | null }>();
const finish = h.finish;
h.finish = async (job, report = { status: 'done' }) => {
  const reply = await finish(job, report);
  if (typeof report.pr === 'number') {
    const { readers, looker } = panels.get(report.pr) ?? { readers: ['rook'], looker: 'rook' };
    await completeTriage(h, report.pr, readers, looker);
  }
  return reply;
};

const ROOM = 'platform/hq/renderers/brownstone/rooms.js',
  RECORD = 'qa/previews/job-room.md',
  SAW = JSON.stringify({
    findings: [],
    summary: 'fine',
    previews: [{ sheet: '/tmp/meeting.png', saw: 'lit, window clear' }],
  });
afterEach(() => db.prepare("update jobs set status = 'cancelled' where status = 'queued'").run());

type Row = { id: number; agent: string; kind: string; prompt: string; engine: string };
const onPr = (pr: number) =>
  db
    .prepare("select id, agent, kind, prompt, engine from jobs where pr = ? and status = 'queued' order by id")
    .all(pr) as Row[];

test('a push of what people see without its record of the previews goes back to its author before any review, and so does its unchanged retry', async () => {
  const run = await h.start({ agent: 'bolt', engine: 'claude', branch: 'job/room' });
  await h.finish(run, { pr: 601, branch: 'job/room', files: [ROOM], sha: 'a'.repeat(40) });
  const [back, ...rest] = onPr(601);
  assert.equal(rest.length, 0, 'no review');
  assert.equal(back.kind, 'work');
  assert.match(back.prompt, /`node preview\.mjs`.*lit in the dark.*`--record qa\/previews\/job-room\.md`/s);

  const retry = await h.claim('claude');
  await h.finish(retry!, {
    pr: 601,
    branch: 'job/room',
    files: [ROOM],
    sha: 'a'.repeat(40),
    pushedSince: { sha: 'a'.repeat(40), files: [] },
  });
  assert.deepEqual(
    onPr(601).map(j => j.kind),
    ['work'],
    'back again, still no review',
  );
});

test('a push that changes what two checks cover owes both records, and gets both checks', async () => {
  const SPRITE = 'kits/pixels/sprites.js';
  const run = await h.start({ agent: 'bolt', engine: 'claude', branch: 'job/both' });
  await h.finish(run, {
    pr: 604,
    branch: 'job/both',
    files: [ROOM, SPRITE, 'qa/previews/job-both.md'],
    sha: 'd'.repeat(40),
  });
  const [back, ...rest] = onPr(604);
  assert.equal(rest.length, 0, 'no review while a record is missing');
  assert.match(back.prompt, /`node preview\.mjs`.*`node sprites\.mjs`.*`--record qa\/sprites\/job-both\.md`/s);

  const fix = await h.claim('claude');
  const both = [ROOM, SPRITE, 'qa/previews/job-both.md', 'qa/sprites/job-both.md'];
  await h.finish(fix!, { pr: 604, branch: 'job/both', files: both, sha: 'e'.repeat(40) });
  const reviews = onPr(604);
  assert.ok(
    reviews.length &&
      reviews.every(
        j => j.kind === 'review' && j.prompt.includes('node preview.mjs') && j.prompt.includes('node sprites.mjs'),
      ),
  );
});

test("only the reader triage chose to look gets the previews' step, its review naming no picture runs again, and the ruling weighs what it saw", async () => {
  panels.set(602, { readers: ['rook', 'tally'], looker: 'rook' });
  const run = await h.start({ agent: 'bolt', engine: 'claude', branch: 'job/room' });
  await h.finish(run, { pr: 602, branch: 'job/room', files: [ROOM, RECORD], sha: 'b'.repeat(40) });
  const reviews = onPr(602);
  const rook = reviews.find(j => j.agent === 'rook')!,
    tally = reviews.find(j => j.agent === 'tally')!;
  assert.ok(rook.prompt.includes('node preview.mjs') && !tally.prompt.includes('node preview.mjs'));
  for (const j of [rook, tally]) {
    const seat = await h.claim(j.engine);
    await h.finish(seat!, { output: '{"findings": [], "summary": "fine"}' });
  }
  await sleep(50);
  const again = onPr(602).filter(j => j.kind === 'review');
  assert.deepEqual(
    again.map(j => j.agent),
    ['rook'],
    "the looker's review runs again, the other reader's stands",
  );
  db.prepare('update jobs set not_before = 0 where id = ?').run(again[0].id);
  const r = await h.claim(again[0].engine);
  await h.finish(r!, { output: SAW });
  await sleep(50);
  const [ruling] = onPr(602).filter(j => j.kind === 'consolidate');
  assert.ok(ruling?.prompt.includes('## The previews'), 'the ruling weighs what rook saw');
  assert.ok(!ruling.prompt.includes('node preview.mjs'), "and doesn't render them again");
});

test('a change people see that triage gives no visual eye gets no previews step from anyone', async () => {
  panels.set(605, { readers: ['rook'], looker: null });
  const run = await h.start({ agent: 'bolt', engine: 'claude', branch: 'job/quiet' });
  await h.finish(run, { pr: 605, branch: 'job/quiet', files: [ROOM, 'qa/previews/job-quiet.md'], sha: 'f'.repeat(40) });
  const [review] = onPr(605);
  assert.ok(review.kind === 'review' && !review.prompt.includes('node preview.mjs'));
  const seat = await h.claim(review.engine);
  await h.finish(seat!, { output: '{"findings": [], "summary": "fine"}' });
  await sleep(50);
  const [ruling] = onPr(605).filter(j => j.kind === 'consolidate');
  assert.ok(
    ruling && !ruling.prompt.includes('node preview.mjs'),
    'a report without pictures stands and goes to the ruling',
  );
});

test('a push of anything else, or of what a check excepts, needs no record', async () => {
  panels.set(603, { readers: ['rook'], looker: null });
  const run = await h.start({ agent: 'bolt', engine: 'claude', branch: 'job/shell' });
  const files = ['platform/hq/shell/panel.js', 'platform/hq/renderers/brownstone/layout.test.js'];
  await h.finish(run, { pr: 603, branch: 'job/shell', files, sha: 'c'.repeat(40) });
  const reviews = onPr(603);
  assert.ok(reviews.length && reviews.every(j => j.kind === 'review' && !j.prompt.includes('node preview.mjs')));
});

test('a drawing the pull request puts back as main has it owes no record any more', async () => {
  const SHELL = 'platform/hq/shell/panel.js';
  panels.set(604, { readers: ['rook'], looker: null });
  const run = await h.start({ agent: 'bolt', engine: 'claude', branch: 'job/undo' });
  await h.finish(run, { pr: 604, branch: 'job/undo', files: [ROOM, SHELL], sha: 'd'.repeat(40) });
  assert.deepEqual(
    onPr(604).map(j => j.kind),
    ['work'],
    'back for the record',
  );

  const retry = await h.claim('claude');
  await h.finish(retry!, {
    pr: 604,
    branch: 'job/undo',
    files: [SHELL],
    sha: 'e'.repeat(40),
    pushedSince: { sha: 'd'.repeat(40), files: [ROOM] },
  });
  const reviews = onPr(604);
  assert.ok(reviews.length && reviews.every(j => j.kind === 'review' && !j.prompt.includes('node preview.mjs')));
});
