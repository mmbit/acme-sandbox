// node --test src/jobcodes.test.ts   (throwaway DATA_DIR and REPO_DIR)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const h = await harness('jobcodes', {
  before: repo =>
    writeFileSync(
      `${repo}/company/projects.yaml`,
      `requireThread: true
made:
  alarms: { hq: shop }
groups:
  unsorted: { name: Front Desk, code: FD }
projects:
  - { id: game, name: The game, owner: wren }
  - { id: shop, name: The shop, owner: moss }
`,
    ),
});
const { db, jobs } = h;
const projects = await import('./projects.ts');
const plan = await import('./plan.ts');
const regroup = await import('./regroup.ts');
const { jobsOfCode, numbered } = await import('./jobcodes.ts');
const { made } = await import('./made.ts');
const alarms = await import('./alarms.ts');
const company = await import('./company.ts');
const { ceo } = company;

const codeOf = (id: number) =>
  (db.prepare('select code from jobs where id = ?').get(id) as { code: string | null }).code;
const queuedId = (out: string) => Number(/Queued job #(\d+)/.exec(out)![1]);
company.projects(); // (the yaml's projects lifted into the table)
assert.deepEqual(plan.setCode('game', 'gm', ceo()), { id: 'game', code: 'GM' });
assert.deepEqual(plan.setCode('shop', 'SH', ceo()), { id: 'shop', code: 'SH' });
for (const [slug, project] of [
  ['boss', 'game'],
  ['till', 'shop'],
])
  assert.equal(typeof projects.createThread({ project, name: `Thread ${slug}`, goal: 'It works', slug }), 'object');

test("hq job names a task's code: its project's prefix and the queuer's word, never one another task holds", async () => {
  const lead = await h.start({ agent: 'wren', thread: 'game/boss' });
  const queue = (...args: string[]) => h.hq(lead, 'job', 'moss', 'The boss fight', '--new', ...args);
  const none = await queue();
  assert.equal(none.code, 0, 'the harness names one for tests about other things');
  const bare = await h.hq(lead, 'job', 'moss', 'The boss fight', '--new', '--code', '');
  assert.notEqual(bare.code, 0);
  for (const word of ['boss fight', 'B0SS', 'BOSSFIGHT', 'X'])
    assert.match((await queue('--code', word)).out, /No job was queued: --code takes one word of 2 to 8 letters/, word);
  const boss = await queue('--code', 'boss');
  assert.equal(boss.code, 0, boss.out);
  assert.match(boss.out, /^Queued job #\d+ GM-BOSS for moss: The boss fight/m);
  const again = await queue('--code', 'BOSS');
  assert.match(
    again.out,
    new RegExp(`No job was queued: GM-BOSS is task #${queuedId(boss.out)}'s \\(moss: The boss fight\\)`),
  );
  const lyra = await h.start({ agent: 'juno' });
  const elsewhere = await h.hq(
    lyra,
    'job',
    'moss',
    'The boss fight',
    '--thread',
    'shop/till',
    '--new',
    '--code',
    'BOSS',
  );
  assert.match(elsewhere.out, /Queued job #\d+ SH-BOSS/, 'another project has the word free');
  // the CEO's own work in no thread: the Front Desk's prefix
  const desk = await h.hq(lyra, 'job', 'juno', 'Sort the loose work', '--new', '--code', 'SORT');
  assert.match(desk.out, /Queued job #\d+ FD-SORT/);
  assert.equal(numbered({ id: queuedId(desk.out), code: 'FD-SORT' }), `#${queuedId(desk.out)} FD-SORT`);
  assert.equal(numbered({ id: 7, code: null }), '#7');
});

test("a task's steps carry its code, also once it's moved", () => {
  const task = jobs.createJob({
    agent: 'moss',
    title: 'The till',
    prompt: 'x',
    thread: 'shop/till',
    code: 'SH-TILL',
  }).id;
  const retry = jobs.createJob({ agent: 'moss', title: 'The till', prompt: 'x', insteadOf: task, word: 'NOPE' }).id;
  const review = jobs.createJob({
    agent: 'bolt',
    kind: 'review',
    title: 'Review',
    prompt: 'x',
    branch: `job/${task}`,
  }).id;
  h.storedPr(901, task, 'open');
  const fix = jobs.createJob({ agent: 'moss', title: 'Fix', prompt: 'x', pr: 901, round: 1, stage: 'fix' }).id;
  assert.deepEqual([retry, review, fix].map(codeOf), ['SH-TILL', 'SH-TILL', 'SH-TILL']);
  assert.deepEqual(jobsOfCode('SH-TILL'), [task, retry, review, fix]);
  assert.equal(jobsOfCode('sh-till'), undefined, 'a code is in capitals');
  const moved = regroup.moveJob(task, 'game/boss', ceo());
  assert.equal(typeof moved, 'object', String(moved));
  assert.equal(jobs.threadOf(task), 'game/boss');
  assert.equal(codeOf(task), 'SH-TILL');
});

test("HQ's standing watches each keep a code of their own, in the project their jobs go in", () => {
  const raise = (key: string, word: string | null) =>
    alarms.raise(key, `${key} is on`, { title: `The ${key}`, urgent: false, prompt: 'x', word });
  const jobOf = (key: string) =>
    Number(new RegExp(`^${key} is on \\(your job #(\\d+)\\)`, 'm').exec(alarms.lines().join('\n'))![1]);
  raise('disk', 'DISK');
  raise('backup', 'NOBACKUP');
  raise('watch.till', null);
  assert.deepEqual(['disk', 'backup', 'watch.till'].map(jobOf).map(codeOf), ['SH-DISK', 'SH-NOBACKUP', null]);
  // the CEO's word that it's over follows on from the job about it
  const disk = jobOf('disk');
  alarms.end('disk', { title: 'The disk is fine', prompt: 'x' });
  const [first, notice] = jobsOfCode('SH-DISK')!;
  const title = (db.prepare('select title from jobs where id = ?').get(notice) as { title: string }).title;
  assert.deepEqual([first, title], [disk, 'The disk is fine']);
});

test("a standing task's word is HQ's: no queuer claims it, before its task first runs too", async () => {
  writeFileSync(
    `${h.repo}/company/schedule.yaml`,
    '- { id: books, agent: moss, at: "Mon 09:00", title: The books, code: books }\n',
  );
  const lead = await h.start({ agent: 'wren', thread: 'game/boss' });
  const queue = (word: string) => h.hq(lead, 'job', 'moss', 'Something else', '--new', '--code', word);
  // (the disk watch's, which has run in the alarms' project, a studio kind's and the schedule's, which haven't)
  for (const word of ['DISK', 'place', 'BOOKS'])
    assert.match(
      (await queue(word)).out,
      new RegExp(`No job was queued: ${word.toUpperCase()} is the word of a standing task of HQ's`),
      word,
    );
  assert.equal(jobsOfCode('FD-BOOKS') ?? jobsOfCode('FD-PLACE'), undefined);
  const report = await h.start({ agent: 'moss', title: 'A disk report', word: undefined });
  assert.match((await h.hq(report, 'code', 'DISK')).out, /Not named: DISK is the word of a standing task of HQ's/);
  writeFileSync(`${h.repo}/company/schedule.yaml`, '[]\n');
});

test("a task HQ made for one thing that happened is named by the agent doing it, once, and never as another's", async () => {
  const report = await h.start({ agent: 'moss', title: 'A bug report from the shop', word: undefined });
  made('alarms', 'hq', { id: report.id });
  assert.equal(codeOf(report.id), null);
  const named = await h.hq(report, 'code', 'checkout');
  assert.equal(named.out.trim(), 'This task is SH-CHECKOUT now.', 'in the project HQ put it in');
  assert.match(
    (await h.hq(report, 'code', 'TILL')).out,
    /Not named: this task's code is SH-CHECKOUT: a code never changes/,
  );
  const other = await h.start({ agent: 'wren', title: 'Another bug report', word: undefined });
  made('alarms', 'hq', { id: other.id });
  assert.match(
    (await h.hq(other, 'code', 'CHECKOUT')).out,
    new RegExp(`Not named: SH-CHECKOUT is task #${report.id}'s \\(moss: A bug report from the shop\\)`),
  );
  assert.match((await h.hq(other, 'code', 'CHECK OUT')).out, /Not named: --code takes one word of 2 to 8 letters/);
});

test("a project's prefix: two or three capitals of its own, given as it's made or once after", () => {
  const make = (id: string, code?: string) =>
    plan.newProject(
      { id, name: `Project ${id}`, owner: 'wren', ...(code !== undefined && { code }) },
      ceo(),
      () => true,
    );
  assert.match(String(make('arcade')), /a project needs its code: --code and two or three capitals/);
  assert.match(String(make('arcade', 'ARCD')), /two or three capitals/);
  assert.match(String(make('arcade', 'GM')), /GM is project game's code/);
  assert.match(String(make('arcade', 'FD')), /FD is reserved for work without a project/);
  assert.equal(typeof make('arcade', 'ar'), 'object');
  assert.equal((db.prepare("select code from projects where id = 'arcade'").get() as { code: string }).code, 'AR');
  assert.match(String(plan.setCode('arcade', 'AC', ceo())), /arcade's code is AR, for good/);
  assert.match(String(plan.setCode('game', 'GA', 'wren')), /only the CEO/);
});
