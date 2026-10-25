// node --test src/timing.test.ts (uses a throwaway DATA_DIR).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('timing');
const { pastJobs, cleanPastJobs, picksFor, rawPicksFor, timingAudit } = await import('./matching.ts');
const ended = Date.now() - 60_000;
const started = ended - 10 * 60_000;

test('comparable jobs exclude complicated timings while the audit retains and explains them', () => {
  const clean = h.pastJob({ title: 'Paint the harbour', run: { started, ended } });
  const rebuilt = h.pastJob({ title: 'Paint the harbour', run: { started, ended, outcome: 'rebuilt', seat: null } });
  const yielded = h.pastJob({ title: 'Paint the harbour', run: { started, ended, outcome: 'yielded' } });
  const replacement = h.pastJob({ title: 'Paint the harbour', run: { started, ended }, instead_of: clean });
  const pool = pastJobs();
  assert.deepEqual(
    cleanPastJobs(pool).map(job => job.id),
    [clean],
  );
  const selected = picksFor({ title: 'Paint the harbour', origin: 'work' }, pool);
  assert.deepEqual(
    selected.picks.map(job => job.id),
    [clean],
  );
  assert.equal(rawPicksFor({ title: 'Paint the harbour', origin: 'work' }, pool).picks.length, 4);
  assert.deepEqual(pool.find(job => job.id === rebuilt)?.timing_flags, ['unknown_seat', 'rebuilt']);
  assert.deepEqual(pool.find(job => job.id === yielded)?.timing_flags, ['yielded']);
  assert.deepEqual(pool.find(job => job.id === replacement)?.timing_flags, ['replacement']);
  assert.deepEqual(timingAudit(pool), {
    total: 4,
    excluded: 3,
    clean: 1,
    reasons: { unknown_seat: 1, rebuilt: 1, yielded: 1, replacement: 1 },
  });
});

test("only an estimate's references read: the same rows as in the whole pool, and nothing else", () => {
  const clean = h.pastJob({ title: 'Read the references', run: { started, ended } });
  const rebuilt = h.pastJob({ title: 'Read the references', run: { started, ended, outcome: 'rebuilt', seat: null } });
  h.pastJob({ title: 'Not a reference', run: { started, ended } });
  const whole = pastJobs().filter(job => job.id === clean || job.id === rebuilt);
  assert.deepEqual(pastJobs([rebuilt, clean, 999_999]), whole);
  assert.deepEqual(pastJobs([]), []);
});

test('zero or reversed run intervals cannot become clean comparison times', () => {
  const zero = h.pastJob({ run: { started, ended: started } });
  const reversed = h.pastJob({ run: { started: ended, ended: started } });
  const pool = pastJobs();
  for (const id of [zero, reversed]) assert.deepEqual(pool.find(job => job.id === id)?.timing_flags, ['invalid_time']);
  assert.equal(
    cleanPastJobs(pool).some(job => job.id === zero || job.id === reversed),
    false,
  );
});

test('private jobs are excluded independently of timing quality', () => {
  const privateJob = h.pastJob({ run: { started, ended }, customers: 1 });
  const pool = pastJobs();
  assert.deepEqual(pool.find(job => job.id === privateJob)?.timing_flags, []);
  assert.equal(
    cleanPastJobs(pool).some(job => job.id === privateJob),
    false,
  );
});

test('the audit counts done jobs with no recorded runs as excluded', async () => {
  const reader = await h.start({ agent: 'bolt', title: 'Audit timing', kind: 'chat' });
  const before = await h.agent('estimate/audit', reader.token);
  h.pastJob({ title: 'Completed without a recorded run' });
  const after = await h.agent('estimate/audit', reader.token);
  assert.equal(after.status, 200);
  assert.equal(after.body.total, before.body.total + 1);
  assert.equal(after.body.excluded, before.body.excluded + 1);
  assert.equal(after.body.reasons.missing_runs, before.body.reasons.missing_runs + 1);
});
