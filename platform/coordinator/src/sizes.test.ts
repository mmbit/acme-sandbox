// node --test src/sizes.test.ts (uses a throwaway DATA_DIR).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { git } from './fixture.ts';

const h = await harness('sizes');
const predictions = await import('./predictions.ts');
const merged = await import('./merged.ts');
const sizes = await import('./sizes.ts');
const MIN = 60_000,
  HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());
test.afterEach(() => h.cancelQueued());

const harbour = [30, 40, 50].map(minutes =>
  h.pastJob({
    title: `Paint the harbour map ${minutes}`,
    prompt: `Paint ${minutes} harbour tiles`,
    result: `${minutes} tiles checked`,
    run: { started: T0 - 48 * HOUR - minutes * MIN, ended: T0 - 48 * HOUR },
    merged: T0 - 47 * HOUR,
    files: ['kits/map/map.js'],
  }),
);
const sound = h.pastJob({
  title: 'Mix the tavern sounds',
  run: { started: T0 - 49 * HOUR, ended: T0 - 48 * HOUR },
  merged: T0 - 47 * HOUR,
});
let planner: Awaited<ReturnType<typeof h.start>>;
test.beforeEach(async () => {
  await h.capacity({ claude: 1, codex: 1 });
  planner = await h.start({ agent: 'juno', title: 'Planning', kind: 'chat' });
});
const request = {
  agent: 'kit',
  title: 'Paint the harbour map in spring',
  prompt: 'Paint 60 tiles and check them',
  by: 'none',
  size: '1h',
  refs: [harbour[0], harbour[2]],
  why: 'Twice the first map, with ten more tiles than the last',
};
const estimate = async (job: number) => (await h.agent(`estimate?q=%23${job}`, planner.token)).body;

test('the queuer saves scope references once and every play keeps that estimate', async () => {
  const response = await h.agent('job', planner.token, request);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const job = response.body.id;
  const before = sizes.history(job);
  predictions.sweep();
  const firstOutlook = h.db.prepare('select start, done, eta, outlook_saved from predictions where job = ?').get(job)!;
  assert.equal(firstOutlook.outlook_saved, 1);
  assert.equal(typeof firstOutlook.eta, 'number');
  assert.deepEqual(
    [before[0].by, before[0].agent_ms, before[0].refs, before[0].why],
    ['juno', 60 * MIN, request.refs, request.why],
  );
  assert.equal(predictions.latest(job)!.agent_ms, 60 * MIN);
  assert.equal((await estimate(job)).outlook.left_minutes, 60);
  h.jobs.extendJob(job, 'juno', 'Add a lighthouse');
  mock.timers.tick(2 * HOUR);
  predictions.sweep();
  predictions.outlooks();
  predictions.outlooks();
  assert.deepEqual(sizes.history(job), before);
  assert.deepEqual(
    h.db.prepare('select start, done, eta, outlook_saved from predictions where job = ?').get(job),
    firstOutlook,
  );
  assert.equal(predictions.latest(job)!.agent_ms, 60 * MIN);
  assert.deepEqual((await h.worker('sizes/claim')).body, {});
  assert.equal(
    (await h.worker('sizes/answer', { job, brief: before[0].brief, result: { middle_minutes: 120 } })).status,
    410,
  );
  assert.deepEqual(sizes.history(job), before);
});

test('missing estimates and invalid references queue nothing', async () => {
  const before = h.db.prepare('select count(*) n from jobs').get()!.n;
  const raw = await h.send(
    '/api/agent/job',
    { authorization: `Bearer ${planner.token}` },
    { ...request, size: undefined, code: 'MISSING' },
  );
  assert.equal(raw.status, 400);
  for (const change of [{ size: '2 hours' }, { why: '' }, { refs: [999999] }, { refs: ['1'] }, { size: '0m' }]) {
    const response = await h.agent('job', planner.token, { ...request, ...change });
    assert.equal(response.status, 400, JSON.stringify(response.body));
  }
  assert.equal(h.db.prepare('select count(*) n from jobs').get()!.n, before);
});

test('only the CEO changes a saved size and its reason stays in history', async () => {
  const job = (await h.agent('job', planner.token, request)).body.id;
  for (const agent of ['kit', 'wren', 'moss']) {
    const actor = await h.start({ agent, title: 'Checking size', kind: 'chat' });
    assert.equal((await h.agent('sizes', actor.token, { job, time: '2h', why: 'Scope grew' })).status, 403);
  }
  assert.equal((await h.agent('sizes', planner.token, { job, time: '2h', why: '' })).status, 400);
  assert.equal((await h.agent('sizes', planner.token, { job, time: '2h', why: 'Scope grew' })).status, 200);
  assert.equal(predictions.latest(job)!.agent_ms, 120 * MIN);
  assert.deepEqual(
    sizes.history(job).map(s => s.agent_ms),
    [120 * MIN, 60 * MIN],
  );
});

test('comparisons expose scopes and recorded changes without choosing a new estimate', async () => {
  const found = await h.agent('estimate?q=harbour', planner.token);
  assert.equal(found.status, 200);
  assert.equal(found.body.estimate, undefined);
  const first = found.body.jobs.find((j: { id: number }) => j.id === harbour[0]);
  assert.equal(first.brief, 'Paint 30 harbour tiles');
  assert.equal(first.report, '30 tiles checked');
  assert.deepEqual(first.changed_files, ['kits/map/map.js']);
  assert.deepEqual(first.timing_quality, []);
  assert.ok(found.body.quality.total >= 4);
});

test('automatic work saves its measured default when queued', () => {
  const job = h.queue({ agent: 'kit', title: 'Paint the harbour map' });
  const initial = predictions.latest(job)!;
  assert.ok(initial);
  h.pastJob({
    title: 'Paint the harbour map',
    run: { started: Date.now() - 20 * HOUR, ended: Date.now() - 10 * HOUR },
  });
  predictions.sweep();
  predictions.outlooks();
  assert.deepEqual(predictions.latest(job), initial);
});

test('legacy completed work still in review gets one saved default across later plays', async () => {
  const job = h.pastJob({ title: 'Paint the harbour map', run: { started: T0 - HOUR, ended: T0 - MIN } });
  h.storedPr(8001, job, 'open');
  const before = (await h.agent('estimate/calibration', planner.token)).body.sizes.count;
  assert.equal(predictions.latest(job), undefined);
  predictions.outlooks();
  const initial = predictions.latest(job);
  assert.ok(initial);
  assert.equal(
    (await h.agent('estimate/calibration', planner.token)).body.sizes.count,
    before,
    'a default made after completion is not a prediction to score',
  );
  h.pastJob({ title: 'Paint the harbour map', run: { started: T0 - 10 * HOUR, ended: T0 } });
  mock.timers.tick(2 * HOUR);
  predictions.outlooks();
  assert.deepEqual(predictions.latest(job), initial);
});

let mainLines = 0;
function mergePr(pr: number, lines: number, gone = 0) {
  if (!mainLines) {
    mainLines = 50;
    git(h.repo, 'init', '-q', '-b', 'main');
    writeFileSync(`${h.repo}/main.txt`, 'main\n'.repeat(mainLines));
    git(h.repo, 'add', 'main.txt');
    git(h.repo, 'commit', '-q', '-m', 'The test company');
  }
  git(h.repo, 'checkout', '-q', '-b', `pr-${pr}`);
  writeFileSync(`${h.repo}/pr-${pr}.txt`, 'new\n'.repeat(lines));
  writeFileSync(`${h.repo}/main.txt`, 'main\n'.repeat((mainLines -= gone)));
  git(h.repo, 'add', `pr-${pr}.txt`, 'main.txt');
  git(h.repo, 'commit', '-q', '-m', `Pull request #${pr}`);
  git(h.repo, 'checkout', '-q', 'main');
  git(h.repo, 'merge', '-q', '--no-ff', '-m', `Merge PR #${pr} after review (round 1)`, `pr-${pr}`);
}

test('comparisons show measured changed lines and leave unread merges unknown', async () => {
  const prOf = (job: number) =>
    (h.db.prepare('select number from prs where branch = ?').get(`job/${job}`) as { number: number }).number;
  const [first, second, third] = harbour.map(prOf);
  mergePr(first, 30, 2);
  mergePr(third, 600, 4);
  mergePr(999, 5); // (a pull request this company's record doesn't have)
  assert.equal(await merged.read(), 3, 'every merge in the history');
  assert.equal(await merged.read(), 0, 'nothing new since');
  // (a commit only titled like a merge, with one parent, isn't one)
  writeFileSync(`${h.repo}/pr-${second}.txt`, 'squashed\n');
  git(h.repo, 'add', `pr-${second}.txt`);
  git(h.repo, 'commit', '-q', '-m', `Merge PR #${second} squashed`);
  mergePr(prOf(sound), 7);
  assert.equal(await merged.read(), 1, 'only the merges since the last read');
  const found = (await h.agent('estimate?q=harbour&limit=20', planner.token)).body;
  const line = (id: number) => found.jobs.find((j: { id: number }) => j.id === id);
  assert.equal(line(harbour[0]).added, 30);
  assert.equal(line(harbour[0]).removed, 2);
  assert.equal(line(harbour[2]).added, 600);
  assert.equal(line(harbour[1]).added, null);
});
