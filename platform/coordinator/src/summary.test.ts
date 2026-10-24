// Queue-time estimate contract fixtures.
// node --test src/summary.test.ts   (throwaway DATA_DIR and the test company): hq summary, the CEO's picture, and the
// hourly follow-through check that carries it, the one job HQ makes the CEO of it (an alarm aside: alarms.ts). What
// finished since the last check (finished.ts) and what threatens the plan (threats.ts) have a case for each kind of
// line, each made by the routes and modules that make it, with the clock moved for the time between.
//
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Running } from './harness.ts';
import { followthroughFixture } from './followthrough.fixture.ts';
import { completeTriage, recordedDeploy } from './reviewfixture.ts';

const RUNS_TOKEN = 'runs-secret';
const h = await harness('summary', { env: { RUNS_TOKEN } });
const { db } = h;
const { followThroughSweep } = await import('./followthrough.ts');
const forecast = await import('./forecast.ts');
const threats = await import('./threats.ts');
const { clock } = await import('./windows.ts');
const { MIN, HOUR, t0, reset, agreed, checks, startCheck } = await followthroughFixture(h);

// The summary's threats now, those that name `words`
const threatsNaming = (words: string, now = Date.now()) =>
  threats.lines(forecast.refresh(now)).filter(l => l.includes(words));
// The clock held at now, for a case to move (Date: what HQ stamps its records with), and let go after it
const held = () => {
  const now = Date.now();
  mock.timers.enable({ apis: ['Date'], now });
  return now;
};
afterEach(() => mock.timers.reset());

// HQ's own jobs for the CEO (the test company's is juno) other than its hourly checks
const notices = () =>
  db.prepare("select id from jobs where agent = 'juno' and queued_by is null and is_check = 0").all() as {
    id: number;
  }[];

test('hq summary: what the board asked for and how long it has waited, what threatens the plan, and the queue; the CEO only', async () => {
  reset();
  // (the clock held: the CEO's running job and the late thread's work end together, and which review takes the one
  // claude slot first would move with every millisecond of the test)
  held();
  agreed({ kind: 'task', what: 'Ship the price list' }, Date.now() - 3 * HOUR);
  // a card the board answered whose work goes on
  const asker = await h.start({ agent: 'bolt', title: 'The deck' });
  const card = await h.park(asker, { title: 'Blue or green?' });
  await h.answer(card, 'Blue');
  // a thread's work for a time the board was given, which has passed
  const late = h.dueThread({ deadline: Date.now() - 10 * MIN });
  const page = h.queue({ agent: 'moss', title: 'The shop page', queuedBy: 'juno', thread: late });
  await h.capacity({ [h.job(page).engine]: 1, claude: 1, codex: 1, paused: 1 });
  await h.worker('seat', { seat: 'capacity-paused', engine: 'paused', state: 'paused' });
  // and one past its time with no ETA, ever: its engine's one seat is paused, with no known end
  assert.equal((await h.worker('seat', { seat: 'paused-1', engine: 'paused', state: 'paused' })).status, 200);
  const stalled = h.dueThread({ deadline: Date.now() - 20 * MIN, by: 'kit' });
  h.queue({ agent: 'moss', title: 'The stockroom', queuedBy: 'kit', thread: stalled, engine: 'paused' });
  db.prepare(
    "insert into prs (number, branch, author, status, round, why) values (71, 'job/x', 'kit', 'stuck', 2, 'no head commit')",
  ).run();
  // the board's notes on a pull request, which its author still owes it
  const notes = h.queue({ agent: 'bolt', title: 'The deck', stage: 'feedback', step: "The board's notes" });
  const failed = await h.start({ agent: 'kit', title: 'The importer' });
  await h.finish(failed, { status: 'failed', result: 'It crashed.' });

  const ceo = await h.start({ agent: 'juno', title: 'The morning round' });
  const read = await h.agent('summary', ceo.token);
  assert.equal(read.status, 200);
  const text: string = read.body.text;
  assert.match(
    text,
    /^The board asked for \(and how long it has waited\):\n- item #\d+ \(call \d+, task for juno, open\), waiting 3 h: Ship the price list$/m,
  );
  assert.match(
    text,
    new RegExp(`^- card #${card} "Blue or green\\?", answered \\d+ min ago: #\\d+ \\(bolt, queued\\)$`, 'm'),
  );
  assert.match(
    text,
    new RegExp(
      `^What threatens the plan:\\n- thread ${stalled} \\(Thread \\d+, juno's\\): no finish in sight for its deadline .*, set by kit\\. Held by: .*paused.*$`,
      'm',
    ),
  );
  assert.match(
    text,
    new RegExp(
      `^- thread ${late} \\(Thread \\d+, juno's\\): finish .*, .* past its deadline .*, set by you\\. Held by: .+$`,
      'm',
    ),
  );
  assert.match(text, new RegExp(`^- #${notes} \\(bolt: The board's notes: The deck\\), waiting \\d+ min$`, 'm'));
  assert.match(
    text,
    /^- pull request #71 \(kit's, round 2\) is stuck: no head commit\. Nothing on it has moved yet \(no push, round, merge or deploy\)$/m,
  );
  assert.match(text, new RegExp(`^- #${failed.id} \\(kit: The importer\\) failed \\d+ min ago$`, 'm'));
  assert.match(text, /^Queue: \d+ open jobs\. In the last 6 h, \d+ came in and \d+ ended: it grew by \d+\.$/m);
  assert.deepEqual(
    notices().filter(n => n.id !== ceo.id),
    [],
    'none of it made a job for the CEO',
  );

  const printed = await h.hq(ceo, 'summary');
  assert.equal(printed.code, 0, printed.out);
  assert.equal(printed.out.trim(), text);
  const other = await h.start({ agent: 'bolt', title: 'Another' });
  assert.equal((await h.agent('summary', other.token)).status, 403, "the executive's");
});

test("with nothing agreed, the summary's lines bring the CEO the hourly check, with the summary in it; an empty one doesn't", async () => {
  reset();
  followThroughSweep(t0);
  assert.deepEqual(checks(), [], 'nothing to look at: no check');
  const failed = await h.start({ agent: 'kit', title: 'The importer' });
  await h.finish(failed, { status: 'failed', result: 'It crashed.' });
  followThroughSweep(t0);
  const [check] = checks();
  assert.ok(check, 'a check');
  const { prompt } = db.prepare('select prompt from jobs where id = ?').get(check.job) as { prompt: string };
  assert.match(prompt, new RegExp(`\\n\\nWhat threatens the plan:\\n- #${failed.id} \\(kit: The importer\\) failed `));
  followThroughSweep(t0 + 30 * MIN);
  assert.equal(checks().length, 1, 'one an hour');
  assert.deepEqual(notices(), [], 'and nothing else');
});

test('an alarm on (here the disk) is in the summary, and brings the CEO the hourly check with it', async () => {
  reset();
  const { diskCheck } = await import('./disk.ts');
  const full = () => ({ blocks: 1000, bavail: 100, bsize: 2 ** 20 });
  diskCheck('x', full, t0 - 30 * MIN);
  diskCheck('x', full, t0);
  followThroughSweep(t0);
  const [check] = checks();
  const { prompt } = db.prepare('select prompt from jobs where id = ?').get(check.job) as { prompt: string };
  assert.match(
    prompt,
    /\n\nAlarms on now \(HQ told you and nobody else\):\n- The server's disk is 90% full, 0\.1 GB free \(your job #\d+\)\n/,
  );
  diskCheck('x', () => ({ blocks: 1000, bavail: 500, bsize: 2 ** 20 }), t0);
});

test("with the company paused, an alarm still reaches the CEO: its job is on the pause's allow list", async () => {
  reset();
  db.prepare(
    "insert or replace into settings (key, value) values ('company.paused', json_object('since', 'x', 'allow', json_array()))",
  ).run();
  const { diskCheck } = await import('./disk.ts');
  const full = () => ({ blocks: 1000, bavail: 100, bsize: 2 ** 20 });
  diskCheck('y', full, t0 - 30 * MIN);
  diskCheck('y', full, t0);
  const { job } = db.prepare("select job from alarms where key like 'disk%'").get() as { job: number };
  const { value } = db.prepare("select value from settings where key = 'company.paused'").get() as { value: string };
  assert.deepEqual(JSON.parse(value).allow, [job]);
  db.prepare("delete from settings where key = 'company.paused'").run();
  diskCheck('y', () => ({ blocks: 1000, bavail: 500, bsize: 2 ** 20 }), t0);
});

// ---- what finished since the last check

test("finished since the last check: threads done and the board's items, once their work is merged and deployed; only the board's word brings the check", async () => {
  reset();
  const now = held();
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const summary = async () => (await h.agent('summary', juno.token)).body.text as string;
  const done = async (thread: string) => assert.equal((await h.agent('plan/done', juno.token, { thread })).status, 200);

  // a thread of the company's own, done with nothing to merge: it shows, and brings no check by itself
  const own = h.dueThread();
  await done(own);
  assert.match(
    await summary(),
    new RegExp(
      `^Finished since the last check \\(merged and deployed\\):\\n- thread ${own} \\(Thread \\d+, juno's\\): done ${clock(now, now)}, nothing of it to deploy$`,
      'm',
    ),
  );
  followThroughSweep(now);
  assert.deepEqual(checks(), [], 'news, not a reason for the check');

  // a thread carrying the board's item, and an item whose work is on no thread: done, then merged, then deployed
  const priced = h.dueThread();
  const onThread = await h.start({ agent: 'kit', title: 'The price list', thread: priced });
  const alone = await h.start({ agent: 'moss', title: 'The shop banner' });
  // (calls about a customer, their follow-ups handed their details: their words stay with hq call, charter rule 7)
  const aboutCustomer = (what: string, job: number) =>
    agreed({ kind: 'task', what, status: 'handled', job }, now, undefined, {
      job: h.queue({ agent: 'juno', title: 'The call about a customer', customers: true }),
    });
  const item = aboutCustomer('The price list for Ms Jansen of Kerkstraat 4', onThread.id);
  const other = aboutCustomer('A banner for Ms Jansen', alone.id);
  const plain = agreed({ kind: 'task', what: 'A sign for the shop door', status: 'handled', job: alone.id }, now);
  for (const [pr, job] of [
    [901, onThread],
    [902, alone],
  ] as const) {
    await h.finish(job);
    h.storedPr(pr, job.id, 'open');
  }
  await done(priced);
  // the summary's finished part, its lines
  const finishedLines = async () =>
    /^Finished since the last check \(merged and deployed\):\n((?:- .*\n?)*)/m
      .exec(await summary())?.[1]
      .trim()
      .split('\n') ?? [];
  assert.equal((await finishedLines()).length, 1, 'in review: only the thread of our own');
  h.mergedPr(901, now + MIN);
  h.mergedPr(902, now + MIN);
  mock.timers.setTime(now + 2 * MIN);
  assert.equal((await finishedLines()).length, 1, 'merged, not deployed yet');
  await recordedDeploy(h.dataDir, {
    fetched: now + 2 * MIN,
    finished: now + 3 * MIN,
    sha: 'abc1234',
    ok: true,
    services: [],
  });
  mock.timers.setTime(now + 4 * MIN);
  const live = clock(now + 3 * MIN, now + 4 * MIN);
  const left = 'its words left out (hq call shows this call only to the jobs it may)';
  assert.deepEqual((await finishedLines()).slice(1), [
    `- thread ${priced} (Thread ${priced.split('-').at(-1)}, juno's): done ${clock(now, now)}, its work deployed ${live}. It carries item #${item.item} (call ${item.call}, task): ${left}`,
    `- item #${other.item} (call ${other.call}, task for juno): ${left}. Its work (#${alone.id}) deployed ${live}`,
    `- item #${plain.item} (call ${plain.call}, task for juno): A sign for the shop door. Its work (#${alone.id}) deployed ${live}`,
  ]);

  // the board's word brings the CEO the check, the lines in it; once it records its verdict, they've been seen
  followThroughSweep(now + 4 * MIN);
  const [check] = checks();
  assert.ok(check, 'a check');
  const { prompt } = db.prepare('select prompt from jobs where id = ?').get(check.job) as { prompt: string };
  assert.match(prompt, new RegExp(`\\n- thread ${priced} .*It carries item #${item.item} `));
  assert.doesNotMatch(prompt, /Jansen/, "nor the customer's details in the check's prompt");
  const ceo = await startCheck();
  assert.equal((await h.agent('followthrough-verdict', ceo.token, { verdict: 'ok' })).status, 200);
  mock.timers.setTime(now + 10 * MIN);
  assert.deepEqual(await finishedLines(), [], 'nothing finished since');
});

test('a thread done before the last check whose work deploys after it is finished since; one live before it is not', async () => {
  reset();
  const now = held();
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const doneWith = async (pr: number) => {
    const thread = h.dueThread();
    const job = await h.start({ agent: 'kit', title: `The work of #${pr}`, thread });
    await h.finish(job);
    h.storedPr(pr, job.id, 'open');
    assert.equal((await h.agent('plan/done', juno.token, { thread })).status, 200);
    return thread;
  };
  const deploy = (at: number) =>
    recordedDeploy(h.dataDir, { fetched: at, finished: at + MIN, sha: 'abc1234', ok: true, services: [] });
  // live before the check: merged, then deployed
  const early = await doneWith(911);
  h.mergedPr(911, now + MIN);
  await deploy(now + 2 * MIN);
  // merged after that deploy was fetched, and deployed only after the check
  const late = await doneWith(912);
  h.mergedPr(912, now + 4 * MIN);
  agreed({ kind: 'task', what: 'The door sign', status: 'open' }, now);
  mock.timers.setTime(now + 5 * MIN);
  followThroughSweep(now + 5 * MIN);
  const ceo = await startCheck();
  assert.equal((await h.agent('followthrough-verdict', ceo.token, { verdict: 'ok' })).status, 200);
  await deploy(now + 6 * MIN);
  mock.timers.setTime(now + 8 * MIN);
  const text = (await h.agent('summary', juno.token)).body.text as string;
  assert.match(text, new RegExp(`\\n- thread ${late} .*its work deployed ${clock(now + 7 * MIN, now + 8 * MIN)}`));
  assert.doesNotMatch(text, new RegExp(`thread ${early} `));
});

test("an item whose work merged on a branch its job names (the job before it's) and deploys after the last check is finished since; one live before it is not", async () => {
  reset();
  const now = held();
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const deploy = (at: number) =>
    recordedDeploy(h.dataDir, { fetched: at, finished: at + MIN, sha: 'abc1234', ok: true, services: [] });
  // the item's job pushes to the branch of the job before it, whose pull request merges both
  const carried = async (pr: number, what: string) => {
    const first = await h.start({ agent: 'kit', title: `The start of #${pr}` });
    await h.finish(first);
    const next = await h.start({ agent: 'kit', title: `The rest of #${pr}` });
    await h.finish(next, { status: 'done', branch: `job/${first.id}` });
    h.storedPr(pr, first.id, 'open');
    return { ...agreed({ kind: 'task', what, status: 'handled', job: next.id }, now), job: next.id };
  };
  // live before the check: merged, then deployed
  const early = await carried(921, 'The old sign');
  h.mergedPr(921, now + MIN);
  await deploy(now + 2 * MIN);
  // merged after that deploy was fetched, and deployed only after the check
  const late = await carried(922, 'The new sign');
  h.mergedPr(922, now + 4 * MIN);
  agreed({ kind: 'task', what: 'The door sign', status: 'open' }, now);
  mock.timers.setTime(now + 5 * MIN);
  followThroughSweep(now + 5 * MIN);
  const ceo = await startCheck();
  assert.equal((await h.agent('followthrough-verdict', ceo.token, { verdict: 'ok' })).status, 200);
  await deploy(now + 6 * MIN);
  mock.timers.setTime(now + 8 * MIN);
  const text = (await h.agent('summary', juno.token)).body.text as string;
  assert.match(
    text,
    new RegExp(
      `\\n- item #${late.item} \\(call ${late.call}, task for juno\\): The new sign\\. Its work \\(#${late.job}\\) deployed ${clock(now + 7 * MIN, now + 8 * MIN)}`,
    ),
  );
  assert.doesNotMatch(text, new RegExp(`item #${early.item} `));
});

test("a thread done whose work was closed unmerged shows as finished: that work has ended, so it doesn't move and takes no item", async () => {
  reset();
  const now = held();
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const thread = h.dueThread();
  const { handedOut, reopen, drop, link } = await import('./ledger.ts');
  // that work: a card it parked on and the board answered, the board's item it handled, and one handed out to a job of
  // it on its branch (a job doing a call's work doesn't park): none of them finished with it
  const work = await h.start({ agent: 'kit', title: 'The dropped idea', thread });
  const card = await h.park(work, { title: 'Which idea' });
  assert.equal((await h.answer(card, 'The first')).status, 200);
  const resumed = (await h.claim(h.job(work.id).engine))!;
  assert.equal(resumed?.id, work.id, 'the answer resumes it');
  const carried = agreed({ kind: 'task', what: 'The dropped idea', status: 'handled', job: work.id }, now);
  await h.finish(resumed, { status: 'done', branch: `job/${work.id}` });
  const handed = agreed({ kind: 'task', what: 'Its sketch', status: 'open' }, now);
  const sketch = await h.start({ agent: 'kit', title: 'Its sketch', thread, item: handed.item });
  handedOut(handed.item, sketch.id, null);
  await h.finish(sketch, { status: 'done', branch: `job/${work.id}` });
  h.storedPr(903, work.id, 'closed');
  reopen(`job/${work.id}`); // as review.ts close does
  assert.equal((await h.agent('plan/done', juno.token, { thread })).status, 200);
  assert.match(
    (await h.agent('summary', juno.token)).body.text,
    new RegExp(`^- thread ${thread} \\(Thread \\d+, juno's\\): done ${clock(now, now)}, nothing of it to deploy$`, 'm'),
  );
  const { lines } = await import('./finished.ts');
  const carriesNothing = (why: string) => {
    const line = lines(now).find(l => l.line.startsWith(`thread ${thread} `))!;
    assert.equal(line.board, false, `${why}: it carries neither the board's items nor its card, so brings no check`);
    assert.doesNotMatch(line.line, new RegExp(`item #(${handed.item}|${carried.item})|card #${card}`), why);
  };
  carriesNothing('reopened');
  // the item handed out again, and done on another thread: that work's, not this thread's
  const again = await h.start({ agent: 'moss', title: 'The idea, again', thread: h.dueThread(), item: handed.item });
  handedOut(handed.item, again.id, null);
  await h.finish(again);
  carriesNothing('handled by other work');
  assert.ok(
    lines(now).some(l => l.line.startsWith(`item #${handed.item} `)),
    'the item shows for its own work',
  );
  // and the other dropped since
  assert.equal(typeof drop(carried.item, 'Not now', juno.id), 'object');
  carriesNothing('dropped');
  const placed = () => (db.prepare('select thread from jobs where id = ?').get(work.id) as { thread: string }).thread;
  const { moveJob } = await import('./regroup.ts');
  assert.equal(typeof moveJob(work.id, h.dueThread(), 'juno'), 'string', 'refused');
  assert.equal(placed(), thread, 'it stays on its thread');
  const { item } = agreed(
    { kind: 'task', what: 'The dropped idea, with a time', status: 'open', due: now + HOUR },
    now,
  );
  const deadline = () => ({ ...db.prepare('select deadline, aim from threads where id = ?').get(thread) });
  const had = deadline();
  assert.equal(typeof link(item, { job: work.id }, 'juno', juno.id), 'string', 'refused');
  assert.deepEqual(
    { ...db.prepare('select status, job from call_items where id = ?').get(item) },
    { status: 'open', job: null },
  );
  assert.deepEqual(deadline(), had, "its thread's time stays");
});

test("a finished replacement keeps its failed predecessor's answered card in the thread's completion", async () => {
  reset();
  const now = held();
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const thread = h.dueThread();
  const work = await h.start({ agent: 'kit', title: 'The chosen idea', thread });
  const card = await h.park(work, { title: 'Which idea' });
  assert.equal((await h.answer(card, 'The first')).status, 200);
  const resumed = (await h.claim(h.job(work.id).engine))!;
  assert.equal(resumed.id, work.id);
  await h.finish(resumed, { status: 'failed', result: 'The push failed before opening a pull request' });
  const queued = await h.agent('job', juno.token, {
    agent: 'kit',
    title: 'Land the chosen idea',
    prompt: 'Land the saved work',
    lands: work.id,
  });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const replacement = (await h.claim(h.job(queued.body.id).engine))!;
  assert.equal(replacement.id, queued.body.id);
  await h.finish(replacement);
  h.storedPr(904, replacement.id, 'merged');
  h.mergedPr(904, now + MIN);
  await recordedDeploy(h.dataDir, {
    fetched: now + 2 * MIN,
    finished: now + 3 * MIN,
    sha: 'def5678',
    ok: true,
    services: [],
  });
  mock.timers.setTime(now + 4 * MIN);
  assert.equal((await h.agent('plan/done', juno.token, { thread })).status, 200);
  const { lines } = await import('./finished.ts');
  const line = lines(now + 4 * MIN).find(l => l.line.startsWith(`thread ${thread} `))!;
  assert.equal(line.board, true);
  assert.match(line.line, new RegExp(`card #${card} `));
});

// ---- what threatens the plan, a case for each kind of line

test('a thread giving: its finish past its aim inside its deadline, by how much and the slack left', async () => {
  reset();
  const now = held();
  await h.capacity({ claude: 1 });
  const giving = h.dueThread({ deadline: now + 10 * HOUR, aim: now + MIN });
  h.queue({ agent: 'moss', title: 'The shop page', thread: giving, engine: 'claude' });
  const [line] = threatsNaming(giving);
  assert.match(
    line,
    new RegExp(
      `^thread ${giving} \\(Thread \\d+, juno's\\): finish .*, .* past its aim .*, (\\d+ h )?\\d+ min of slack left to its deadline .*$`,
    ),
  );
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  const window = await h.agent('window', juno.token, { thread: giving, deadline: '10h', aim: '10h' });
  assert.equal(window.status, 200, JSON.stringify(window.body));
  assert.deepEqual(threatsNaming(giving), [], 'aimed at its deadline, it holds');
});

test('a late thread and a stuck pull request say when their work last moved: a push or a round, never a job queued, re-sent or ended with nothing pushed', async () => {
  reset();
  const start = held();
  const late = h.dueThread({ deadline: start - 10 * MIN });
  const task = await h.start({ agent: 'moss', title: 'The shop page', thread: late });
  assert.equal((await h.finish(task, { pr: 73, branch: 'job/shop', sha: 'a'.repeat(40) })).status, 200);
  await completeTriage(h, 73, []);
  const ruling = db.prepare("select id from jobs where pr = 73 and stage = 'ruling' and status = 'queued'").get() as {
    id: number;
  };
  const reviewed = await h.start({ agent: 'kit', title: 'The importer' });
  const branch = `job/${reviewed.id}`;
  assert.equal((await h.finish(reviewed, { pr: 72, branch, sha: 'b'.repeat(40) })).status, 200);
  h.stuckReview(72);
  mock.timers.setTime(start + 20 * MIN);
  // what last hour's check did about them: the reviews re-sent (hq review), whose triage runs and fails again, and a fix
  // on each that pushes the same commit, a ruling that ends without a verdict, and one more only queued
  const asker = await h.start({ agent: 'juno', title: 'Follow-through check' });
  const [resent] = (await h.agent('review', asker.token, { pr: 72 })).body.jobs as number[];
  await h.finish(asker);
  assert.equal((await h.finish(await h.claimJob(resent), { status: 'failed' })).status, 200);
  const fix = await h.start({ agent: 'kit', title: 'Fix the review', branch, pr: 72 });
  assert.equal((await h.finish(fix, { pr: 72, branch, sha: 'b'.repeat(40) })).status, 200);
  h.stuckReview(72);
  assert.equal((await h.finish(await h.claimJob(ruling.id), { output: '{}' })).status, 200);
  const unstick = await h.start({ agent: 'moss', title: 'Unstick the shop page', thread: late });
  assert.equal((await h.finish(unstick, { pr: 73, branch: 'job/shop', sha: 'a'.repeat(40) })).status, 200);
  h.queue({ agent: 'moss', title: 'Unstick it again', thread: late });
  const later = start + 40 * MIN;
  mock.timers.setTime(later);
  assert.match(threatsNaming(late, later)[0], /\. Held by: .+\. Last moved 40 min ago$/);
  assert.match(threatsNaming('pull request #72', later)[0], /is stuck.*\. Last moved 40 min ago$/);
});

test('a running job past its size by 15 minutes, with the agent time it ran and its size', async () => {
  reset();
  const start = held();
  const job = await h.start({
    agent: 'bolt',
    title: 'The shop deck',
    queuedBy: 'juno',
    size: { agent_ms: 10 * MIN, refs: [], why: 'A deck like the last' },
  });
  assert.deepEqual(threatsNaming(`#${job.id} `, start + 24 * MIN), [], '14 minutes past it is no news');
  assert.deepEqual(threatsNaming(`#${job.id} `, start + 26 * MIN), [
    `#${job.id} (bolt: The shop deck) has run 26 min of agent time, 16 min past its size of 10 min`,
  ]);
});

test("tests failing in the last hour, and tests slower than a review round's aim from claim to result", async () => {
  reset();
  const now = held();
  const job = h.queue({ agent: 'kit', title: 'The importer' });
  // a push's tests as the worker runs them: its claim, and its result
  const tested = async (tree: string, passed: boolean, began: number, at: number) => {
    const code = { tree: tree.repeat(40), base: 'b'.repeat(40), job };
    mock.timers.setTime(began);
    assert.deepEqual((await h.worker('tests/claim', code)).body, { yours: true });
    mock.timers.setTime(at);
    assert.equal((await h.worker('tests/done', { ...code, passed, report: 'The report', tests: 1 })).status, 200);
  };
  await tested('2', false, now - 3 * HOUR, now - 2 * HOUR);
  await tested('1', false, now - 10 * MIN, now - 5 * MIN);
  await tested('3', true, now - 30 * MIN, now - 2 * MIN);
  await tested('4', true, now - 14 * MIN, now - MIN);
  assert.deepEqual(threatsNaming('tests ', now), [
    `tests failed on 1 push in the last hour: #${job} (kit)`,
    `tests took longer than a 15 min review round from claim to result: #${job}'s 28 min`,
  ]);
});

test('a run that hit its time limit in the last hour', async () => {
  reset();
  const now = held();
  const job = await h.start({ agent: 'kit', title: 'The importer' });
  const helper = { authorization: `Bearer ${RUNS_TOKEN}` };
  // hq run's run, sent at `sent`, taken by this server's helper and ended at `ended`
  const ran = async (job: Running, timedOut: boolean, sent: number, ended: number) => {
    mock.timers.setTime(sent);
    const spec = Buffer.from(JSON.stringify({ command: 'npm test', cwd: '', bring: [], minutes: 20 })).toString(
      'base64url',
    );
    const run = await h.send('/api/agent/runs', { authorization: `Bearer ${job.token}`, 'x-run': spec }, 'bundle');
    assert.equal(run.status, 200, run.text);
    const taken = await h.send(
      '/api/helper/take',
      { ...helper, 'content-type': 'application/json' },
      {
        kind: run.json.kind,
      },
    );
    assert.equal(taken.status, 200, taken.text);
    mock.timers.setTime(ended);
    const end = { ...helper, 'x-run-exit': timedOut ? '124' : '0', 'x-run-timed-out': timedOut ? '1' : '0' };
    const finished = await h.send(`/api/helper/runs/${taken.json.id}/finish`, end, 'files');
    assert.equal(finished.status, 200, finished.text);
    return { id: run.json.id as number, kind: run.json.kind as string };
  };
  await ran(job, true, now - 2 * HOUR, now - 2 * HOUR + 20 * MIN);
  const late = await ran(job, true, now - 30 * MIN, now - 10 * MIN);
  await ran(job, false, now - 20 * MIN, now - 5 * MIN);
  assert.deepEqual(threatsNaming('run #', now), [
    `run #${late.id} (${late.kind}) of #${job.id} (kit) hit its 20-minute limit 10 min ago`,
  ]);
});

test("the worker's room down to a couple of jobs, and a ready seat near its stop", async () => {
  reset();
  const room = (n: number) =>
    h.worker('room', { capacity: { slots: { claude: 6 }, seatRuns: { claude: 6 }, room: n } });
  await room(2);
  assert.deepEqual(threatsNaming("worker's memory"), [
    "Only 2 jobs fit in the worker's memory at once, of its 6 slots",
  ]);
  await room(3);
  assert.deepEqual(threatsNaming("worker's memory"), []);

  // each seat's reading of its five-hour window and its week, as the worker sends it
  const read = (seat: string, state: string, util: number, week: number) =>
    h.worker('seat', { seat, engine: 'claude', state, util, week });
  await read('near-1', 'ready', 0.3, 0.85);
  await read('out-1', 'sleeping', 0.95, 0.3);
  await read('far-1', 'ready', 0.5, 0.75);
  assert.deepEqual(threatsNaming('seat '), ['seat near-1 (claude) is at 85% of its week, its stop at 90%']);
});

test("the owners' plans: a thread held by a need that misses, an inbox and a meeting ask waiting over an hour", async () => {
  reset();
  const now = held();
  await h.capacity({ claude: 1 });
  const needed = h.dueThread({ deadline: now - 10 * MIN });
  h.queue({ agent: 'moss', title: 'The stockroom', thread: needed, engine: 'claude' });
  const held_ = h.dueThread();
  const juno = await h.start({ agent: 'juno', title: 'The plan' });
  assert.equal((await h.agent('plan/need', juno.token, { thread: held_, needs: needed })).status, 200);
  assert.match(
    threatsNaming(`thread ${held_} `, now)[0],
    new RegExp(
      `^thread ${held_} \\(Thread \\d+, juno's\\) needs thread ${needed}, which misses its deadline .*: finish .*$`,
    ),
  );

  // proposals to the CEO (no project: the CEO's inbox) and meeting asks, over three hours
  const [kit, moss] = [
    await h.start({ agent: 'kit', title: 'The importer' }),
    await h.start({ agent: 'moss', title: 'The shop' }),
  ];
  const at = (ms: number) => mock.timers.setTime(now + ms);
  const propose = async () => {
    const r = await h.agent('proposals', kit.token, { title: 'A new page', brief: 'The shop needs one.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  const ask = async () => {
    const r = await h.agent('meetings/ask', moss.token, { topic: 'The shop launch', with: ['kit', 'bolt'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  const older = await propose();
  at(HOUR);
  const old = await propose();
  const asked = await ask();
  at(2 * HOUR + 40 * MIN);
  await ask();
  at(2 * HOUR + 50 * MIN);
  await propose();
  at(3 * HOUR);
  assert.deepEqual(threatsNaming('inbox'), [`Your inbox has 2 proposals waiting, the oldest 3 h: #${older}, #${old}`]);
  assert.deepEqual(threatsNaming('meeting ask'), [
    `meeting ask #${asked} from moss with kit, bolt, open 2 h with no meeting set: The shop launch`,
  ]);
});

test('sprawl: a project that drew threads and added tasks faster than it finished them since the last check', async () => {
  reset();
  const now = held();
  // a thread and a task from before the check that recorded its verdict
  h.queue({ agent: 'bolt', title: 'A step', queuedBy: 'juno', thread: h.dueThread() });
  agreed({ kind: 'task', what: 'Ship the price list' }, now);
  followThroughSweep(now);
  const check = await startCheck();
  assert.equal((await h.agent('followthrough-verdict', check.token, { verdict: 'ok' })).status, 200);

  mock.timers.setTime(now + MIN);
  const thread = h.dueThread();
  const task = () => h.queue({ agent: 'bolt', title: 'A step', queuedBy: 'juno', thread });
  task();
  task();
  assert.deepEqual(threatsNaming('project '), [], 'a thread and two tasks is the plan going on');
  task();
  assert.deepEqual(threatsNaming('project '), [
    `project Due grew since ${clock(now, now + MIN)}: 1 thread drawn and 3 tasks added, 0 threads and 0 tasks finished`,
  ]);
});
