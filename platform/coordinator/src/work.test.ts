// node --test src/work.test.ts: what the company got done each day and each agent's week, for HQ's Wire look (/api/work)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { commitFile, git } from './fixture.ts';

const h = await harness('work', {
  before: repo => writeFileSync(`${repo}/company/infra.env`, 'AGENT_EMAIL_DOMAIN=agents.test\n'),
});
const { markMerged } = await import('./work.ts'); // (review.ts marks a merge)
const { refresh } = await import('./commitlines.ts');
const work = async () => (await h.board('/api/work')).body;
const bolt = await h.start({ agent: 'bolt' });
const event = (body: Record<string, unknown>) => h.agent('event', bolt.token, body);
// a pull request of the author's, merged now, as review.ts records it
const merged = (n: number, author: string) => {
  h.db.prepare('insert into prs (number, branch, author) values (?, ?, ?)').run(n, `job/${n}`, author);
  markMerged(n);
};

// a commit on main by one of our agents, at seconds since the epoch
const boltAuthor = { name: 'Bolt (Testco)', email: 'bolt@agents.test' };
const commit = (path: string, content: string, at = Math.floor(Date.now() / 1000), by = boltAuthor) =>
  commitFile(path, content, path, { repo: h.repo, by, at });
const rows = (n: number, row = 'x') => `${row}\n`.repeat(n);

test("the day's numbers: lines from main's history, tests as their runs are kept, merges and finished jobs from their tables, 14 days oldest first", async () => {
  commit('src/till.ts', rows(15));
  await event({ type: 'lines', add: 20, del: 3, grew: 20 }); // (a job's lines so far: its status, not the day's)
  await refresh();
  // (a push's tests, kept: testresults.ts)
  const pushed = { tree: 'a'.repeat(40), base: 'b'.repeat(40), job: bolt.id };
  await h.worker('tests/claim', pushed);
  await h.worker('tests/done', { ...pushed, passed: true, report: 'Tests passed', tests: 7 });
  await event({ type: 'log', text: 'nothing counted' });
  merged(1, 'bolt');
  markMerged(1); // (its first merge counts)
  await h.finish(await h.start({ agent: 'bolt' }));
  const later = h.queue({ agent: 'bolt', queuedBy: 'bolt' });
  assert.equal((await h.agent('cancel', bolt.token, { id: later })).status, 200);
  const list = (await work()).days;
  assert.equal(list.length, 14);
  assert.ok(list[0].day < list[13].day);
  assert.deepEqual(
    { ...list[13], day: undefined },
    { day: undefined, lines: 15, tests: 7, tokens: null, prs: 1, jobs: 1 },
  );
  assert.deepEqual(
    list.slice(0, 13).map((d: any) => d.prs + d.jobs),
    Array(13).fill(0),
  );
  // lines and tests began counting today: the days before have none to give, not a 0
  assert.ok(list.slice(0, 13).every((d: any) => d.lines === null && d.tests === null));
});

test("a day's lines changed: our agents' code and docs, each commit once on its author's day, never data or a merge", async () => {
  const day = 864e5 / 1000,
    now = Math.floor(Date.now() / 1000);
  const before = (await work()).days.map((d: any) => d.lines ?? 0);
  commit('src/old.ts', rows(40), now - 3 * day);
  commit('knowledge/qa/trace.json', rows(100_000, '{"frame":1}'), now - 3 * day);
  commit('products/x/app/bundle.js', rows(500), now - 3 * day);
  commit('.gitattributes', 'products/x/app/bundle.js linguist-generated\n', now - 3 * day);
  commit('src/old.ts', rows(30) + rows(10, 'y'), now - 3 * day); // 10 lines edited: 10
  commit('README.md', rows(9), now - 3 * day, { name: 'The board', email: 'board@example.com' });
  // a branch with a commit of its own, merged into main with a merge commit: counted once, at its own commit
  git(h.repo, 'checkout', '-q', '-b', 'job/7');
  commit('src/branch.ts', rows(6));
  git(h.repo, 'checkout', '-q', 'main');
  commit('docs/main.md', rows(2));
  git(h.repo, 'merge', '-q', '--no-ff', '-m', 'Merge PR #7', 'job/7');
  await refresh();
  await refresh(); // (nothing new: nothing counted again)
  const after = (await work()).days.map((d: any) => d.lines ?? 0);
  const grew = after.map((n: number, i: number) => n - before[i]);
  assert.equal(grew[13], 8);
  assert.equal(grew[10], 40 + 10);
  assert.equal(
    grew.reduce((a: number, b: number) => a + b, 0),
    58,
  );
});

test("a later mark or another agents' domain counts the history again, on the next refresh", async () => {
  const day = 864e5 / 1000,
    now = Math.floor(Date.now() / 1000);
  const total = async () => (await work()).days.reduce((sum: number, d: any) => sum + (d.lines ?? 0), 0);
  const before = await total();
  commit('products/y/app/bundle.js', rows(500), now - 2 * day);
  await refresh();
  assert.equal(await total(), before + 500);
  commit('products/y/.gitattributes', 'app/bundle.js linguist-generated\n', now - 2 * day);
  await refresh();
  assert.equal(await total(), before);
  writeFileSync(`${h.repo}/company/infra.env`, 'AGENT_EMAIL_DOMAIN=elsewhere.test\n');
  await refresh();
  assert.equal(await total(), 0);
  writeFileSync(`${h.repo}/company/infra.env`, 'AGENT_EMAIL_DOMAIN=agents.test\n');
  await refresh();
  assert.equal(await total(), before);
});

test('a configured attributes file counts history again when its contents change without a commit', async () => {
  const attributesFile = `${h.repo}/.git/configured-attributes`;
  const total = async () => (await work()).days.reduce((sum: number, d: any) => sum + (d.lines ?? 0), 0);
  writeFileSync(attributesFile, '');
  // (as the environment's last config pair, which outranks every other: the worker runs a push's tests with
  // core.attributesFile pinned to /dev/null that way, worker git.ts pinnedGitEnv)
  const env = { ...process.env },
    n = Number(env.GIT_CONFIG_COUNT ?? 0);
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'core.attributesFile',
    [`GIT_CONFIG_VALUE_${n}`]: attributesFile,
  });
  try {
    await refresh();
    const before = await total();
    commit('products/z/app/bundle.js', rows(500));
    await refresh();
    assert.equal(await total(), before + 500);
    writeFileSync(attributesFile, 'products/z/app/bundle.js linguist-generated\n');
    await refresh();
    assert.equal(await total(), before);
    writeFileSync(attributesFile, '');
    await refresh();
    assert.equal(await total(), before + 500);
  } finally {
    for (const key of ['GIT_CONFIG_COUNT', `GIT_CONFIG_KEY_${n}`, `GIT_CONFIG_VALUE_${n}`])
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    await refresh();
  }
});

test('the tokens written count from their first day: before it none, after it 0 on a day without', async () => {
  // (the job's running total and what it grew by since the worker's last reading: 1,200, then 300 more)
  await event({ type: 'tokens', total: 1200, grew: 1200 });
  await event({ type: 'tokens', total: 1500, grew: 300 });
  await event({ type: 'lines', add: 2, del: 0 });
  const list = (await work()).days;
  assert.equal(list[13].tokens, 1500);
  assert.ok(list.slice(0, 13).every((d: any) => d.tokens === null));
});

test("each agent's week: jobs done, pull requests merged and the last work job finished", async () => {
  const done = async (title: string, more = {}) => {
    const job = await h.start({ agent: 'penny', title, ...more });
    await h.finish(job);
    return job.id;
  };
  const old = await done('Long ago');
  // ten days ago (no route moves the clock)
  h.db.prepare('update jobs set finished = ? where id = ?').run(new Date(Date.now() - 10 * 864e5).toISOString(), old);
  const ledger = await done('The ledger');
  await done('A review', { kind: 'review', pr: 3 });
  merged(3, 'penny');
  const penny = (await work()).agents.penny;
  // (the last by the board's name, the agent's own words until it's made: plainnames.test.ts.)
  const { finished } = h.db.prepare('select finished from jobs where id = ?').get(ledger) as { finished: string };
  assert.deepEqual(
    { jobs: penny.jobs, today: penny.days.at(-1), prs: penny.prs, last: penny.last },
    { jobs: 2, today: 2, prs: 1, last: { title: 'The ledger', finished } },
  );
});

test("a job's lines ride on its agent's status while the job is at work, and never reach the feed", async () => {
  const shown = async () =>
    ((await h.board('/api/org')).body.departments.flatMap((d: any) => d.agents) as any[]).find(a => a.id === 'bolt')
      .status;
  await event({ type: 'status', state: 'working', text: 'the till' });
  await event({ type: 'lines', add: 40, del: 6 });
  await event({ type: 'status', state: 'working', text: 'the till, step two' });
  assert.deepEqual((await shown()).lines, { add: 40, del: 6 });
  await event({ type: 'status', state: 'idle' });
  assert.equal((await shown()).lines, undefined);
  assert.ok(!(await h.feed()).some(e => e.type === 'lines'));
});

test("an agent's status says since when it's been on its task, so an HQ opened mid-job can say how long", async () => {
  const { publish, status } = await import('./events.ts');
  publish({ ts: '2026-10-13T10:00:00.000Z', type: 'status', agent: 'kit', state: 'working', text: 'the shop' });
  publish({ ts: '2026-10-13T10:05:00.000Z', type: 'status', agent: 'kit', state: 'working', text: 'the shop' });
  assert.equal(status.get('kit')?.since, '2026-10-13T10:00:00.000Z');
  publish({ ts: '2026-10-13T10:09:00.000Z', type: 'status', agent: 'kit', state: 'working', text: 'the mail' });
  assert.equal(status.get('kit')?.since, '2026-10-13T10:09:00.000Z');
  publish({ type: 'status', agent: 'kit', state: 'idle' });
  assert.equal(status.get('kit')?.since, undefined);
});

// The count runs on the coordinator's only thread and HQ asks for it every minute: a formatter made per job would block
// every request.
test("a day starts at the company's midnight on a quarter-hour clock: a job a minute before it counts the day before", async () => {
  const org = `${h.repo}/company/org.yaml`,
    before = readFileSync(org, 'utf8');
  try {
    writeFileSync(org, before.replace('Europe/Amsterdam', 'Asia/Kathmandu')); // (UTC+5:45)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(Date.now()),
      midnight = Date.parse(`${today}T00:00:00+05:45`);
    h.pastJob({ agent: 'nepa', title: 'x', finished: midnight - 60e3 });
    h.pastJob({ agent: 'nepa', title: 'x', finished: midnight });
    assert.deepEqual((await work()).agents.nepa.days.slice(-3), [0, 1, 1]);
  } finally {
    writeFileSync(org, before);
  }
});

test('two weeks of finished jobs are counted in well under a second', async () => {
  // two weeks of history
  h.db.exec('begin');
  for (let i = 0; i < 5000; i++)
    h.pastJob({ agent: 'bolt', title: 'x', finished: Date.now() - (i / 5000) * 14 * 864e5 });
  h.db.exec('commit');
  const start = performance.now();
  await work();
  assert.ok(performance.now() - start < 1000, `took ${Math.round(performance.now() - start)} ms`);
});

const piles = async () => (await h.board('/api/work/piles')).body;
test("what's on the plate: waiting (queued or held for a card), at work and done in the last day, reviews apart, no chats", async () => {
  const before = await piles();
  const past = (status: string, kind = 'work', finished = Date.now()) =>
    h.pastJob({ agent: 'plate', title: 'x', status, kind, finished });
  past('queued');
  past('queued', 'review');
  past('blocked');
  past('running', 'consolidate');
  past('done', 'review');
  past('done', 'work', Date.now() - 2 * 864e5); // (done before the last day)
  past('cancelled');
  past('running', 'chat');
  const after = await piles(),
    added = (k: 'waiting' | 'active' | 'done') => ({
      work: after[k].work - before[k].work,
      review: after[k].review - before[k].review,
    });
  assert.deepEqual(added('waiting'), { work: 2, review: 1 });
  assert.deepEqual(added('active'), { work: 0, review: 1 });
  assert.deepEqual(added('done'), { work: 0, review: 1 });
});

test('the last day done hour by hour, oldest first, each hour [work, reviews], summing to the day', async () => {
  const before = (await piles()).done.hours as number[][];
  h.pastJob({ agent: 'flow', title: 'x', status: 'done', finished: Date.now() - 60e3 });
  h.pastJob({ agent: 'flow', title: 'x', status: 'done', kind: 'review', finished: Date.now() - 60e3 });
  h.pastJob({ agent: 'flow', title: 'x', status: 'done', finished: Date.now() - 5.5 * 36e5 });
  const { done } = await piles(),
    added = (done.hours as number[][]).map(([w, r], i) => [w - before[i][0], r - before[i][1]]);
  assert.equal(added.length, 24);
  assert.deepEqual(added.at(-1), [1, 1]);
  assert.deepEqual(added.at(-6), [1, 0]);
  assert.equal(
    added.flat().reduce((a, b) => a + b),
    3,
  );
  const sum = (k: 0 | 1) => (done.hours as number[][]).reduce((n, x) => n + x[k], 0);
  assert.deepEqual([sum(0), sum(1)], [done.work, done.review]);
});
