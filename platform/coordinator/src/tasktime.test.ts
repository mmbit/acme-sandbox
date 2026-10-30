// node --test src/tasktime.test.ts (throwaway DATA_DIR): whole-task evidence through estimate and the real hq CLI.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('tasktime');
const MINUTE = 60_000,
  T = Date.now() - 24 * 60 * MINUTE;
const run = (start: number, minutes: number) => ({
  started: T + start * MINUTE,
  ended: T + (start + minutes) * MINUTE,
});
const reader = await h.start({ agent: 'bolt', title: 'Compare whole tasks' });
const ask = async (id: number, token = reader.token) => {
  const response = await h.agent(`estimate?q=%23${id}`, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.job;
};

test('a task sums every review round, ruling, fix, sync and preview from runs, with queue gaps out', async () => {
  const id = h.pastJob({ title: 'Whole harbour', run: run(0, 40) });
  h.storedPr(100, id, 'open');
  h.pastJob({ kind: 'review', pr: 100, run: run(90, 10) });
  h.pastJob({ kind: 'consolidate', stage: 'ruling', pr: 100, run: run(120, 5) });
  const fix = h.pastJob({
    stage: 'fix',
    round: 1,
    pr: 100,
    branch: `job/${id}`,
    runs: [run(180, 10), { ...run(280, 20), outcome: 'failed' }],
  });
  h.pastJob({ kind: 'review', pr: 100, run: run(320, 10) });
  h.pastJob({ kind: 'consolidate', stage: 'merge', pr: 100, run: run(360, 5) });
  h.pastJob({ stage: 'fix', pr: 100, branch: `job/${id}`, run: run(400, 7) });
  h.pastJob({ previewFor: [100], run: run(440, 8) });
  h.pastJob({ after: id, run: run(460, 70) });
  h.mergedPr(100, T + 500 * MINUTE);
  h.pastJob({ kind: 'review', pr: 100, run: run(510, 90) });
  const decisions = await import('./decisions.ts');
  decisions.retireMerge(100);
  const shown = await ask(id);
  assert.equal(shown.agent_minutes, 40);
  assert.equal(shown.whole.agent_minutes, 115);
  assert.deepEqual(shown.whole.split, { work: 40, reviews: 30, fixes: 30, syncs: 7, previews: 8 });
  assert.equal(shown.whole.complete, true);
  const raw = (await import('./matching.ts')).pastJobs([id, fix]);
  assert.deepEqual(
    raw.map(job => Math.round(job.agent_ms / MINUTE)),
    [40, 30],
  );
  const call = (await h.voice('call-context?agent=bolt')).body;
  assert.deepEqual((await ask(id, call.token)).whole, shown.whole);
  const cli = await h.hq(reader, 'estimate', `#${id}`);
  assert.equal(cli.code, 0, cli.out);
  assert.match(cli.out, /Whole task: 1 h 55 min/);
  assert.match(cli.out, /work 40 min, reviews 30 min, fixes 30 min/);
});

test('shared rounds are allocated once across all initial tasks, even when only one task matches the search', async () => {
  const first = h.pastJob({ title: 'Shared harbour first', run: run(0, 20) });
  const second = h.pastJob({ title: 'Shared harbour second', branch: `job/${first}`, run: run(30, 60) });
  h.storedPr(101, first, 'open');
  h.pastJob({ kind: 'review', pr: 101, run: run(100, 20) });
  h.pastJob({ kind: 'consolidate', pr: 101, run: run(140, 10) });
  h.pastJob({ stage: 'fix', round: 1, branch: `job/${first}`, pr: 101, run: run(180, 30) });
  h.mergedPr(101, T + 240 * MINUTE);
  const [a, b] = await Promise.all([ask(first), ask(second)]);
  assert.equal(a.whole.agent_minutes, 50);
  assert.equal(b.whole.agent_minutes, 90);
  assert.equal(a.whole.agent_minutes + b.whole.agent_minutes, 140);
  assert.deepEqual(a.whole.split, { work: 20, reviews: 15, fixes: 15, syncs: 0, previews: 0 });
  assert.deepEqual(a.whole.tasks, [first, second]);
  assert.equal(a.whole.share, 0.5);
  const cli = await h.hq(reader, 'estimate', 'Shared harbour first');
  assert.equal(cli.code, 0, cli.out);
  assert.match(cli.out, /--size covers the work split only/);
  assert.match(cli.out, /forecast adds review and fix rounds once per deliverable/);
  assert.match(cli.out, /Shared rounds: 1\/2/);
});

test('explicit fix assignments include their own branch and reviews without counting the fix twice', async () => {
  const id = h.pastJob({ title: 'Separate fix branch', run: run(0, 20) });
  h.storedPr(102, id, 'open');
  const fix = h.pastJob({ stage: 'fix', round: 1, fixFor: 102, run: run(60, 15) });
  h.storedPr(103, fix, 'open');
  h.pastJob({ kind: 'review', pr: 103, branch: `job/${fix}`, run: run(100, 10) });
  h.mergedPr(103, T + 140 * MINUTE);
  h.mergedPr(102, T + 180 * MINUTE);
  const shown = await ask(id);
  assert.equal(shown.whole.agent_minutes, 45);
  assert.equal(shown.whole.split.reviews, 10);
  assert.equal(shown.whole.split.fixes, 15);
});

for (const phase of ['previews', 'fixes'] as const) {
  test(`a linked ${phase} branch counts only the linked job's own landing`, async () => {
    const id = h.pastJob({ title: `Bounded ${phase}`, run: run(0, 20) });
    const sourcePr = phase === 'previews' ? 120 : 123;
    h.storedPr(sourcePr, id, 'open');
    const link = phase === 'previews' ? { previewFor: [sourcePr] } : { fixFor: sourcePr, stage: 'fix', round: 1 };
    const linked = h.pastJob({ ...link, run: run(30, 10) });
    h.storedPr(sourcePr + 1, linked, 'open');
    h.pastJob({ kind: 'review', pr: sourcePr + 1, run: run(45, 5) });
    h.mergedPr(sourcePr + 1, T + 60 * MINUTE);
    h.pastJob({ branch: `job/${linked}`, run: run(65, 20) });
    h.storedPr(sourcePr + 2, linked, 'open');
    h.pastJob({ kind: 'review', pr: sourcePr + 2, run: run(85, 5) });
    h.mergedPr(sourcePr + 2, T + 95 * MINUTE);
    h.mergedPr(sourcePr, T + 100 * MINUTE);
    const shown = await ask(id);
    assert.equal(shown.whole.agent_minutes, 35);
    assert.equal(shown.whole.split[phase], 10);
    assert.equal(shown.whole.split.reviews, 5);
    assert.equal(shown.whole.complete, true);
  });
}

test('a linked branch stops counting runs at the source task landing', async () => {
  const id = h.pastJob({ title: 'Source caps preview', run: run(0, 20) });
  h.storedPr(126, id, 'open');
  const preview = h.pastJob({ previewFor: [126], run: run(30, 10) });
  h.storedPr(127, preview, 'open');
  h.pastJob({ kind: 'review', pr: 127, run: run(90, 30) });
  h.mergedPr(127, T + 140 * MINUTE);
  h.mergedPr(126, T + 100 * MINUTE);
  const shown = await ask(id);
  assert.equal(shown.whole.agent_minutes, 40);
  assert.equal(shown.whole.split.previews, 10);
  assert.equal(shown.whole.split.reviews, 10);
});

test('unfinished tasks do not share landed rounds and unfinished review runs make timing incomplete', async () => {
  const id = h.pastJob({ title: 'Open jobs beside landed work', run: run(0, 20) });
  h.storedPr(129, id, 'open');
  mock.timers.enable({ apis: ['Date'], now: T + 40 * MINUTE });
  try {
    h.queue({ agent: 'kit', title: 'Unfinished later task', branch: `job/${id}` });
    const review = h.queue({ agent: 'kit', title: 'Unfinished review', kind: 'review', pr: 129 });
    const running = await h.claimJob(review);
    h.mergedPr(129, T + 100 * MINUTE);
    const shown = await ask(id);
    assert.deepEqual(shown.whole.tasks, [id]);
    assert.equal(shown.whole.share, 1);
    assert.equal(shown.whole.agent_minutes, 20);
    assert.equal(shown.whole.complete, false);
    assert.ok(shown.whole.flags.includes('open_runs'));
    mock.timers.setTime(T + 110 * MINUTE);
    await h.finish(running);
  } finally {
    mock.timers.reset();
    h.cancelQueued();
  }
});

test('missing follow-up runs cannot be presented as a complete landed total', async () => {
  const id = h.pastJob({ title: 'Incomplete follow-up', run: run(0, 20) });
  h.storedPr(104, id, 'open');
  h.pastJob({ kind: 'review', pr: 104, created: T + 60 * MINUTE });
  assert.equal((await ask(id)).whole.complete, false);
  h.mergedPr(104, T + 180 * MINUTE);
  const shown = await ask(id);
  assert.equal(shown.whole.complete, false);
  assert.ok(shown.whole.flags.includes('missing_runs'));
  const cli = await h.hq(reader, 'estimate', `#${id}`);
  assert.match(cli.out, /Task so far: 20 min/);
  assert.match(cli.out, /Incomplete timing: recorded runs missing/);
});

test('whole-task timing and own-job timing agree on rebuilt and invalid runs', async () => {
  const cases = [
    { run: { ...run(0, 10), outcome: 'rebuilt' }, flag: 'rebuilt', minutes: 10 },
    { run: { ...run(0, 10), seat: null }, flag: 'rebuilt', minutes: 10 },
    { run: run(0, 0), flag: 'invalid_time', minutes: 0 },
    { run: run(10, -5), flag: 'invalid_time', minutes: 0 },
  ];
  for (const evidence of cases) {
    const id = h.pastJob({ run: evidence.run });
    const shown = await ask(id);
    assert.equal(shown.rebuilt, evidence.flag === 'rebuilt');
    if (evidence.flag === 'invalid_time') assert.ok(shown.timing_quality.includes(evidence.flag));
    assert.ok(shown.whole.flags.includes(evidence.flag));
    assert.equal(shown.whole.complete, false);
    assert.equal(shown.whole.agent_minutes, evidence.minutes);
  }
});

test('a pending preview shares time with branches that join before its card is filed, after holds retire', async () => {
  const thread = h.dueThread();
  const id = h.pastJob({
    id: 10000,
    branch: 'job/10000',
    title: 'Preview lifecycle',
    thread,
    run: run(0, 20),
  });
  h.storedPr(105, id, 'open');
  const second = h.pastJob({
    id: 10001,
    branch: 'job/10001',
    title: 'Joining preview lifecycle',
    thread,
    run: run(30, 30),
  });
  h.storedPr(128, second, 'open');
  const visual = await import('./visualapproval.ts');
  visual.record(
    { number: 105, branch: `job/${id}`, author: 'kit', sha: 'preview', files: '["platform/hq/index.html"]' },
    true,
  );
  const card = h.db.prepare('select job from card_merges where pr = ?').get(105) as { job: number };
  assert.ok(card, 'the real card creator records its held work');
  visual.record(
    { number: 128, branch: `job/${second}`, author: 'kit', sha: 'joined', files: '["platform/hq/index.html"]' },
    true,
  );
  const started = Date.now();
  mock.timers.enable({ apis: ['Date'], now: started });
  try {
    const job = await h.claimJob(card.job);
    mock.timers.setTime(started + 5 * MINUTE);
    assert.equal((await h.finish(job)).status, 200);
    h.mergedPr(105, Date.now());
    h.mergedPr(128, Date.now());
    const decisions = await import('./decisions.ts');
    decisions.retireMerge(105);
    decisions.retireMerge(128);
    const shown = await ask(id);
    assert.equal(shown.whole.split.previews, 2.5);
    assert.equal(shown.whole.agent_minutes, 22.5);
    assert.equal(shown.whole.complete, true);
    const joined = await ask(second);
    assert.equal(joined.whole.split.previews, 2.5);
    assert.equal(joined.whole.agent_minutes, 32.5);
  } finally {
    mock.timers.reset();
  }
});

test('preview time shared by separate branches is charged once across their tasks', async () => {
  const first = h.pastJob({ title: 'Shared preview first', run: run(0, 20) });
  const second = h.pastJob({ title: 'Shared preview second', run: run(30, 30) });
  h.storedPr(106, first, 'open');
  h.storedPr(107, second, 'open');
  h.pastJob({ previewFor: [106, 107], run: run(70, 12) });
  h.mergedPr(106, T + 100 * MINUTE);
  h.mergedPr(107, T + 100 * MINUTE);
  const a = await ask(first),
    b = await ask(second);
  assert.equal(a.whole.split.previews, 6);
  assert.equal(b.whole.split.previews, 6);
  assert.equal(a.whole.agent_minutes + b.whole.agent_minutes, 62);
});

test('reading whole task evidence leaves the saved work size and projected review rounds unchanged', async () => {
  const id = h.pastJob({ title: 'Forecast evidence', run: run(0, 20) });
  h.storedPr(108, id, 'open');
  h.pastJob({ kind: 'review', pr: 108, run: run(70, 30) });
  h.mergedPr(108, T + 100 * MINUTE);
  const queued = h.queue({ agent: 'kit', title: 'Forecast evidence' });
  const sizes = await import('./sizes.ts');
  sizes.recordQueued(queued, 'kit', 'Compare whole task evidence', {
    agent_ms: 20 * MINUTE,
    refs: [id],
    why: 'Same work split',
  });
  const predictions = await import('./predictions.ts');
  const forecast = await import('./forecast.ts');
  const before = { size: predictions.sizeHistory(queued), outlook: forecast.play().usual.get(queued) };
  const response = await h.agent(`estimate?q=%23${queued}`, reader.token);
  assert.equal(response.status, 200);
  assert.equal(response.body.jobs[0].whole.agent_minutes, 50);
  assert.equal(response.body.estimate.agent_minutes, 20);
  assert.deepEqual(predictions.sizeHistory(queued), before.size);
  assert.equal(forecast.play().usual.get(queued)?.left_ms, before.outlook?.left_ms);
  h.cancelQueued();
});

test('a later merge on the same branch cannot change an earlier task total', async () => {
  const first = h.pastJob({ title: 'First branch landing', run: run(0, 20) });
  h.storedPr(110, first, 'open');
  h.pastJob({ kind: 'review', pr: 110, run: run(40, 10) });
  h.mergedPr(110, T + 60 * MINUTE);
  const second = h.pastJob({ title: 'Second branch landing', branch: `job/${first}`, run: run(90, 30) });
  // A second pull request on the same branch has the same original branch owner.
  h.storedPr(111, first, 'open');
  h.pastJob({ kind: 'review', pr: 111, run: run(150, 20) });
  h.mergedPr(111, T + 180 * MINUTE);
  assert.equal((await ask(first)).whole.agent_minutes, 30);
  const shown = await ask(second);
  assert.equal(shown.whole.agent_minutes, 50);
  assert.deepEqual(shown.whole.tasks, [second]);
});

test('lost historical preview links are disclosed rather than assigned by a timing guess', async () => {
  const id = h.pastJob({ title: 'Legacy preview', run: run(0, 20) });
  h.storedPr(109, id, 'open');
  h.pastJob({ previewFor: [], run: run(70, 15) });
  h.mergedPr(109, T + 100 * MINUTE);
  const shown = await ask(id);
  assert.equal(shown.whole.agent_minutes, 20);
  assert.equal(shown.whole.complete, false);
  assert.ok(shown.whole.flags.includes('unattributed_previews'));
});
