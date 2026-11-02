// node --test src/featurecost.test.ts (throwaway DATA_DIR): feature costs through the agent and board APIs.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { projectsHarness } from './projects.fixture.ts';
const { h, thread } = await projectsHarness('featurecost');
const reader = await h.start({ agent: 'juno' });
const { recordUsage } = await import('./usage.ts');
const MINUTE = 60_000,
  T = Date.now() - 60 * MINUTE;
const past = (fields: Record<string, unknown>, tokens: number | null, start = T) => {
  const id = h.pastJob({ ...fields, run: { started: start, ended: start + MINUTE } });
  if (tokens !== null) recordUsage({ job: id, engine: 'claude', usage: { models: { model: { input: tokens } } } });
  return id;
};
const change = async (path: string, body: unknown) => h.agent(`threads/${path}`, reader.token, body);
const read = async (id: string) => {
  const answer = await h.agent(`thread?id=${encodeURIComponent(id)}`, reader.token);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body.cost;
};

test('feedback, its reviews and explicit fixes count once under the original feature', async () => {
  const root = thread('drawing'),
    roundA = thread('feeling'),
    roundB = thread('devices');
  const work = past({ thread: root }, 100);
  h.storedPr(601, work, 'open');
  past({ kind: 'review', pr: 601, round: 1 }, 20);
  const fix = past({ fixFor: 601, stage: 'fix', round: 1 }, 30);
  h.storedPr(602, fix, 'open');
  past({ kind: 'review', pr: 602, round: 1 }, 10);
  past({ thread: roundA }, 40);
  past({ thread: roundB }, 50);
  for (const id of [roundA, roundB])
    assert.equal((await change('feature', { id, feature: root, round: 'device review', feedback: true })).status, 200);
  const cost = await read(root);
  assert.equal(cost.used.total.tokens, 250);
  assert.deepEqual(
    Object.fromEntries(Object.entries(cost.used.split).map(([phase, spend]: [string, any]) => [phase, spend.tokens])),
    { work: 100, reviews: 30, fixes: 30, feedback: 90 },
  );
  assert.equal(cost.feedback_rounds, 1);
  assert.equal((await read(roundA)).used.total.tokens, 250);
  assert.equal(cost.approved, null);
  const board = (await h.board('/api/projects')).body;
  assert.equal(board.projects.find((project: any) => project.id === 'game').cost.used.total.tokens, 250);
  const comparison = await h.agent(`estimate?q=%23${work}`, reader.token);
  assert.equal(comparison.body.job.feature_cost.used.total.tokens, 250);
  const cli = await h.hq(reader, 'deliverable', root);
  assert.equal(cli.code, 0, cli.out);
  assert.match(cli.out, /250 tokens/);
  assert.match(cli.out, /board approval not recorded/i);
});

test('expected cost is explicit, authorized, retained on moves and never produced by matching', async () => {
  const root = thread('expected');
  const expected = {
    tokens: { work: 100, reviews: 20, fixes: 10, feedback: 70 },
    seat_weeks: 0.02,
    feedback_rounds: 2,
    refs: [],
    why: 'No close scope yet, visible work needs device feedback',
    confidence: { level: 'low', why: 'No close scope yet, feedback count is uncertain' },
  };
  assert.equal((await read(root)).expected, null);
  assert.equal((await change('cost', { id: root, expected })).status, 200);
  assert.equal((await read(root)).expected.tokens.feedback, 70);
  assert.deepEqual((await read(root)).expected.confidence, expected.confidence);
  assert.equal((await change('cost', { id: root, expected: { ...expected, confidence: null } })).status, 400);
  assert.equal((await change('cost', { id: root, expected: { ...expected, seat_weeks: -1 } })).status, 400);
  const outsider = await h.start({ agent: 'kit' });
  assert.equal((await h.agent('threads/cost', outsider.token, { id: root, expected })).status, 403);
  const moved = await h.agent('threads/move', reader.token, { id: root, project: 'shop' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal((await read(root)).expected.tokens.work, 100);
});

test('membership mutations authorize the resolved feature and every rewritten member before writing', async () => {
  const owner = await h.start({ agent: 'wren' });
  const root = thread('protected-root', 'shop'),
    member = thread('owned-member'),
    source = thread('owned-source'),
    child = thread('protected-child', 'shop'),
    destination = thread('owned-destination');
  await change('feature', { id: member, feature: root, round: 'shared', feedback: true });
  const before = await read(root);
  const expected = {
    tokens: { work: 100, reviews: 20, fixes: 10, feedback: 0 },
    seat_weeks: null,
    feedback_rounds: 0,
    refs: [],
    why: 'No comparable feature',
    confidence: { level: 'low', why: 'No close examples' },
  };
  for (const [path, body] of [
    ['cost', { id: member, expected }],
    ['milestone', { id: member, milestone: 'approved', at: new Date().toISOString(), evidence: 'Observed' }],
    ['feature', { id: source, feature: member, round: 'attempt', feedback: true }],
    ['feature', { id: member, feature: destination, feedback: false }],
  ] as const)
    assert.equal((await h.agent(`threads/${path}`, owner.token, body)).status, 403, path);
  assert.deepEqual(await read(root), before);
  assert.equal((await read(source)).feature, source);
  await change('feature', { id: child, feature: source, feedback: false });
  const sourceBefore = await read(source);
  assert.equal(
    (await h.agent('threads/feature', owner.token, { id: source, feature: destination, feedback: false })).status,
    403,
  );
  assert.deepEqual(await read(source), sourceBefore);
  assert.equal((await change('feature', { id: source, feature: destination, feedback: false })).status, 200);
  assert.equal((await read(child)).feature, destination);
  assert.equal((await change('cost', { id: member, expected })).status, 200);
  assert.deepEqual((await read(root)).expected.confidence, expected.confidence);
});

test('feedback requires an explicit nonempty board label and initial links have no round', async () => {
  const root = thread('labels-root'),
    member = thread('labels-member');
  for (const round of [undefined, null, '', '  ', 42, {}]) {
    assert.equal((await change('feature', { id: member, feature: root, round, feedback: true })).status, 400);
    assert.equal((await read(member)).feature, member);
  }
  for (const label of ['', '   ']) {
    const cli = await h.hq(reader, 'deliverable', 'feedback', member, root, '--round', label);
    assert.notEqual(cli.code, 0);
  }
  const cli = await h.hq(reader, 'deliverable', 'feature', member, root);
  assert.equal(cli.code, 0, cli.out);
  const { featurePlan } = await import('./featureplan.ts');
  assert.deepEqual(featurePlan().membership.get(member), { feature: root, feedback: false, round: '' });
  assert.equal((await read(root)).feedback_rounds, 0);
});

test('milestone files supply observations without replacing command identity or speaker', async () => {
  const other = thread('other-milestone');
  const file = `${mkdtempSync(`${tmpdir()}/milestone-file-`)}/milestone.json`;
  for (const [suffix, as] of [
    ['identity', undefined],
    ['speaker', 'kit'],
  ]) {
    const selected = thread(`chosen-${suffix}`);
    writeFileSync(
      file,
      JSON.stringify({
        id: other,
        milestone: 'approved',
        as,
        at: new Date().toISOString(),
        evidence: 'Observed delivery',
      }),
    );
    const cli = await h.hq(reader, 'deliverable', 'milestone', selected, 'delivered', file);
    assert.equal(cli.code, 0, cli.out);
    assert.ok((await read(selected)).first_delivery);
    assert.equal((await read(selected)).approved, null);
  }
  assert.equal((await read(other)).approved, null);
  assert.equal((await read(other)).first_delivery, null);
});

test('first delivery and approval are observed separately, with measured post-delivery tokens', async () => {
  const root = thread('approval');
  const at = new Date(Date.now() - MINUTE).toISOString();
  assert.equal(
    (await change('milestone', { id: root, milestone: 'delivered', at, evidence: 'Preview placed on the desk' }))
      .status,
    200,
  );
  past({ thread: root }, 90);
  assert.equal((await read(root)).after_delivery.total.tokens, 90);
  assert.equal((await read(root)).approved, null);
  assert.equal(
    (
      await change('milestone', {
        id: root,
        milestone: 'approved',
        at: new Date().toISOString(),
        evidence: 'Board approved the preview on its call',
      })
    ).status,
    200,
  );
  assert.ok((await read(root)).approved);
});

test('missing token reports and seat meters stay unknown rather than becoming free work', async () => {
  const root = thread('unreported');
  past({ thread: root }, null);
  const cost = await read(root);
  assert.equal(cost.used.missing_usage, 1);
  assert.equal(cost.used.total.seat_weeks, null);
});

test('a seat meter gain is shared once across concurrent features and reset drops are excluded', async () => {
  const first = thread('meter-a'),
    second = thread('meter-b');
  const start = Date.now();
  mock.timers.enable({ apis: ['Date'], now: start });
  try {
    const report = (week: number, reset: number) =>
      h.worker('seat', { seat: 'meter-seat', engine: 'claude', state: 'ready', week, weekResets: reset });
    const reset = start + 7 * 24 * 60 * MINUTE;
    await report(0.1, reset);
    h.pastJob({ thread: first, run: { started: start, ended: start + 10 * MINUTE, seat: 'meter-seat' } });
    h.pastJob({ thread: second, run: { started: start, ended: start + 10 * MINUTE, seat: 'meter-seat' } });
    mock.timers.setTime(start + 10 * MINUTE);
    await report(0.2, reset);
    const [a, b] = await Promise.all([read(first), read(second)]);
    assert.ok(Math.abs(a.used.total.seat_weeks - 0.05) < 1e-9);
    assert.ok(Math.abs(b.used.total.seat_weeks - 0.05) < 1e-9);
    assert.equal(a.used.missing_usage, 1);
    await report(0.2, reset);
    assert.ok(Math.abs((await read(first)).used.total.seat_weeks - 0.05) < 1e-9);
    mock.timers.setTime(start + 20 * MINUTE);
    await report(0.01, reset + 7 * 24 * 60 * MINUTE);
    assert.ok(Math.abs((await read(first)).used.total.seat_weeks - 0.05) < 1e-9);
  } finally {
    mock.timers.reset();
  }
});

test('post-merge review follow-ups stay in their source feature and shared reviews are charged once', async () => {
  const root = thread('shared-a'),
    other = thread('shared-b'),
    repairs = thread('review-repairs');
  const first = past({ thread: root }, 100);
  past({ thread: other, branch: `job/${first}` }, 100);
  h.storedPr(610, first, 'open');
  past({ kind: 'review', pr: 610, round: 1 }, 40);
  const fix = past({ thread: repairs, followupFor: 610 }, 60);
  h.storedPr(611, fix, 'open');
  past({ kind: 'review', pr: 611, round: 1 }, 20);
  const a = await read(root),
    b = await read(other);
  assert.equal(a.used.total.tokens + b.used.total.tokens, 320);
  assert.equal(a.used.split.fixes.tokens + b.used.split.fixes.tokens, 60);
});

test("a follow-up of a follow-up joins the chain's root feature", async () => {
  // (the second follow-up recorded first, on the lower pull request and named before the first and its root: rows in
  // any of those orders meet it first)
  const root = thread('chain-z'),
    first = thread('chain-y'),
    second = thread('chain-x');
  h.storedPr(621, past({ thread: root }, 100), 'open');
  past({ thread: second, followupFor: 620 }, 20);
  h.storedPr(620, past({ thread: first, followupFor: 621 }, 30), 'open');
  for (const id of [first, second]) assert.equal((await read(id)).feature, root);
  assert.equal((await read(root)).used.total.tokens, 150);
});

test('a carried session adds only its feedback increment to the feature', async () => {
  const root = thread('carried'),
    feedback = thread('carried-round');
  const work = past({ thread: root }, null),
    repair = past({ thread: feedback }, null);
  const usage = (input: number, resumed: boolean) => ({ models: { model: { input } }, resumed });
  recordUsage({ job: work, engine: 'claude', session: 'carried-feature', usage: usage(100, false) });
  recordUsage({ job: repair, engine: 'claude', session: 'carried-feature', usage: usage(140, true) });
  await change('feature', { id: feedback, feature: root, round: '1.1', feedback: true });
  const cost = await read(root);
  assert.equal(cost.used.total.tokens, 140);
  assert.equal(cost.used.split.feedback.tokens, 40);
});

test('a report from one run leaves later unreported work incomplete in feature and task costs', async () => {
  const root = thread('partial-runs');
  const job = h.pastJob({
    thread: root,
    runs: [
      { started: T, ended: T + MINUTE },
      { started: T + 10 * MINUTE, ended: T + 11 * MINUTE },
    ],
    merged: T + 20 * MINUTE,
  });
  mock.timers.enable({ apis: ['Date'], now: T + 2 * MINUTE });
  try {
    recordUsage({ job, engine: 'claude', usage: { models: { model: { input: 20 } } } });
  } finally {
    mock.timers.reset();
  }
  const cost = await read(root);
  assert.equal(cost.used.total.tokens, 20);
  assert.equal(cost.used.missing_usage, 1);
  const compared = await h.agent(`estimate?q=%23${job}`, reader.token);
  assert.equal(compared.body.job.whole.cost.missing_usage, 1);
  await change('milestone', {
    id: root,
    milestone: 'delivered',
    at: new Date(T + 5 * MINUTE).toISOString(),
    evidence: 'Observed delivery',
  });
  assert.equal((await read(root)).after_delivery.missing_usage, 1);
});

test('a landing-only retry closes token coverage without adding to recorded spend', async t => {
  const root = thread('landing-only');
  t.mock.timers.enable({ apis: ['Date'], now: T + 30 * MINUTE });
  const job = await h.start({ agent: 'juno', thread: root, engine: 'landing-only' });
  t.mock.timers.setTime(T + 31 * MINUTE);
  const snagged = await h.worker('finish', {
    job: job.id,
    seat: job.seat,
    status: 'snagged',
    session: 'landing-session',
    landing: { summary: 'Work complete', result: 'Work complete' },
    usage: { models: { model: { input: 5000 } } },
  });
  assert.equal(snagged.status, 200);
  t.mock.timers.setTime(T + 37 * MINUTE);
  assert.equal((await h.claim('landing-only', { seat: job.seat }))?.id, job.id);
  t.mock.timers.setTime(T + 38 * MINUTE);
  const landed = await h.worker('finish', { job: job.id, seat: job.seat, status: 'done', no_engine: true });
  assert.equal(landed.status, 200);
  const cost = await read(root);
  assert.equal(cost.used.total.tokens, 5000);
  assert.equal(cost.used.missing_usage, 0);
  const compared = await h.agent(`estimate?q=%23${job.id}`, reader.token);
  assert.equal(compared.body.job.whole.cost.total.tokens, 5000);
  assert.equal(compared.body.job.whole.cost.missing_usage, 0);
  await change('milestone', {
    id: root,
    milestone: 'delivered',
    at: new Date(T + 35 * MINUTE).toISOString(),
    evidence: 'Observed delivery',
  });
  const interval = (await read(root)).after_delivery;
  assert.equal(interval.total.tokens, 0);
  assert.equal(interval.missing_usage, 0);
  const { jobSpend } = await import('./costspend.ts');
  assert.equal(jobSpend(job.id, T + 35 * MINUTE, T + 37.5 * MINUTE).reported, false);
});

test('held preview shares propagate through their reviews and separate fix branches', async () => {
  const first = thread('held-first'),
    second = thread('held-second'),
    other = thread('held-other');
  const a = past({ thread: first }, 100);
  past({ thread: second, branch: `job/${a}` }, 100);
  const b = past({ thread: other }, 100);
  h.storedPr(680, a, 'open');
  h.storedPr(681, b, 'open');
  const preview = past({ previewFor: [680, 681] }, 80);
  h.storedPr(682, preview, 'open');
  past({ branch: `job/${preview}`, stage: 'fix' }, 8);
  past({ kind: 'review', pr: 682, round: 1 }, 40);
  const fix = past({ fixFor: 682, stage: 'fix', round: 1 }, 20);
  h.storedPr(683, fix, 'open');
  past({ kind: 'review', pr: 683, round: 1 }, 12);
  const costs = await Promise.all([read(first), read(second), read(other)]);
  assert.deepEqual(
    costs.map(cost => cost.used.total.tokens),
    [140, 140, 180],
  );
  assert.deepEqual(
    costs.map(cost => cost.used.split.reviews.tokens),
    [33, 33, 66],
  );
  assert.deepEqual(
    costs.map(cost => cost.used.split.fixes.tokens),
    [7, 7, 14],
  );
  assert.equal(
    costs.reduce((sum, cost) => sum + cost.used.total.tokens, 0),
    460,
  );
  const comparison = await h.agent(`estimate?q=%23${a}`, reader.token);
  assert.deepEqual(comparison.body.job.whole.cost.split, costs[0].used.split);
});

// Every thread, estimate and projects list builds the book once and answers each report from it; hq-speed/book.ts
// measures its time on HQ-sized data
test('one cost book answers each thread and the project as their own reads do', async () => {
  const { featureCosts } = await import('./featurecost.ts');
  const root = thread('read-once');
  const work = past({ thread: root }, 10);
  h.storedPr(690, work, 'open');
  past({ previewFor: [690] }, 5);
  const costs = featureCosts();
  assert.equal(costs.report(root).used.total.tokens, 15);
  assert.deepEqual(costs.report(root), await read(root));
  const board = (await h.board('/api/projects')).body;
  assert.deepEqual(costs.project('game').used, board.projects.find((project: any) => project.id === 'game').cost.used);
});
