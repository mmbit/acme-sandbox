// node --test src/pastpool.test.ts   (uses a throwaway DATA_DIR): the done work the server keeps for its plays, read a
// slice at a time, is the done work a whole read gives, and is read again within the hour after its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

const h = await harness('pastpool');
const sizes = await import('./sizes.ts');
const matching = await import('./matching.ts');
const sizerbias = await import('./sizerbias.ts');
const forecast = await import('./forecast.ts');
const pastpool = await import('./pastpool.ts');
const MIN = 60_000,
  HOUR = 60 * MIN,
  DAY = 24 * HOUR;
const guess = { by: 'juno', agent_ms: 20 * MIN, low_ms: null, high_ms: 20 * MIN, refs: [], why: 'a guess', brief: 'x' };

test("the server's kept done work, read in slices ahead of the first play, is the whole read's", async () => {
  // more than two slices of done work, each sized by juno, between reviews' runs the whole read leaves out
  for (let i = 0; i < 1100; i++) {
    const ended = Date.now() - DAY + i * MIN;
    const id = h.pastJob({ title: `Paint tile ${i}`, run: { started: ended - (10 + (i % 30)) * MIN, ended } });
    sizes.record({ job: id, ...guess }, ended - 20 * MIN);
    if (i % 3 === 0) h.pastJob({ kind: 'review', title: `Review tile ${i}`, run: { started: ended - MIN, ended } });
  }
  const whole = matching.pastJobs(),
    measured = sizerbias.measured();
  assert.equal(whole.length, 1100);

  forecast.start();
  await pastpool.renewal();
  assert.deepEqual(pastpool.pool(), whole);
  assert.deepEqual(sizerbias.measured(), measured, "the sizers' bias stands on the same jobs");
});

test("a job sized and done after the start reaches the sizers' bias once the hour's renewal is in", async () => {
  // reel's own jobs, given an hour, took half: none of them in the pool read at the start
  for (let i = 0; i < sizerbias.LEAST; i++) {
    const ended = Date.now() - MIN;
    const id = h.pastJob({ title: `Glaze tile ${i}`, run: { started: ended - 30 * MIN, ended } });
    sizes.record({ job: id, ...guess, by: 'reel', agent_ms: HOUR, high_ms: HOUR }, ended - HOUR);
  }
  const now = Date.now();
  assert.equal(sizerbias.corrected(HOUR, 'reel', now).bias?.own, false, "the start's pool has none of reel's");
  const hourOn = now + HOUR + MIN;
  assert.equal(sizerbias.corrected(HOUR, 'reel', hourOn).bias?.own, false, 'the read past the hour renews the pool');
  await pastpool.renewal();
  assert.equal(sizerbias.corrected(HOUR, 'reel', hourOn + MIN).agent_ms, 30 * MIN, "then reel's own bias counts");
});
