// node --test src/sizes.test.ts   (uses a throwaway DATA_DIR): each job's size and who gave it (the sizer's model, an
// agent, the estimate tool), the sizer's turn through the worker's routes, hq estimate set, and the threads a change moves.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { git } from './fixture.ts';

const h = await harness('sizes', {
  before: repo =>
    writeFileSync(`${repo}/company/projects.yaml`, 'projects:\n  - { id: game, name: The game, owner: wren }\n'),
});
const predictions = await import('./predictions.ts');
const merged = await import('./merged.ts');
const sizes = await import('./sizes.ts');
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const forecast = await import('./forecast.ts');
const log = await import('./log.ts');

const MIN = 60_000,
  HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
mock.timers.enable({ apis: ['Date'], now: T0 });
test.after(() => mock.timers.reset());
test.beforeEach(() => h.capacity({ claude: 1, codex: 1 }));

// A done job of kit's, queued by Juno, that ran `minutes` two days ago and changed `files`, merged an hour after its end.
function past(title: string, minutes: number, files = ['kits/map/map.js']) {
  const ended = T0 - 48 * HOUR;
  return h.pastJob({ title, run: { started: ended - minutes * MIN, ended }, merged: ended + HOUR, files });
}
const harbour = [
  past('Paint the harbour map', 30),
  past('Paint the harbour map in winter', 40),
  past('Paint the harbour map at night', 50),
];
const sound = past('Mix the tavern sounds', 90, ['kits/sound/mix.js']);

// Work kit is handed now, on the Claude seat's one slot.
// (with the tool's size, as the minute's sweep gives it)
const queued = (title: string, more: Record<string, unknown> = {}) => {
  const id = h.queue({
    agent: 'kit',
    title,
    engine: 'claude',
    queuedBy: 'wren',
    prompt: `${title}.`,
    ...more,
  });
  predictions.sweep();
  return id;
};
const seat = () => h.worker('seat', { seat: 'claude-a', engine: 'claude', state: 'ready', util: 0.1 });
const clear = () => h.db.exec("update jobs set status = 'cancelled' where status = 'queued'");
const later = (ms: number) => mock.timers.tick(ms);

// The worker's turn: the next job to size, and the model's answer for it.
const claim = async () => (await h.worker('sizes/claim')).body;
const answer = (claimed: { job: number; brief: string }, result: unknown) =>
  h.worker('sizes/answer', { job: claimed.job, brief: claimed.brief, ...(result ? { result } : { error: 'exit 1' }) });
const told = (sized: Record<string, unknown>) => ({ type: 'result', is_error: false, structured_output: sized });
const good = { middle_minutes: 120, low_minutes: 90, high_minutes: 180, refs: harbour, why: 'Like the harbour maps.' };

// A queued job's sizes and outlook as hq estimate '#n' gives them.
const estimate = async (job: number) => {
  const reader = await h.start({ agent: 'bolt', title: 'Reading' });
  const r = await h.agent(`estimate?${new URLSearchParams({ q: `#${job}` })}`, reader.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test('the sizer sizes new work on done jobs from its pool, and the play takes its agent time', async () => {
  await seat();
  const job = queued('Paint the harbour map for spring', { prompt: 'Paint it in kits/map/ as the winter one.' });
  queued('Answer a customer about the map', { customers: true });
  h.queue({ agent: 'kit', title: "HQ's own notice", engine: 'claude' });
  const claimed = await claim();
  assert.equal(claimed.job, job, 'not a job holding customer details, nor one HQ made');
  assert.equal(claimed.model, 'haiku');
  assert.ok(JSON.parse(claimed.schema).properties.refs);
  assert.match(claimed.prompt, /Paint it in kits\/map\/ as the winter one\./);
  const pool = [...claimed.prompt.matchAll(/^#(\d+) /gm)].map(m => Number(m[1]));
  assert.deepEqual(pool.sort(), [...harbour, sound].sort(), 'its pool: the matching picks, the agent, the folder');
  assert.deepEqual((await answer(claimed, told(good))).body, { sized: true });
  const latest = predictions.latest(job)!;
  assert.deepEqual(
    [latest.by, latest.agent_ms, latest.low_ms, latest.high_ms],
    ['haiku', 120 * MIN, 90 * MIN, 180 * MIN],
  );
  const found = await estimate(job);
  assert.equal(found.outlook.left_minutes, 120, 'the play takes the latest size');
  assert.deepEqual(
    found.sizes.map((s: { by: string }) => s.by),
    ['haiku', 'tool'],
  );
  assert.deepEqual(await claim(), {}, 'sized on its brief: nothing more is due');
  clear();
});

// The merges of pull requests as review.ts makes them in the checkout (REPO_DIR), each a branch's commit merged into main
// with its own merge commit: `lines` new lines in a file of its own, and `gone` lines of main's file removed.
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

test("the sizer's pool shows the lines each done job's merge changed, and nothing for a job whose merge wasn't read", async () => {
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
  const job = queued('Paint the harbour map for the fair', { prompt: 'Paint it in kits/map/ as the winter one.' });
  const claimed = await claim();
  assert.equal(claimed.job, job);
  const line = (id: number) => claimed.prompt.split('\n').find((l: string) => l.startsWith(`#${id} `));
  assert.equal(line(harbour[0]), `#${harbour[0]} kit, 30 min, 1 files, +30 -2 lines: Paint the harbour map`);
  assert.equal(line(harbour[2]), `#${harbour[2]} kit, 50 min, 1 files, +600 -4 lines: Paint the harbour map at night`);
  assert.equal(line(harbour[1]), `#${harbour[1]} kit, 40 min, 1 files changed: Paint the harbour map in winter`);
  assert.equal(line(sound), `#${sound} kit, 90 min, 1 files, +7 -0 lines: Mix the tavern sounds`);
  assert.match(claimed.prompt, /Lines are the better measure of how much changed/);
  clear();
});

test("a brief goes to the model whole, and one the model's context can't hold beside done jobs says so in the job's log", async () => {
  const long = queued('Paint the harbour map for summer', {
    prompt: `Paint it in kits/map/. ${'Every tile by hand. '.repeat(1_000)}The end.`,
  });
  const claimed = await claim();
  assert.equal(claimed.job, long);
  assert.match(claimed.prompt, /The end\.\n<\/job>/);
  clear();
  const tooLong = queued('Paint the harbour map for autumn', { prompt: 'Paint it. '.repeat(50_000) });
  assert.deepEqual(await claim(), {}, 'nothing left to size');
  assert.ok(
    log.jobLog(tooLong).some(l => /^Not sized by the sizer: .*Shorten the brief or split the work/.test(l.text)),
  );
  assert.deepEqual(await claim(), {}, 'the same brief is not tried again');
  clear();
});

test("a bad answer or none keeps the tool's size, tried twice per brief, and an extended brief is due again", async () => {
  const job = queued('Paint the harbour map for autumn');
  const tool = predictions.latest(job)!;
  const first = await claim();
  assert.equal(first.job, job);
  const notInPool = { ...good, refs: [harbour[0], harbour[1], 99_999] };
  assert.equal((await answer(first, told(notInPool))).body.sized, false);
  assert.deepEqual(await claim(), {}, 'tried again only after a while');
  later(11 * MIN);
  const second = await claim();
  assert.equal(second.job, job);
  assert.equal((await answer(second, null)).body.sized, false);
  later(11 * MIN);
  assert.deepEqual(await claim(), {}, 'twice per brief at most');
  assert.deepEqual(predictions.latest(job), tool, "the tool's size stands");
  h.jobs.extendJob(job, 'wren', 'And the lighthouse.');
  const extended = await claim();
  assert.equal(extended.job, job);
  const outOfOrder = { ...good, low_minutes: 200 };
  assert.equal((await answer(extended, told(outOfOrder))).body.sized, false);
  assert.equal(predictions.latest(job)!.by, 'tool');
  clear();
});

test('hq estimate set: the CEO, the queuer, the thread owner or its own agent re-sizes, the latest counts and the earlier stay', async () => {
  const levels = projects.createThread({ project: 'game', name: 'Levels', goal: 'Five levels' });
  assert.equal(typeof levels, 'object');
  const job = queued('Paint the harbour map for summer', { queuedBy: 'moss', thread: 'game/levels' });
  const as = async (agent: string, time: string, why = '') =>
    h.agent('sizes', (await h.start({ agent, title: 'Sizing' })).token, { job, time, why });
  assert.equal((await as('dex', '2h')).status, 403, 'not their job, thread or company');
  assert.equal((await as('kit', '1h', 'the read found a fix')).status, 200, 'its own agent, once the work outgrows it');
  assert.equal((await as('moss', '2 hours')).status, 400);
  assert.equal((await as('moss', '90m', 'two maps in one')).status, 200);
  assert.equal((await as('wren', '1h30m')).status, 200);
  const { out, code } = await h.hq(
    await h.start({ agent: 'juno', title: 'Sizing' }),
    'estimate',
    'set',
    `#${job}`,
    '3h',
    'Needs the tide too',
  );
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`Job #${job} is sized at 3 h of agent time now\\.`));
  assert.match(
    out,
    /\nOther threads it moves, for your planning only: The game's Levels by \+1 h 30 min, to .* UTC\.\n/,
  );
  const found = await estimate(job);
  assert.deepEqual(
    found.sizes.map((s: { by: string; agent_minutes: number }) => [s.by, s.agent_minutes]),
    [
      ['juno', 180],
      ['wren', 90],
      ['moss', 90],
      ['kit', 60],
      ['tool', 40],
    ],
  );
  assert.equal(found.outlook.left_minutes, 180);
  const latest = predictions.latest(job)!;
  assert.ok(latest.high_ms > latest.agent_ms, 'the slow play takes it at the slow share of its prediction');
  // (its thread's owner is its project's: a new owner re-sizes it, the old one no longer.)
  const owner = (to: string) => plan.setOwner('game', to, { agent: 'juno', job: 0 }, () => true);
  assert.deepEqual(owner('dex'), { ok: true });
  assert.equal((await as('wren', '2h')).status, 403, "no longer its thread's owner");
  assert.equal((await as('dex', '2h')).status, 200, 'its new owner');
  owner('wren');
  h.db.prepare("update jobs set status = 'done' where id = ?").run(job);
  assert.equal((await as('juno', '1h')).status, 409, 'a done job keeps its sizes');
  clear();
});

test('hq job and hq cancel say which threads the work moves, and by how much', async () => {
  const now = Date.now();
  mock.timers.setTime(now - 25 * HOUR);
  projects.createThread({ project: 'game', name: 'Docks', goal: 'The docks open' });
  const docks = queued('Paint the harbour map for the docks', { thread: 'game/docks' });
  const dayAgoFinish = forecast.refresh().threads.get('game/docks')!.finish!;
  mock.timers.setTime(now);
  const lead = await h.start({ agent: 'wren', title: 'Planning' });
  await h.agent('window', lead.token, { thread: 'game/docks', deadline: '12h' });
  const ahead = await h.agent('job', lead.token, {
    agent: 'kit',
    title: 'Paint the harbour map at dawn',
    prompt: 'x',
    thread: 'game/docks',
  });
  assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
  assert.equal(ahead.body.moves.length, 1, JSON.stringify(ahead.body.moves));
  const [moved] = ahead.body.moves;
  assert.deepEqual([moved.thread, moved.project, moved.name], ['game/docks', 'The game', 'Docks']);
  const delay = moved.to.at - moved.from.at;
  assert.ok(delay >= 40 * MIN, "the added work and its review runs share the thread's slots");
  // the docks' window is an agreed deadline: its facts, before and after, its slack, and its slack hours ago
  const [docksDeadline] = ahead.body.deadlines;
  assert.equal(ahead.body.deadlines.length, 1, JSON.stringify(ahead.body.deadlines));
  assert.deepEqual([docksDeadline.thread, docksDeadline.by], ['game/docks', 'wren']);
  assert.deepEqual(
    docksDeadline.trend,
    [6, 24].map(hours => ({ hours, slack_ms: docksDeadline.deadline - dayAgoFinish })),
  );
  assert.equal(docksDeadline.finish - docksDeadline.before, delay);
  assert.equal(docksDeadline.slack_ms, docksDeadline.deadline - docksDeadline.finish);
  const behind = await h.agent('job', lead.token, {
    agent: 'kit',
    title: 'Paint the harbour map at dusk',
    prompt: 'x',
  });
  assert.deepEqual(behind.body.moves, [], 'work queued behind it, in no thread, moves none');
  const cancelled = await h.agent('cancel', lead.token, { id: ahead.body.id });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.moves[0].to.at - cancelled.body.moves[0].from.at, -delay);
  const { out } = await h.hq(lead, 'cancel', String(behind.body.id));
  assert.match(
    out,
    /Cancelled job #\d+\.\nAgreed deadlines \(thread windows\):\n- The game's Docks: deadline .* UTC \(given by wren\); done about .* UTC, \d.* of slack \(cancelling it leaves it\)\. Then: 6 h ago \d.* of slack; a day ago \d.* of slack\.\nThe board hears of an agreed deadline when its finish passes it or the board asks; .*\nIt moves no other thread\./,
  );
  assert.ok(docks);
  clear();
});

test("a claimed job its agent may re-size carries its size and whose it is, for its briefing; HQ's own doesn't", async () => {
  const work = (title: string) => h.queue({ agent: 'kit', title, queuedBy: 'wren' });
  const claimed = async (job: number) => {
    const run = await h.claim(h.job(job).engine);
    assert.equal(run?.id, job);
    return run.resize;
  };
  const fresh = work('Paint the lighthouse');
  assert.deepEqual(await claimed(fresh), { size: null }, 'not sized yet: the line, without a size');
  const tool = work('Paint the harbour map for the fair');
  predictions.sweep();
  assert.deepEqual(await claimed(tool), { size: '40 min of agent time, by the estimate tool, on done jobs like it' });
  const sized = work('Paint the harbour map for the regatta');
  const given = { agent_ms: 90 * MIN, low_ms: null, high_ms: null, refs: [], why: 'x', brief: 'x' };
  sizes.record({ job: sized, by: 'haiku', ...given });
  assert.deepEqual(await claimed(sized), { size: '1 h 30 min of agent time, by the sizer' });
  const resized = work('Paint the harbour map for the parade');
  sizes.record({ job: resized, by: 'wren', ...given });
  assert.deepEqual(await claimed(resized), { size: '1 h 30 min of agent time, by wren, with hq estimate set' });
  const notice = h.queue({ agent: 'kit', title: "HQ's own notice" });
  assert.equal(await claimed(notice), undefined, "HQ's own work is sized from history, not by its agent");
  h.db.exec("update jobs set status = 'cancelled' where status = 'running'");
});

// Keep watching last: earlier tests use the one-off forecast that refreshes on every read.
test('a sizer answer keeps the cached thread forecast until the settled play takes its new size', async () => {
  await seat();
  projects.createThread({ project: 'game', name: 'Spring', goal: 'The spring map' });
  const job = queued('Paint the harbour map for spring', { thread: 'game/spring' });
  const reader = await h.start({ agent: 'bolt', title: 'Reading the spring thread' });
  const claimed = await claim();
  assert.equal(claimed.job, job);
  const thread = async () => {
    const reply = await h.agent('thread?id=game/spring', reader.token);
    assert.equal(reply.status, 200);
    return reply.body.jobs.find((entry: { id: number }) => entry.id === job);
  };
  const before = await thread();
  assert.equal(before.size_ms, 40 * MIN);
  assert.equal(before.left_ms, 40 * MIN);

  const now = Date.now();
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  forecast.start();
  assert.deepEqual((await answer(claimed, told(good))).body, { sized: true });
  assert.deepEqual(await thread(), before, 'the answer leaves the cached forecast in place');
  later(10_000 - 1);
  assert.deepEqual(await thread(), before, 'the forecast stays cached until the burst settles');
  later(1);
  const settled = await thread();
  assert.equal(settled.size_ms, 120 * MIN);
  assert.equal(settled.left_ms, 120 * MIN);
  clear();
});
