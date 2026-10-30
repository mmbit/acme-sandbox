// node --test src/quickruns.test.ts   (uses a throwaway DATA_DIR)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('quickruns', {
  before: repo => {
    const file = `${repo}/company/models.yaml`,
      org = `${repo}/company/org.yaml`;
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('effort: high }', 'effort: high, autocompact: 400000 }') +
        'chat:\n  autocompact: 100000\n',
    );
    writeFileSync(org, readFileSync(org, 'utf8').replace('{ id: dex,', '{ id: dex, autocompact: 250000,'));
  },
});
const { db } = h;
const { onQuickRun, quickRun, QUICK_RUN_MS, QUICK_EFFORT } = await import('./quickruns.ts');
afterEach(() => h.cancelQueued());
const PURPOSE = 'a test';
const heard: { job: number; status: string; result: string }[] = [];
onQuickRun(PURPOSE, { heard: (job, status, result) => void heard.push({ job, status, result }) });

test('a quick run handed back keeps what was left of its turn when it is claimed again, and its answer goes to its purpose', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const job = quickRun('bolt', 'A question', 'What time is it?', PURPOSE);
  const run = await h.claimJob(job);
  const started = (db.prepare('select started from jobs where id = ?').get(job) as { started: string }).started;
  t.mock.timers.tick(90_000);
  const lostAt = new Date().toISOString();
  t.mock.timers.tick(90_000); // The worker returns after the coordinator has restarted.
  await h.finish(run, { status: 'interrupted', lostAt });
  const again = await h.claimJob(job);
  const left = again.quickReplyUntil - Date.now();
  assert.ok(left > QUICK_RUN_MS - 90_100 && left <= QUICK_RUN_MS - 90_000, `${left} ms left of its turn`);
  assert.equal(
    (db.prepare('select started from jobs where id = ?').get(job) as { started: string }).started,
    started,
    "the job's first start stays",
  );
  await h.finish(again, { result: 'It is 16:35 in Amsterdam.' });
  assert.deepEqual(heard.at(-1), { job, status: 'done', result: 'It is 16:35 in Amsterdam.' });
});

test("a quick run thinks at the quick effort, not its agent's, and the agent's work keeps its own", async () => {
  const quick = await h.claimJob(quickRun('bolt', 'A question', 'Is this live yet?', PURPOSE));
  assert.equal(quick.agentInfo.effort, QUICK_EFFORT);
  const work = await h.claimJob(h.queue({ agent: 'bolt' }));
  assert.notEqual(work.agentInfo.effort, QUICK_EFFORT, `its work runs at ${work.agentInfo.effort}`);
  await h.finish(quick, { result: 'Yes.' });
});

test("the intercom's turns compact at the chat size, its agent's own size wins, and work keeps the company's", async () => {
  const chat = await h.start({ agent: 'bolt', kind: 'chat' });
  assert.equal(chat.agentInfo.autocompact, 100000);
  const own = await h.start({ agent: 'dex', kind: 'chat' });
  assert.equal(own.agentInfo.autocompact, 250000);
  const quick = await h.claimJob(quickRun('bolt', 'A question', 'Is this live yet?', PURPOSE));
  assert.equal(quick.agentInfo.autocompact, 400000);
  const work = await h.start({ agent: 'bolt', title: 'Work', kind: 'work' });
  assert.equal(work.agentInfo.autocompact, 400000);
  await h.finish(quick, { result: 'Yes.' });
});
