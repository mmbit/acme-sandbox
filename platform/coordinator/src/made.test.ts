// node --test src/made.test.ts   (throwaway DATA_DIR and the test company): the jobs HQ makes with a window (made.ts).
// An urgent alarm and the hourly check land on one-task threads in the CEO's office, as a new company's projects.yaml
// (the template's) has it; a company without the file has nowhere for them, which throws and makes no job; a repair
// lands in the project its product declares; and an urgent window is one a start now keeps, which a start past its
// latest start misses.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

const template = (path: string) => readFileSync(new URL(`../../../template/${path}`, import.meta.url), 'utf8');
const h = await harness('made', {
  before: repo =>
    writeFileSync(
      `${repo}/products/hello/product.yaml`,
      'name: Hello (platform test)\nstatus: live\nowner: bolt\nproject: shop\n',
    ),
});
const { db, jobs, repo } = h;
const made = await import('./made.ts');
const { cancelJob } = await import('./ledger.ts');
const alarms = await import('./alarms.ts');
const ordering = await import('./ordering.ts');
const forecast = await import('./forecast.ts');
const windows = await import('./windows.ts');
const plan = await import('./plan.ts');
const { ceo, yamlText } = await import('./company.ts');

const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
// A job's thread and that thread's window
const placed = (id: number) => ({
  ...(db
    .prepare('select j.thread, t.deadline, t.aim from jobs j left join threads t on t.id = j.thread where j.id = ?')
    .get(id) as { thread: string | null; deadline: number | null; aim: number | null }),
});
const latestStart = (id: number, now: number) => ordering.current(now).timings.get(id)!.latestStart;
const urgent = (now: number) => {
  alarms.raise(
    `disk-${now}`,
    'The disk is filling up',
    { title: 'The disk is filling up', prompt: 'Free some.', urgent: true, word: 'DISK' }, // (word)
    now,
  );
  return (db.prepare('select max(id) id from jobs').get() as { id: number }).id;
};

assert.equal(
  typeof plan.newProject({ id: 'shop', name: 'The shop', owner: 'bolt', code: 'SH' }, ceo(), () => true),
  'object',
);

beforeEach(async () => {
  db.exec(
    'delete from jobs; delete from threads; delete from alarms; delete from runs; delete from seats; delete from prs',
  );
  for (const engine of ['claude', 'codex'])
    assert.equal(
      (await h.worker('seat', { seat: `${engine}-1`, engine, state: 'ready', util: 0.1, week: 0.1 })).status,
      200,
    );
  await h.worker('room', { capacity: { slots: { claude: 1, codex: 1 }, seatRuns: { codex: 1 }, room: 1 } });
});

test("a new company's projects.yaml puts the jobs HQ makes with a window in a project it declares, its CEO's", () => {
  const [projects, org] = [template('company/projects.yaml'), template('company/org.yaml')].map(yamlText) as any[];
  for (const kind of ['checks', 'alarms']) {
    const home = projects.projects.find((p: { id: string }) => p.id === projects.made[kind]?.hq);
    assert.equal(home?.owner, org.company.ceo, `HQ's ${kind} go to a project the file declares, owned by its CEO`);
  }
});

test("the urgent alarm and the hourly check go on threads in the CEO's office", () => {
  const now = Date.now();
  const alarm = urgent(now);
  const { thread, deadline, aim } = placed(alarm);
  assert.equal(thread, `office/job-${alarm}`, "the office, its CEO's");
  assert.equal((db.prepare("select owner from projects where id = 'office'").get() as { owner: string }).owner, ceo());
  assert.equal(aim, deadline, 'urgent: no give');
  assert.ok(deadline! > now, 'a deadline its run fits before');
  const hour = Math.ceil(now / HOUR) * HOUR;
  const check = jobs.createJob({ agent: ceo(), title: 'Follow-through check', prompt: 'x', check: true }).id;
  made.made('checks', 'hq', { id: check }, { deadline: hour, aim: hour });
  assert.deepEqual(placed(check), { thread: `office/job-${check}`, deadline: hour, aim: hour });
});

test('a repair lands in the project its product.yaml declares, as soon as it can; a window with nowhere to go makes no job', () => {
  const now = Date.now();
  const repair = jobs.createJob({ agent: 'bolt', title: 'Hello is down', prompt: 'x' }).id;
  made.madeForProduct('hello', { id: repair }, { asap: now });
  assert.equal(placed(repair).thread, `shop/job-${repair}`);
  assert.equal(latestStart(repair, now), now, 'its latest start is now');

  const loose = jobs.createJob({ agent: 'bolt', title: 'Errors', prompt: 'x' }).id;
  assert.throws(
    () => made.made('errors', 'hello', { id: loose }, { asap: now }),
    /is given a window, but it has no project/,
  );
  made.made('errors', 'hello', { id: loose });
  assert.equal(placed(loose).thread, null, 'without a window it stays in none, for the CEO to sort');

  const own = `${repo}/company/projects.yaml`,
    kept = readFileSync(own, 'utf8');
  rmSync(own);
  try {
    const before = jobs.listJobs().length;
    assert.throws(() => urgent(now), /is given a window, but it has no project/, 'no file: nowhere for it');
    assert.equal(jobs.listJobs().length, before, 'the alarm makes no job without its window');
  } finally {
    writeFileSync(own, kept);
  }
});

test('an urgent alarm started on time holds its window; one left waiting past its latest start is late', () => {
  const now = Date.now();
  const alarm = urgent(now);
  const { thread, deadline } = placed(alarm);
  assert.equal(latestStart(alarm, now), now, 'its latest start is when it was raised');
  const f = forecast.refresh(now);
  const eta = f.threads.get(thread!)!.eta!;
  assert.ok(eta <= deadline!, 'started now, it finishes by its deadline');
  assert.notEqual(forecast.standing(f.threads.get(thread!)!), 'misses');
  assert.deepEqual(windows.misses(f), []);

  // the same alarm raised its slack and a minute ago (that much before its start now), and left waiting
  assert.ok(cancelJob(alarm, 'Test finished'));
  const waited = urgent(now - (deadline! - eta) - MINUTE);
  const g = forecast.refresh(now);
  const behind = placed(waited).thread!;
  assert.equal(forecast.standing(g.threads.get(behind)!), 'misses');
  assert.deepEqual(
    windows.misses(g).map(m => m.thread),
    [behind],
  );
});

test("a project HQ makes its own jobs in can't be marked done, so a later incident still has a thread to go to", () => {
  const office = String(plan.projectDone('office', ceo()));
  for (const kind of ['checks', 'alarms']) assert.match(office, new RegExp(`made\\.${kind}\\.hq`));
  assert.match(String(plan.projectDone('shop', 'bolt')), /products\/hello\/product\.yaml/, "a live product's project");
  const alarm = urgent(Date.now());
  assert.equal(placed(alarm).thread, `office/job-${alarm}`);
});
