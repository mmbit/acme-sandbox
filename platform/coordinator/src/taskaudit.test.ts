// node --test src/taskaudit.test.ts (throwaway DATA_DIR): first-estimate cohorts at the API and real CLI boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { harness } from './harness.ts';

const h = await harness('taskaudit');
const sizes = await import('./sizes.ts');
const predictions = await import('./predictions.ts');
const MINUTE = 60_000;
const T = Date.now() - 3 * 24 * 60 * MINUTE;
const at = (minute: number) => new Date(T + minute * MINUTE).toISOString();
const run = (minute: number, minutes: number) => ({
  started: T + minute * MINUTE,
  ended: T + (minute + minutes) * MINUTE,
});
const reader = await h.start({ agent: 'bolt', title: 'Read original-task evidence' });
const until = at(600);
const ask = async (mode = 'accuracy', cutoff = until) => {
  const response = await h.agent(`estimate/${mode}?days=1&until=${encodeURIComponent(cutoff)}`, reader.token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.tasks;
};
function caller(job: number, minute: number, minutes: number, revised = false) {
  sizes.record(
    {
      job,
      by: 'juno',
      agent_ms: minutes * MINUTE,
      low_ms: null,
      high_ms: minutes * MINUTE,
      refs: [],
      why: 'Same scope as the earlier work',
      brief: 'scope-hash',
      revised,
    },
    T + minute * MINUTE,
  );
}

test('first caller estimates survive revisions and shared work, rulings, separate fixes and syncs are allocated once', async () => {
  const first = h.pastJob({
    title: 'Original estuary',
    created: T - 100 * MINUTE,
    runs: [run(0, 10), run(100, 10)],
    sized: 200 * MINUTE,
    slowSized: null,
  });
  const second = h.pastJob({ title: 'Other estuary', branch: `job/${first}`, run: run(20, 60), sized: 60 * MINUTE });
  caller(first, -100, 40);
  caller(first, 105, 90, true);
  h.storedPr(500, first, 'open');
  h.pastJob({ kind: 'review', pr: 500, run: run(150, 20) });
  h.pastJob({ kind: 'consolidate', stage: 'ruling', pr: 500, run: run(180, 10) });
  const fix = h.pastJob({ fixFor: 500, run: run(200, 15), sized: 1000 * MINUTE });
  h.storedPr(501, fix, 'open');
  h.pastJob({ kind: 'review', pr: 501, run: run(230, 5) });
  h.mergedPr(501, T + 250 * MINUTE);
  h.pastJob({ stage: 'fix', branch: `job/${first}`, pr: 500, run: run(280, 8) });
  const preview = h.pastJob({ previewFor: [500], run: run(310, 8) });
  h.mergedPr(500, T + 400 * MINUTE);
  const saved = () => ({
    caller: sizes.history(first),
    prediction: h.db.prepare('select * from predictions where job = ?').get(first),
  });
  const before = saved();
  const audit = await ask();
  const row = audit.rows.find((r: any) => r.id === first);
  assert.deepEqual(
    [row.first_estimate.source, row.first_estimate.agent_ms, row.first_estimate.timing],
    ['caller', 40 * MINUTE, 'before_work'],
  );
  assert.deepEqual(
    [row.revisions[0].agent_ms, row.revisions[0].timing, row.revisions[0].revised],
    [90 * MINUTE, 'during_work', true],
  );
  assert.equal(row.prediction.agent_ms, 200 * MINUTE);
  assert.equal(row.saved_sizes.length, 2);
  assert.equal(row.actual_work_minutes, 20, 'the ninety-minute gap between runs stays out');
  assert.equal(row.work_miss_minutes, -20);
  assert.deepEqual(row.whole.split, { work: 20, reviews: 17.5, fixes: 7.5, syncs: 4, previews: 4 });
  assert.equal(row.whole.agent_minutes, 53);
  assert.equal(row.whole.complete, true);
  assert.deepEqual(row.whole.tasks, [first, second]);
  assert.equal(audit.rows.find((r: any) => r.id === fix).role, 'followup');
  assert.equal(audit.rows.find((r: any) => r.id === preview).role, 'followup');
  assert.equal(audit.coverage.original_tasks, 2);
  assert.equal(audit.coverage.followup_views, 3);
  assert.equal(audit.overhead.agent_minutes, 66);
  assert.equal(
    audit.rows
      .filter((r: any) => r.role === 'original')
      .reduce((sum: number, r: any) => sum + r.whole.agent_minutes, 0),
    146,
  );
  assert.deepEqual(await ask('calibration'), audit);
  assert.deepEqual(saved(), before);
  const directory = mkdtempSync(`${tmpdir()}/taskaudit-export-`);
  for (const mode of ['accuracy', 'calibration']) {
    const path = `${directory}/${mode}.json`;
    const cli = await h.hq(reader, 'estimate', `--${mode}`, '--days', '1', '--until', until, '--save', path);
    assert.equal(cli.code, 0, cli.out);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).tasks, audit);
    assert.match(cli.out, /First saved work estimates against whole tasks/);
    assert.match(cli.out, /Follow-up views are excluded from original-task totals/);
    assert.match(cli.out, /Phases: work 20 min/);
  }
});

test('uncapped exports retain missing estimates, missing runs, late estimates, unmerged tasks and incomplete previews', async () => {
  for (let i = 0; i < 25; i++) h.pastJob({ title: `Census task ${i}`, run: run(410, 1), sized: MINUTE });
  const missing = h.pastJob({ title: 'No ledger runs', created: T + 410 * MINUTE, finished: T + 420 * MINUTE });
  const late = h.pastJob({ title: 'Estimated after completion', run: run(420, 2) });
  predictions.recordQueued(late, T + 500 * MINUTE);
  const during = h.pastJob({ title: 'Estimated during work', run: run(430, 10) });
  caller(during, 435, 15);
  const root = h.pastJob({ title: 'Incomplete preview evidence', run: run(440, 10), sized: 10 * MINUTE });
  h.storedPr(502, root, 'open');
  h.pastJob({ previewFor: [502], created: T + 460 * MINUTE, finished: T + 470 * MINUTE });
  h.mergedPr(502, T + 480 * MINUTE);
  const unmerged = h.pastJob({ title: 'Still in review', run: run(450, 10), sized: MINUTE });
  h.storedPr(503, unmerged, 'open');
  h.pastJob({
    title: 'Private customer scope',
    customers: 1,
    prompt: 'customer-secret',
    run: run(480, 1),
    sized: MINUTE,
  });
  h.pastJob({
    title: 'Private credential scope',
    about_keys: 1,
    prompt: 'credential-secret',
    run: run(490, 1),
    sized: MINUTE,
  });
  const audit = await ask();
  assert.ok(audit.rows.length > 20);
  const noRuns = audit.rows.find((r: any) => r.id === missing);
  assert.equal(noRuns.first_estimate, null);
  assert.ok(noRuns.timing_quality.includes('missing_runs'));
  assert.equal(noRuns.whole.complete, false);
  assert.equal(audit.rows.find((r: any) => r.id === late).first_estimate.timing, 'after_completion');
  assert.equal(audit.rows.find((r: any) => r.id === during).first_estimate.timing, 'during_work');
  assert.ok(audit.rows.find((r: any) => r.id === root).whole.flags.includes('missing_runs'));
  assert.equal(audit.rows.find((r: any) => r.id === unmerged).unmerged, true);
  assert.equal(audit.coverage.private_tasks, 2);
  assert.ok(audit.coverage.missing_estimates >= 1);
  assert.ok(audit.coverage.incomplete_totals >= 3);
  assert.ok(audit.coverage.unmerged_tasks >= 1);
  assert.equal(audit.coverage.estimate_timing.after_completion, 1);
  assert.equal(audit.coverage.estimate_timing.during_work, 1);
  assert.equal(audit.coverage.timing_reasons.resumed, 1);
  assert.doesNotMatch(JSON.stringify(audit), /Private customer|Private credential|customer-secret|credential-secret/);
  const path = `${mkdtempSync(`${tmpdir()}/taskaudit-all-`)}/all.json`;
  const cli = await h.hq(reader, 'estimate', '--accuracy', '--days', '1', '--until', until, '--save', path);
  assert.equal(cli.code, 0, cli.out);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).tasks.rows.length, audit.rows.length);
  assert.match(cli.out, /Census task 24/);
});

test('own completion selects a dated cohort and the cutoff bounds costs before a later landing', async () => {
  const id = h.pastJob({ title: 'Completion before cutoff, landing later', run: run(700, 10), sized: 10 * MINUTE });
  h.storedPr(504, id, 'open');
  h.pastJob({ kind: 'review', pr: 504, run: run(720, 20) });
  h.pastJob({ kind: 'consolidate', pr: 504, run: run(760, 5) });
  h.mergedPr(504, T + 800 * MINUTE);
  h.pastJob({ title: 'At the exclusive cutoff', run: run(725, 5) });
  const audit = await ask('accuracy', at(730));
  const row = audit.rows.find((r: any) => r.id === id);
  assert.equal(audit.window.selection, 'own_completion');
  assert.equal(row.whole.agent_minutes, 20);
  assert.equal(row.whole.split.reviews, 10);
  assert.equal(row.whole.complete, false);
  assert.equal(row.unmerged, true);
  assert.ok(!audit.rows.some((r: any) => r.title === 'At the exclusive cutoff'));
  assert.ok(!(await ask()).rows.some((r: any) => r.id === id));
  assert.equal((await ask('accuracy', at(850))).rows.find((r: any) => r.id === id).whole.agent_minutes, 35);
  assert.equal((await h.agent('estimate/accuracy?until=not-a-date', reader.token)).status, 400);
  assert.equal((await h.agent(`estimate/accuracy?until=${at(730).slice(0, -1)}`, reader.token)).status, 400);
  assert.equal((await h.agent('estimate/calibration?days=0', reader.token)).status, 400);
});

test('carry audit exports and printers retain subminute estimates, revisions, predictions and misses', async () => {
  const id = h.pastJob({
    title: 'Subminute carry evidence',
    carry: 'c'.repeat(40),
    created: T + 500 * MINUTE,
    run: run(510, 0.3),
    sized: 0.5 * MINUTE,
  });
  caller(id, 500, 0.6);
  caller(id, 510.1, 0.4, true);
  for (const mode of ['accuracy', 'calibration']) {
    const audit = await ask(mode);
    const row = audit.rows.find((r: any) => r.id === id);
    assert.equal(row.actual_work_minutes, 0.3);
    assert.equal(row.work_miss_minutes, -0.3);
    assert.equal(audit.carry_checks.median_factor, 2);
    assert.equal(audit.carry_checks.sum_ratio, 2);
    const cli = await h.hq(reader, 'estimate', `--${mode}`, '--days', '1', '--until', until);
    assert.equal(cli.code, 0, cli.out);
    assert.match(cli.out, /36 sec from caller, by juno/);
    assert.match(cli.out, /18 sec under estimate/);
    assert.match(cli.out, /Later revision: 24 sec from caller/);
    assert.match(cli.out, /Default prediction: 30 sec/);
  }
});
