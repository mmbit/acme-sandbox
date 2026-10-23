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
const review = await import('./review.ts');
const team = await import('./team.ts');
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
    assert.equal(panel.consolidator(pr), 'juno');
    assert.ok(!panel.reviewers(pr).includes('rook'));
  }
  assert.deepEqual(panel.authors(branch), new Set(['bolt', 'quill', 'rook']));
  const touched = (await h.feed()).find(event => event.text?.includes('PR #71: Quill touched up'));
  assert.equal(touched?.agent, 'quill', 'the recorded editor gets credit after panel eligibility changes');
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
