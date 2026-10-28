// node --test src/takeover.test.ts   (uses a throwaway DATA_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { followthroughFixture } from './followthrough.fixture.ts';

const h = await harness('takeover');
const { db } = h;
const { followThroughSweep, read } = await import('./followthrough.ts');
const { ceo } = await import('./company.ts');
const windows = await import('./windows.ts');
const forecast = await import('./forecast.ts');
const threats = await import('./threats.ts');
const ordering = await import('./ordering.ts');
const { resume } = await import('./review.ts');
const { cancelJob } = await import('./ledger.ts');
const { MIN, HOUR, t0, reset, agreed, handedOut, checks, jobEngine, startCheck } = await followthroughFixture(h);
// A thread's new window, as hq window sets it (windows.ts).
const setDeadline = (thread: string, at: number, by: string) => {
  const t = windows.threadOf({ thread });
  if (typeof t === 'string') throw new Error(t);
  return windows.set(t, { deadline: at, aim: at }, by);
};
const threadOfJob = (id: number) =>
  (db.prepare('select thread from jobs where id = ?').get(id) as { thread: string }).thread;

test('a failed carrier stands until a job takes over its work: not a later sibling, a replacement until it ends or is cancelled', async () => {
  reset();
  const lead = await h.start({ agent: 'bolt', title: 'Lead the build' });
  const { item } = agreed({ kind: 'task', status: 'handled', job: lead.id, what: 'Build the projects view' });
  await h.finish(lead);
  const build = await h.start({ agent: 'chime', item, title: 'Fixture build step' });
  await h.finish(build, { status: 'failed' });
  const docs = await h.start({ agent: 'chime', item, title: 'Fixture docs step' });
  await h.finish(docs);
  followThroughSweep(t0);
  assert.equal(checks().length, 1);
  const check = await startCheck();
  assert.match(read(check), new RegExp(`job #${build.id} failed, nobody has taken it over; job #${docs.id} done`));

  const requeue = (job: number, said = 'The build step failed and nobody picked it up') =>
    h.agent('followthrough-requeue', check.token, { job, said });
  assert.equal((await requeue(docs.id)).status, 400);
  assert.equal((await requeue(build.id, ' ')).status, 400);
  assert.equal(db.prepare('select count(*) n from jobs where instead_of is not null').get()!.n, 0);
  const again = await requeue(build.id);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((await requeue(build.id)).status, 400);
  assert.equal(db.prepare('select count(*) n from jobs where instead_of = ?').get(build.id)!.n, 1);
  assert.match(
    read(check),
    new RegExp(`job #${build.id} failed, taken over by #${again.body.id}; job #${docs.id} done; #${again.body.id}`),
  );

  // cancelled, it gives the work back; ended done, the failure is finished
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(again.body.id);
  assert.match(read(check), new RegExp(`job #${build.id} failed, nobody has taken it over`));
  const last = await requeue(build.id);
  assert.equal(last.status, 200, JSON.stringify(last.body));
  db.prepare("update jobs set status = 'done' where id = ?").run(last.body.id);
  assert.doesNotMatch(read(check), /Build the projects view/);
});

test("a call followed up and its job failed: the check hands the work to the call's agent, who works for the call", async () => {
  reset();
  // bolt's call: its follow-up hands the item out (hq job --item) and ends done; the job handed it fails
  const { call, item, wire } = await handedOut({
    kind: 'task',
    what: 'Wire the shop key',
    quote: 'Wire the shop key in tonight',
  });
  await h.finish(wire, { status: 'failed' });
  followThroughSweep(t0);
  const check = await startCheck();
  assert.match(read(check), new RegExp(`Wire the shop key · job #${wire.id} failed, nobody has taken it over`));

  // the check works for no call: hq job --item is refused it, and so is anyone's requeue but the running check's
  const said = 'The key wiring failed overnight';
  assert.equal((await h.agent('job', check.token, { agent: 'bolt', title: 'Again', item })).status, 409);
  const other = await h.start({ agent: 'kit', title: 'Something else' });
  assert.equal((await h.agent('followthrough-requeue', other.token, { job: wire.id, said })).status, 400);

  const r = await h.hq({ ...check, agent: ceo() }, 'followthrough', 'requeue', String(wire.id), said);
  assert.equal(r.code, 0, r.out);
  const id = Number(r.out.match(/Queued job #(\d+) for bolt: it takes over #\d+'s work/)?.[1]);
  assert.ok(id, r.out);
  assert.deepEqual(
    { ...(db.prepare('select agent, call, item, instead_of, queued_by from jobs where id = ?').get(id) as object) },
    { agent: 'bolt', call, item, instead_of: wire.id, queued_by: ceo() },
  );
  assert.doesNotMatch(
    String((db.prepare('select prompt from jobs where id = ?').get(id) as { prompt: string }).prompt),
    /tonight/,
  );

  // the new job reads the call and hands the work on, its item with it, through the routes every job uses
  const takeover = await h.claim(jobEngine(id));
  assert.equal(takeover?.id, id);
  assert.equal((await h.agent(`items?call=${call}`, takeover!.token)).status, 200);
  assert.equal((await h.agent(`call?id=${call}`, takeover!.token)).status, 200);
  const on = await h.agent('job', takeover!.token, {
    agent: 'chime',
    title: 'Wire the key, again',
    prompt: 'The rest',
  });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal((db.prepare('select item from jobs where id = ?').get(on.body.id) as { item: number }).item, item);
  // ended done, the item is ready for the board's yes and the failure finished
  await h.finish(takeover!);
  assert.equal(
    (db.prepare('select status from call_items where id = ?').get(item) as { status: string }).status,
    'ready',
  );
  assert.match(read(check), new RegExp(`job #${wire.id} failed, taken over by #${id}`));
  // and once the check has recorded its verdict, it requeues nothing more
  assert.equal((await h.agent('followthrough-verdict', check.token, { verdict: 'acted', said })).status, 200);
  const failedAgain = await h.start({ agent: 'chime', item, title: 'Another step' });
  await h.finish(failedAgain, { status: 'failed' });
  assert.equal((await h.agent('followthrough-requeue', check.token, { job: failedAgain.id, said })).status, 400);
});

test("a failed job's work on calls of more than one agent, or a customer's, goes only to a job working for each", async () => {
  reset();
  const followUp = await h.start({ agent: 'bolt', title: 'A customer call follow-up' });
  await h.finish(followUp);
  const customer = agreed({ kind: 'task', quote: 'Refund the customer at the old address' }, t0, 'bolt', {
    job: followUp.id,
  });
  db.prepare('update jobs set customers = 1 where id = ?').run(followUp.id);
  const theirs = agreed({ kind: 'task', quote: 'Wire the shop key in' }, t0, 'chime');
  // the failed job carries chime's call's item and was handed bolt's customer call's
  const failed = await h.start({ agent: 'kit', item: theirs.item, title: 'Wire the key' });
  db.prepare('update call_items set job = ? where id in (?, ?)').run(failed.id, theirs.item, customer.item);
  await h.finish(failed, { status: 'failed' });
  followThroughSweep(t0);
  const check = await startCheck();
  const state = () => ({
    jobs: db.prepare('select id, status, item, call, instead_of from jobs order by id').all(),
    items: db.prepare('select id, job from call_items order by id').all(),
  });
  const before = state();
  const refused = await h.agent('followthrough-requeue', check.token, { job: failed.id, said: 'The key step failed' });
  assert.equal(refused.status, 400);
  assert.doesNotMatch(refused.body.error, /Refund|shop key/);
  assert.deepEqual(state(), before);

  // the customer call's item alone: bolt's job takes it, and holds the customer's details from then on
  db.prepare('update call_items set job = null where id = ?').run(theirs.item);
  db.prepare('update jobs set item = ? where id = ?').run(customer.item, failed.id);
  const taken = await h.agent('followthrough-requeue', check.token, { job: failed.id, said: 'The refund step failed' });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.deepEqual(
    { ...(db.prepare('select agent, call, item, customers from jobs where id = ?').get(taken.body.id) as object) },
    { agent: 'bolt', call: customer.call, item: customer.item, customers: 1 },
  );
});

// A fix on a pull request, linked to an agreement (hq item link <item> job:<fix>), that failed: the review runs it again.
async function failedFix() {
  reset();
  const lead = await h.start({ agent: 'bolt', title: 'Lead the build' });
  const branch = `job/${lead.id}`;
  await h.finish(lead, { status: 'done', pr: 61, branch });
  const { item } = agreed({ kind: 'task', what: 'Build the projects view' });
  const deadline = Date.now() + HOUR,
    thread = h.dueThread({ deadline, by: ceo() });
  const fix = await h.start({ agent: 'bolt', stage: 'fix', pr: 61, branch, thread });
  db.prepare('update call_items set job = ? where id = ?').run(fix.id, item);
  await h.finish(fix, { status: 'failed' });
  const retry = db.prepare('select id, thread from jobs where instead_of = ?').get(fix.id) as {
    id: number;
    thread: string;
  };
  assert.equal(retry.thread, thread, "the retry is on the fix's thread, so due by its deadline");
  followThroughSweep(t0);
  const check = await startCheck();
  const requeue = (job: number) =>
    h.agent('followthrough-requeue', check.token, { job, said: 'The fix failed and nobody picked it up' });
  const run = async () => {
    db.prepare('update jobs set not_before = 0 where id = ?').run(retry.id);
    const second = await h.claim(jobEngine(retry.id));
    assert.equal(second?.id, retry.id);
    return second!;
  };
  return { fix: fix.id, retry: retry.id, item, deadline, thread, branch, check, requeue, run };
}

test("a review's retry of a failed fix takes its work over while queued, and gives it back cancelled", async () => {
  const queued = await failedFix();
  // the thread's time is the retry's: the pass gives it a latest start, which a later deadline moves with it
  const latest = (job: number) => ordering.current().timings.get(job)?.latestStart ?? null;
  const first = latest(queued.retry);
  assert.ok(first !== null && first < queued.deadline);
  const extended = Date.now() + 4 * HOUR;
  setDeadline(queued.thread, extended, ceo());
  assert.equal(latest(queued.retry), first + extended - queued.deadline);
  assert.match(
    read(queued.check),
    new RegExp(`job #${queued.fix} failed[^;]*, taken over by #${queued.retry}; #${queued.retry}`),
  );
  assert.equal((await queued.requeue(queued.fix)).status, 400);
  assert.equal(db.prepare('select count(*) n from jobs where instead_of = ?').get(queued.fix)!.n, 1);
  // the retry cancelled, the job that takes the work over next is on the thread too, with its time
  assert.ok(cancelJob(queued.retry, 'not needed'));
  const back = await queued.requeue(queued.fix);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(threadOfJob(back.body.id), queued.thread);
  const again = latest(back.body.id);
  assert.ok(again !== null && again < extended);

  const cancelled = await failedFix();
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(cancelled.retry);
  assert.match(read(cancelled.check), new RegExp(`job #${cancelled.fix} failed[^;]*, nobody has taken it over`));
  assert.equal((await cancelled.requeue(cancelled.fix)).status, 200);
});

test("a review's retry that fails too is the one to take over, on its thread; merged, it's ready for the board's yes", async () => {
  const failed = await failedFix();
  await h.finish(await failed.run(), { status: 'failed' });
  const shown = `job #${failed.fix} failed[^;]*, taken over by #${failed.retry}; job #${failed.retry} failed[^;]*, nobody`;
  assert.match(read(failed.check), new RegExp(shown));
  const taken = await failed.requeue(failed.retry);
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(threadOfJob(taken.body.id), failed.thread);
  const prompt = String(db.prepare('select prompt from jobs where id = ?').get(taken.body.id)!.prompt);
  assert.ok(prompt.includes(`its branch ${failed.branch} and pull request #61`), prompt);
  assert.ok(!prompt.includes(`its branch job/${failed.retry} `), prompt);
  const prBefore = db.prepare('select * from prs where number = 61').get();
  assert.match(String(await resume(61, 'bolt')), new RegExp(`job #${taken.body.id} has taken over`));
  assert.deepEqual(db.prepare('select * from prs where number = 61').get(), prBefore);
  assert.equal(db.prepare('select count(*) n from jobs where instead_of = ?').get(failed.retry)!.n, 1);
  db.prepare("update jobs set status = 'cancelled' where id = ?").run(taken.body.id);
  const resumed = await resume(61, 'bolt');
  assert.ok(typeof resumed !== 'string', JSON.stringify(resumed));
  assert.equal(resumed.jobs.length, 1);

  const merged = await failedFix();
  await h.finish(await merged.run(), { status: 'done', pr: 61, branch: merged.branch });
  const { status } = db.prepare('select status from call_items where id = ?').get(merged.item) as { status: string };
  assert.equal(status, 'ready');
  h.mergedPr(61);
  assert.match(
    read(merged.check),
    /ready \d+ min, open until the board says yes \(hq item done\)\): Build the projects view/,
    "merged isn't delivered",
  );
  assert.equal((await h.agent('item-done', merged.check.token, { id: merged.item, said: 'Yes' })).status, 200);
  assert.doesNotMatch(read(merged.check), /Build the projects view/);
});

test("a takeover stays on the failed job's thread, and the CEO's summary follows the thread's deadline, not the failure", async () => {
  reset();
  await h.capacity({ claude: 1, codex: 1 });
  // bolt's call's follow-up queues the work for an item with its time: it goes on the thread, from bolt
  const thread = h.dueThread();
  // (the due project bolt's for the hand-off: only a thread's project owner, or the CEO, queues work into it)
  h.storedProjectOwner('due', 'bolt');
  const { wire } = await handedOut({ kind: 'task', what: 'Wire the shop key', due: Date.now() + HOUR }, thread);
  h.storedProjectOwner('due', 'juno');
  const given = () => ({
    ...(db.prepare('select deadline, deadline_by from threads where id = ?').get(thread) as object),
  });
  assert.equal((given() as { deadline_by: string }).deadline_by, 'bolt');
  const past = Date.now() - 30 * MIN;
  setDeadline(thread, past, 'bolt');
  await h.finish(wire, { status: 'failed' });
  followThroughSweep(t0);
  const check = await startCheck();
  const taken = await h.agent('followthrough-requeue', check.token, { job: wire.id, said: 'The wiring failed' });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  const takeover = db.prepare('select thread, queued_by from jobs where id = ?').get(taken.body.id) as {
    thread: string;
    queued_by: string;
  };
  assert.deepEqual([takeover.thread, takeover.queued_by], [thread, ceo()]);

  // the summary's late line for the thread, as the minute's forecast has it (the check's own thread, past its hour, has
  // one too.)
  const late = (t = Date.now()) =>
    threats.lines(forecast.refresh(t)).filter(l => l.startsWith(`deliverable ${thread} `));
  // it names bolt as who gave the time, not the CEO who queued the takeover
  assert.equal(late().length, 1);
  assert.match(late()[0], new RegExp(`^deliverable ${thread} \\([^)]*\\): .*its deadline .*, set by bolt\\.`));
  const extended = Date.now() + 4 * HOUR;
  setDeadline(thread, extended, 'kit');
  assert.deepEqual(given(), { deadline: extended, deadline_by: 'kit' });
  assert.deepEqual(late(), []);
  setDeadline(thread, past - MIN, 'kit');
  assert.equal(late().length, 1);

  // done and merged, the clock stops
  const run = await h.claim(jobEngine(taken.body.id));
  await h.finish(run!, { status: 'done', pr: 62, branch: `job/${run!.id}` });
  db.prepare("update prs set status = 'merged' where number = 62").run();
  assert.deepEqual(late(Date.now() + 2 * HOUR), []);
});
