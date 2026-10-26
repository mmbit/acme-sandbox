// node --test src/engineonly.test.ts   (work only one engine and model do, org.yaml engineOnly: the test company's pixel
// work is Opus's. A Codex run's push of it goes back to its author to restore and redo, every job on that pull request,
// branch or thread runs on Opus, whoever it's for, and a mixed pull request's other files keep their Codex reviewers.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './harness.ts';
import { completeTriage } from './reviewfixture.ts';

const MODEL = 'claude-opus-test';
const h = await harness('engineonly', {
  serve: true,
  before: repo =>
    appendFileSync(
      `${repo}/company/org.yaml`,
      `\nengineOnly:\n  - { id: pixels, what: pixel work, engine: claude, model: ${MODEL}, paths: ["platform/hq/renderers/**"] }\n` +
        // (and the pictures' record each push of them carries: visual.test.ts)
        'review:\n  visual:\n    - { paths: ["platform/hq/renderers/**"], run: "node preview.mjs", look: "x", record: "qa" }\n',
    ),
});
const { db } = h;
const finish = h.finish;
h.finish = async (job, report = { status: 'done' }) => {
  const reply = await finish(job, report);
  if (typeof report.pr === 'number') await completeTriage(h, report.pr, ['rook', 'nib']);
  return reply;
};

const projects = await import('./projects.ts');
const PROJECTS = readFileSync(`${h.repo}/company/projects.yaml`, 'utf8').replace(
  'projects:\n',
  'projects:\n  - { id: hq, name: HQ, owner: bolt }\n',
);
writeFileSync(`${h.repo}/company/projects.yaml`, PROJECTS);
const PIXEL = 'platform/hq/renderers/brownstone/rooms.js',
  OTHER = 'platform/hq/shell/panel.js',
  CRITICAL = 'platform/coordinator/src/review.ts';
const sha = (c: string) => c.repeat(40);
afterEach(() => db.prepare("update jobs set status = 'cancelled' where status = 'queued'").run());

type Row = { id: number; agent: string; kind: string; engine: string; judges: string | null };
const onPr = (pr: number) =>
  db
    .prepare("select id, agent, kind, engine, judges from jobs where pr = ? and status = 'queued' order by id")
    .all(pr) as Row[];
const judges = (row: Row) => JSON.parse(row.judges ?? '[]') as string[];

test("a Codex run's push of pixel work goes back to be redone on Opus until a push changes it again, then every seat runs on Opus", async () => {
  const run = await h.start({ agent: 'nib', engine: 'codex', branch: 'job/pixels' });
  await h.finish(run, { pr: 501, branch: 'job/pixels', files: [PIXEL, OTHER], sha: sha('a') });
  const [redo, ...rest] = onPr(501);
  assert.equal(rest.length, 0, 'no review yet');
  assert.deepEqual([redo.agent, redo.kind], ['nib', 'work']);
  assert.equal(await h.claim('codex'), null, 'Codex cannot take the redo');

  // a push that leaves the Codex drawing as it was comes back again
  const kept = await h.claim('claude');
  assert.equal(kept?.id, redo.id);
  assert.equal(kept?.agentInfo?.model, MODEL);
  const record = 'qa/job-pixels.md';
  await h.finish(kept!, {
    pr: 501,
    branch: 'job/pixels',
    files: [PIXEL, OTHER, record],
    sha: sha('b'),
    pushedSince: { sha: sha('a'), files: [record] },
  });
  const [again, ...none] = onPr(501);
  assert.equal(none.length, 0, 'still no review');
  assert.equal(again.kind, 'work');

  // redrawn: the panel, every review on Opus whatever its reviewer's own model
  const redrawn = await h.claim('claude');
  await h.finish(redrawn!, {
    pr: 501,
    branch: 'job/pixels',
    files: [PIXEL, OTHER, record],
    sha: sha('c'),
    pushedSince: { sha: sha('b'), files: [PIXEL, record] },
  });
  const reviews = onPr(501);
  assert.ok(
    reviews.length && reviews.every(j => j.kind === 'review' && j.engine === 'claude'),
    JSON.stringify(reviews),
  );
  const review = await h.claim('claude');
  assert.equal(review?.agentInfo?.model, MODEL, `${review?.agent} reviews pixel work on the rule's model`);
});

test('a mixed pull request keeps its Codex reviewers on Codex for the rest, and its pixel work is judged on Opus', async () => {
  const run = await h.start({ agent: 'bolt', engine: 'claude', branch: 'job/mixed' });
  await h.finish(run, { pr: 502, branch: 'job/mixed', files: [PIXEL, CRITICAL, 'qa/job-mixed.md'], sha: sha('d') });
  const reviews = onPr(502).filter(j => j.kind === 'review');
  const codex = reviews.filter(j => j.engine === 'codex');
  assert.ok(codex.length, JSON.stringify(reviews));
  assert.ok(
    codex.every(j => judges(j).includes(CRITICAL) && !judges(j).includes(PIXEL)),
    JSON.stringify(reviews),
  );
  const pixel = reviews.filter(j => judges(j).includes(PIXEL));
  assert.ok(pixel.length && pixel.every(j => j.engine === 'claude'), JSON.stringify(reviews));
});

test('a Codex push with no pixel work in it goes to the panel as it would', async () => {
  const run = await h.start({ agent: 'nib', engine: 'codex', branch: 'job/shell' });
  await h.finish(run, { pr: 503, branch: 'job/shell', files: [OTHER], sha: sha('e') });
  const reviews = onPr(503);
  assert.ok(reviews.length && reviews.every(j => j.kind === 'review'), JSON.stringify(reviews));
});

test("work declared as pixel work runs on Opus from the start, and queued work on a branch moves there once a push shows it's pixel work", async () => {
  const lead = await h.start({ agent: 'bolt', branch: 'job/lead' });
  const brief = join(mkdtempSync(join(tmpdir(), 'engineonly-')), 'brief.md');
  writeFileSync(brief, 'Draw the lobby.\n');
  const queued = await h.hq(
    lead,
    'job',
    '--only',
    'pixels',
    'nib',
    'Draw the lobby',
    brief,
    '--code',
    'LOBBY',
    '--new',
  );
  const declared = Number(/Queued job #(\d+)/.exec(queued.out)?.[1]);
  assert.ok(declared, queued.out);
  assert.equal(h.job(declared).engine, 'claude');
  const refused = await h.hq(lead, 'job', '--only', 'sound', 'nib', 'Hum', brief, '--code', 'HUM', '--new');
  assert.notEqual(refused.code, 0, refused.out);

  const later = h.queue({ agent: 'nib', engine: 'codex', branch: 'job/rooms' });
  const run = await h.start({ agent: 'bolt', branch: 'job/rooms' });
  await h.finish(run, { pr: 504, branch: 'job/rooms', files: [PIXEL, 'qa/job-rooms.md'], sha: sha('f') });
  assert.equal(h.job(later).engine, 'claude');
});

test('a task in a thread whose branch holds pixel work runs on Opus, with no branch of its own', async () => {
  assert.equal(
    typeof projects.createThread({ project: 'hq', name: 'Rooms', goal: 'Rooms look right', slug: 'rooms' }),
    'object',
  );
  const first = await h.start({ agent: 'bolt', thread: 'hq/rooms' });
  const branch = `job/${first.id}`;
  await h.finish(first, { pr: 505, branch, files: [PIXEL, `qa/${branch.replace('/', '-')}.md`], sha: sha('g') });
  const next = h.jobs.createJob({
    agent: 'nib',
    title: 'The lobby',
    prompt: 'x',
    thread: 'hq/rooms',
    queuedBy: 'bolt',
  });
  assert.equal(h.job(next.id).engine, 'claude');
});

test("a thread task's push owing a redo goes back to its author, never held for the thread's next task", async () => {
  assert.equal(
    typeof projects.createThread({ project: 'hq', name: 'Walls', goal: 'Walls look right', slug: 'walls' }),
    'object',
  );
  const first = await h.start({ agent: 'nib', engine: 'codex', thread: 'hq/walls' });
  h.jobs.createJob({ agent: 'bolt', title: 'The hall', prompt: 'x', thread: 'hq/walls', queuedBy: 'bolt' });
  const branch = `job/${first.id}`;
  await h.finish(first, { pr: 506, branch, files: [PIXEL], sha: sha('h') });
  assert.equal(db.prepare('select 1 from review_waiting_pushes where pr = 506').get(), undefined, 'not held');
  assert.deepEqual(
    onPr(506).map(row => [row.agent, row.kind]),
    [['nib', 'work']],
    'the redo, back to its author',
  );
});
