// node --test src/agreements.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { followthroughFixture } from './followthrough.fixture.ts';

const h = await harness('agreements');
const { db } = h;
const { followThroughSweep, read } = await import('./followthrough.ts');
const { ceo } = await import('./company.ts');
const { HOUR, DAY, t0, reset, agreed, checks, startCheck } = await followthroughFixture(h);

test('an old open agreement still stands, whatever its age', () => {
  reset();
  agreed({ kind: 'task' }, t0 - 10 * DAY);
  followThroughSweep(t0);
  assert.equal(checks().length, 1);
});

test("handed-on work stands until its jobs land: a lead's done job, its colleague's queued, failed or unmerged one", async () => {
  for (const end of ['queued', 'failed', 'unmerged'] as const) {
    reset();
    const lead = await h.start({ agent: 'bolt', title: 'Lead the build' });
    const { item } = agreed(
      { kind: 'task', status: 'handled', job: lead.id, what: 'Build the projects view' },
      t0 - 5 * DAY,
    );
    await h.finish(lead);
    const helper = end === 'queued' ? h.queue({ agent: 'chime', item, title: 'Fixture build step' }) : 0;
    if (end !== 'queued') {
      const run = await h.start({ agent: 'chime', item, title: 'Fixture build step' });
      if (end === 'failed') await h.finish(run, { status: 'failed' });
      else await h.finish(run, { status: 'done', pr: 42, branch: `job/${run.id}` });
    }
    followThroughSweep(t0);
    assert.equal(checks().length, 1, end);
    const text = read({ id: checks()[0].job, agent: ceo() });
    const shown = {
      queued: `#${helper} (?:[A-Z]{2,3}-)?[A-Z]{2,8} chime, queued: Fixture build step`,
      failed: 'job #\\d+ failed',
      unmerged: 'job #\\d+ done, PR #42',
    }[end];
    assert.match(text, new RegExp(`Build the projects view · job #${lead.id} done; ${shown}`), end);
  }
});

test("the board's decision binds until a later call replaces or drops it, however old", () => {
  reset();
  agreed({ status: 'handled' }, t0 - 30 * DAY);
  followThroughSweep(t0);
  assert.equal(checks().length, 1);
});

test("the board's words show only from a call hq call shows the check: not a live call's, nor a customer call's", async () => {
  reset();
  const fixture = await h.start({ agent: ceo(), title: 'A customer call follow-up' });
  await h.finish(fixture);
  db.prepare('update jobs set customers = 1 where id = ?').run(fixture.id);
  const followedUp = agreed({ quote: 'Refund the customer at the old address' }, t0, ceo(), { job: fixture.id });
  const earlier = agreed({ kind: 'task', quote: 'n/a' }, t0 - HOUR, ceo(), { job: fixture.id });
  agreed({ quote: 'Carry on with that customer as said before' }, t0, ceo(), { resumes: [earlier.call] });
  agreed({ quote: 'Say nothing yet: the call is still on' }, t0, ceo(), { status: 'live' });
  agreed({ quote: 'Hold the game work tonight' });
  followThroughSweep(Date.now());
  const check = await startCheck();
  const text = (await h.hq(check, 'followthrough')).out;
  assert.match(text, /The board's words: "Hold the game work tonight"/);
  assert.doesNotMatch(text, /Refund the customer|Carry on with that customer|Say nothing yet/);
  assert.equal((text.match(/The board's words: left out/g) ?? []).length, 3);
  const customers = (id: number) =>
    (db.prepare('select customers from jobs where id = ?').get(id) as { customers: number }).customers;
  assert.equal(customers(check.id), 0);
  // a job working on the call reads it, and holds the customer's details from then on
  const helper = h.queue({ agent: ceo(), item: followedUp.item });
  assert.match(read({ id: helper, agent: ceo() }), /"Refund the customer at the old address"/);
  assert.equal(customers(helper), 1);
});

test('handled customer summaries stay with jobs allowed to read their call, including non-decision items', async () => {
  reset();
  const fixture = await h.start({ agent: ceo() });
  await h.finish(fixture);
  db.prepare('update jobs set customers = 1 where id = ?').run(fixture.id);
  agreed({ status: 'handled', what: 'Private customer decision' }, t0, ceo(), { job: fixture.id });
  const task = agreed({ kind: 'task', status: 'handled', what: 'Private customer task' }, t0, 'chime', {
    job: fixture.id,
  });
  h.queue({ agent: 'chime', item: task.item });
  followThroughSweep(Date.now());
  const check = await startCheck();
  assert.doesNotMatch(read(check), /Private customer/);
  const customers = (id: number) =>
    (db.prepare('select customers from jobs where id = ?').get(id) as { customers: number }).customers;
  assert.equal(customers(check.id), 0);
  const helper = h.queue({ agent: ceo(), item: task.item });
  assert.match(read({ id: helper, agent: ceo() }), /Private customer task/);
  assert.equal(customers(helper), 1);
});
