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

test("a push goes back for a redo when the last run on its branch was Codex's: by its own branch, its thread's or the job it's named after", async () => {
  assert.equal(
    typeof projects.createThread({ project: 'hq', name: 'Doors', goal: 'Doors look right', slug: 'doors' }),
    'object',
  );
  // (each Codex run ended after the Opus run that pushes: a push reviewed later, once its round is ruled, reads it)
  const codexRun = (fields: Record<string, unknown>) =>
    h.pastJob({ kind: 'work', agent: 'nib', engine: 'codex', finished: Date.now() + 60_000, ...fields });
  const named = codexRun({});
  codexRun({ thread: 'hq/doors' });
  codexRun({ branch: 'job/door' });
  const pushes: [number, Record<string, unknown>, string][] = [
    [507, { branch: 'job/door' }, 'job/door'],
    [508, { thread: 'hq/doors' }, 'job/doors'],
    [509, {}, `job/${named}`],
  ];
  // (all started before any redo is queued on Opus for the claim to take)
  const runs = [];
  for (const [, fields] of pushes) runs.push(await h.start({ agent: 'bolt', engine: 'claude', ...fields }));
  for (const [i, [pr, , branch]] of pushes.entries()) {
    await h.finish(runs[i], { pr, branch, files: [PIXEL, `qa/${branch.replace('/', '-')}.md`], sha: sha('i') });
    assert.deepEqual(
      onPr(pr).map(row => [row.agent, row.kind]),
      [['bolt', 'work']],
      `the redo of ${branch}`,
    );
  }
});

test("a stopped redo checked again after its rule changed goes back for its previews, open, and a second hq review doesn't take it past them to the panel", async () => {
  const run = await h.start({ agent: 'nib', engine: 'codex', branch: 'job/sill' });
  await h.finish(run, { pr: 510, branch: 'job/sill', files: [PIXEL], sha: sha('d') });
  const [queued] = onPr(510);
  const redo = await h.claim('claude');
  assert.equal(redo?.id, queued.id, 'the redo, first');
  await h.finish(redo!, {
    pr: 510,
    branch: 'job/sill',
    files: [PIXEL],
    sha: sha('d'),
    pushedSince: { sha: sha('d'), files: [] },
  });
  assert.equal((db.prepare('select status from prs where number = 510').get() as { status: string }).status, 'stuck');

  // the rule no longer covers the file: only the previews are owed
  const org = readFileSync(`${h.repo}/company/org.yaml`, 'utf8');
  writeFileSync(
    `${h.repo}/company/org.yaml`,
    org.replace('paths: ["platform/hq/renderers/**"] }\n', 'paths: ["kits/pixels/**"] }\n'),
  );
  try {
    const owner = await h.start({ agent: 'bolt' });
    const first = await h.agent('review', owner.token, { pr: 510 });
    assert.equal(first.status, 200);
    assert.deepEqual(
      onPr(510).map(row => row.kind),
      ['work'],
      'its previews, back to its author',
    );
    assert.equal((db.prepare('select status from prs where number = 510').get() as { status: string }).status, 'open');

    const second = await h.agent('review', owner.token, { pr: 510 });
    await h.finish(owner);
    assert.equal(second.status, 409, 'nothing stuck to send on');
    assert.deepEqual(
      onPr(510).map(row => row.kind),
      ['work'],
      'no triage before the previews',
    );
  } finally {
    writeFileSync(`${h.repo}/company/org.yaml`, org);
  }
});
