// node --test src/panel.test.ts   (uses a throwaway DATA_DIR)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('panel', {
  before: repo => {
    const path = `${repo}/company/org.yaml`;
    writeFileSync(path, readFileSync(path, 'utf8').replace('consolidator: quill', 'consolidator: [quill, rook]'));
  },
});
const panel = await import('./panel.ts');
const { org } = await import('./company.ts');
const review = await import('./review.ts');
const team = await import('./team.ts');
const { db } = await import('./db.ts');
const files = ['products/x/index.html'];
const sha = 'a'.repeat(40);
afterEach(() => h.cancelQueued());

async function recordedTouchup(pr: number, member: string, pushed: boolean) {
  const author = h.ended({ agent: 'bolt' });
  h.storedPr(pr, author, 'open', files, { sha, round: 1 });
  const branch = `job/${author}`;
  const ruler = await h.start({
    agent: 'quill',
    kind: 'consolidate',
    branch,
    pr,
    round: 1,
    sha,
    stage: 'ruling',
    writes: files,
  });
  assert.deepEqual(team.teamEvent({ job: ruler.id, id: member }), { ok: true });
  review.touchedUp(
    { id: ruler.id, pr, round: 1, sha },
    pushed ? { sha: 'b'.repeat(40), files } : { refused: 'No changes were pushed' },
  );
  team.teamEvent({ job: ruler.id, done: true });
  await h.finish(ruler, { status: 'failed' });
  return { author, branch };
}

test('pushed consolidator edits and their registered members are authors throughout the branch', async () => {
  const { author, branch } = await recordedTouchup(71, 'rook', true);
  h.storedPr(72, author, 'open', files, { sha, round: 2 });
  for (const pr of [71, 72]) {
    assert.deepEqual(panel.authorsOf(pr), new Set(['bolt', 'quill', 'rook']));
    assert.equal(panel.consolidator(pr), 'quill');
    assert.ok(panel.reviewers(pr).includes('rook'));
  }
  assert.deepEqual(panel.authors(branch), new Set(['bolt', 'quill', 'rook']));
  const touched = (await h.feed()).find(event => event.text?.includes('PR #71: Quill touched up'));
  assert.equal(touched?.agent, 'quill', 'the recorded editor gets credit after panel eligibility changes');
});

test("a branch's authors: its own jobs, its thread's tasks and the job it's named after, no one else's", () => {
  const thread = h.dueThread();
  db.prepare('update threads set branch = ? where id = ?').run('thread/authors', thread);
  const tasks = [h.ended({ agent: 'tally', thread }), h.ended({ agent: 'nib', thread })];
  db.prepare(`update jobs set branch = null where id = ?`).run(tasks[1]);
  h.ended({ agent: 'flint', branch: 'thread/authors' });
  h.ended({ agent: 'rook', kind: 'review', branch: 'thread/authors' });
  h.ended({ agent: 'plane', branch: 'job/elsewhere' });
  assert.deepEqual(panel.authors('thread/authors', 'bolt'), new Set(['tally', 'nib', 'flint', 'bolt']));
  const named = h.ended({ agent: 'gesso' });
  db.prepare('update jobs set branch = null where id = ?').run(named);
  assert.deepEqual(panel.authors(`job/${named}`), new Set(['gesso']));
  assert.deepEqual(panel.authors(`job/0${named}`), new Set(), 'only the name the job goes by');
});

test('read-only and unpushed consolidations remain independent reviewers', async () => {
  const author = h.ended({ agent: 'bolt' });
  h.storedPr(73, author, 'open', files, { sha, round: 1 });
  const ruler = await h.start({
    agent: 'quill',
    kind: 'consolidate',
    branch: `job/${author}`,
    pr: 73,
    round: 1,
    sha,
    stage: 'ruling',
  });
  assert.deepEqual(team.teamEvent({ job: ruler.id, id: 'tally' }), { ok: true });
  team.teamEvent({ job: ruler.id, done: true });
  await h.finish(ruler, { status: 'failed' });
  assert.deepEqual(panel.authorsOf(73), new Set(['bolt']));
  await recordedTouchup(74, 'nib', false);
  assert.deepEqual(panel.authorsOf(74), new Set(['bolt']));
  assert.equal(panel.consolidator(74), 'quill');
  assert.ok(panel.reviewers(74).includes('nib'));
  assert.deepEqual(panel.authorsOf(73), new Set(['bolt']), 'other branches do not supply authors');
});

test('a branch authored by every staff member still has a consolidator and reviewers', () => {
  const author = h.ended({ agent: 'bolt' });
  h.storedPr(75, author, 'open', files, { sha, round: 1 });
  const { departments } = org();
  for (const department of departments)
    for (const agent of department.agents ?? []) h.ended({ agent: agent.id, branch: `job/${author}` });
  assert.equal(panel.consolidator(75), 'quill');
  assert.ok(panel.reviewers(75).includes('rook'));
});

test('a sole author cannot be its reviewer or consolidator', () => {
  for (const [pr, agent] of [
    [76, 'quill'],
    [77, 'rook'],
    [78, 'juno'],
  ] as const) {
    const author = h.ended({ agent });
    h.storedPr(pr, author, 'open', files, { sha, round: 1 });
    assert.ok(!panel.reviewers(pr).includes(agent));
    assert.ok(!panel.consolidators(pr).includes(agent));
    assert.notEqual(panel.consolidator(pr), agent);
  }
});

test('the default CEO consolidator follows the same sole-author rule', () => {
  const path = `${process.env.REPO_DIR}/company/org.yaml`,
    before = readFileSync(path, 'utf8');
  writeFileSync(path, before.replace('consolidator: [quill, rook]', 'consolidator:'));
  try {
    const author = h.ended({ agent: 'juno' });
    h.storedPr(79, author, 'open', files, { sha, round: 1 });
    assert.notEqual(panel.consolidator(79), 'juno');
    h.ended({ agent: 'bolt', branch: `job/${author}` });
    assert.equal(panel.consolidator(79), 'juno');
  } finally {
    writeFileSync(path, before);
  }
});
