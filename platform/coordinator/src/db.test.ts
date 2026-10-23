// node --test src/db.test.ts   (the real coordinator started again on the test company, one per process)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fixtureRepo, historicalDatabase, madeUpCodes, openFollowUps, undatedCancellations } from './fixture.ts';


// The real coordinator on DATA_DIR and REPO_DIR, until it listens; then stopped.
async function start(data: string, repo: string) {
  const server = spawn(process.execPath, [new URL('server.ts', import.meta.url).pathname],
    { env: { ...process.env, DATA_DIR: data, REPO_DIR: repo, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stderr.on('data', d => { out += d; });
  await new Promise<void>((resolve, reject) => {
    server.stdout.on('data', d => { out += d; if (/listening/.test(out)) resolve(); });
    server.on('exit', code => reject(new Error(`the coordinator stopped (${code}): ${out}`)));
  });
  await new Promise(resolve => { server.removeAllListeners('exit').on('exit', resolve); server.kill(); });
}

// A one-off as a company's company/migrations.sql holds it: a job for its live company.
const job = (title: string) => `insert into jobs (created, agent, title, prompt, engine) values ('2026-10-01', 'juno', '${title}', 'x', 'claude');`;
const empty = (db: DatabaseSync) => assert.deepEqual({ ...db.prepare('select (select count(*) from jobs) jobs, (select count(*) from requests) requests').get() }, { jobs: 0, requests: 0 });
const oneOffs = (repo: string) => writeFileSync(`${repo}/company/migrations.sql`, `-- The test company's one-offs\n-- once: test-one\n${job('One')}\n\n-- once: test-two\n${job('Two')}\n`);

test("a new company's first start brings no jobs or requests: one-off fixes are recorded, never run", async () => {
  const data = mkdtempSync(`${tmpdir()}/db-test-`), repo = fixtureRepo();
  oneOffs(repo);
  await start(data, repo);
  const db = new DatabaseSync(`${data}/hq.db`);
  empty(db);
  assert.deepEqual(db.prepare("select id from migrations where id like 'test-%' order by id").all().map((m: any) => m.id), ['test-one', 'test-two'], 'every one-off fix is recorded as done');
});

test("a company's own one-offs (company/migrations.sql) run once at start, on a database with work in it", async () => {
  const data = mkdtempSync(`${tmpdir()}/db-test-`), repo = fixtureRepo();
  await start(data, repo);
  const db = new DatabaseSync(`${data}/hq.db`);   // (work in it: the real database between two starts, no server to ask)
  db.exec("insert into jobs (created, agent, title, prompt, engine) values ('2026-10-01', 'juno', 'Earlier work', 'x', 'claude')");
  oneOffs(repo);
  await start(data, repo);
  await start(data, repo);
  assert.deepEqual(db.prepare("select title from jobs order by id").all().map((j: any) => j.title), ['Earlier work', 'One', 'Two'], 'each once, after a restart too');
});

test("a fresh start's database (infra/reset.py: only the board's sign-ins) is a new company's: no one-off fix runs on it", async () => {
  const data = mkdtempSync(`${tmpdir()}/db-test-`), repo = fixtureRepo();
  const kept = new DatabaseSync(`${data}/hq.db`);
  kept.exec("create table sessions (token text primary key, expires integer not null); insert into sessions values ('board', 9999999999999)");
  kept.close();
  oneOffs(repo);
  await start(data, repo);
  const db = new DatabaseSync(`${data}/hq.db`);
  empty(db);
  assert.equal((db.prepare('select token from sessions').get() as { token: string }).token, 'board', 'the board stays signed in');
});

test("a database from before the migrations table (events, no migrations) isn't a new one: its one-off fixes run", async () => {
  const data = mkdtempSync(`${tmpdir()}/db-test-`), repo = fixtureRepo();
  const old = new DatabaseSync(`${data}/hq.db`);
  old.exec('create table events (id integer primary key, ts text not null, type text not null, agent text, "to" text, text text, state text)');
  old.close();
  oneOffs(repo);
  await start(data, repo);
  assert.throws(() => empty(new DatabaseSync(`${data}/hq.db`)), 'the one-offs ran');
});

test("an older database keeps its jobs' codes, and a task's later step shares its task's", async () => {
  const data = mkdtempSync(`${tmpdir()}/db-test-`), repo = fixtureRepo();
  await start(data, repo);
  const db = new DatabaseSync(`${data}/hq.db`);
  const { KOHOG } = madeUpCodes(db);
  await start(data, repo);
  assert.deepEqual(db.prepare('select code from jobs order by id').all().map((j: any) => j.code), ['KOHOG', 'NIBIF']);
  // a retry of the earlier job, as HQ makes it in a coordinator of its own
  const retry = `const jobs = await import(${JSON.stringify(new URL('./jobs.ts', import.meta.url).href)});
    console.log(jobs.createJob({ agent: 'juno', title: 'Earlier, again', prompt: 'x', engine: 'claude', insteadOf: ${KOHOG} }).code);`;
  const made = execFileSync(process.execPath, ['--input-type=module', '-e', retry], { env: { ...process.env, DATA_DIR: data, REPO_DIR: repo }, encoding: 'utf8' });
  assert.equal(made.trim(), 'KOHOG');
});

test('a historical review database keeps its waiting pull request across restarts', async () => {
  const directory = historicalDatabase(), repo = fixtureRepo();
  await start(directory, repo);
  await start(directory, repo);
  const database = new DatabaseSync(`${directory}/hq.db`);
  assert.deepEqual({ ...database.prepare('select branch, round, status from prs where number = 42').get() },
    { branch: 'review/42', round: 4, status: 'stuck' });
  database.close();
});

test('a start dates each undated cancellation by its line on the feed, once', async () => {
  const directory = mkdtempSync(`${tmpdir()}/db-test-`), repo = fixtureRepo();
  await start(directory, repo);
  const db = new DatabaseSync(`${directory}/hq.db`);
  const expected = undatedCancellations(db);
  const finished = () => Object.fromEntries(db.prepare(`select id, finished from jobs where id in (${Object.keys(expected).join(', ')})`).all().map((j: any) => [j.id, j.finished]));
  await start(directory, repo);
  assert.deepEqual(finished(), expected, "each its own line's time; one with none stays undated; one dated keeps its time");
  await start(directory, repo);
  assert.deepEqual(finished(), expected, 'a restart changes none');
});

test('a work follow-up briefed before replies were set is asked for hq reply where its next run reads it, once', async () => {
  const directory = mkdtempSync(`${tmpdir()}/db-test-`), repo = fixtureRepo();
  await start(directory, repo);
  const db = new DatabaseSync(`${directory}/hq.db`);
  const ids = openFollowUps(db);
  // (in the coordinator's own modules, as HQ runs them between starts: the last line printed is the answer)
  const inHq = (code: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...process.env, DATA_DIR: directory, REPO_DIR: repo }, encoding: 'utf8' }).trim().split('\n').at(-1)!);
  const reads = (id: number) => ({ ...db.prepare('select prompt, note from jobs where id = ?').get(id) as { prompt: string; note: string | null } });
  const asks = /`hq reply "\.\.\."`/;
  await start(directory, repo);
  assert.match(reads(ids.fresh).prompt, /^x\n\n/, 'one that never started: its brief');
  assert.match(reads(ids.fresh).prompt, asks);
  assert.match(reads(ids.paused).note!, /^You were paused\.\n\n/, 'one paused with its session: its note, after what it said');
  assert.match(reads(ids.paused).note!, asks);
  // Parked on its card, or running on Codex: nothing it reads changes yet (owed). Its card answered, it's asked.
  for (const id of [ids.blocked, ids.runningCodex]) assert.deepEqual(reads(id), { prompt: 'x', note: null });
  const answered = inHq(`const jobs = await import(${JSON.stringify(new URL('./jobs.ts', import.meta.url).href)});
    console.log(JSON.stringify(jobs.answerRequest(${ids.card}, 'Yes, go ahead.')));`);
  assert.equal(typeof answered, 'object', 'the board answers the card');
  await start(directory, repo);
  await start(directory, repo);
  assert.match(reads(ids.blocked).note!, /Yes, go ahead\.[^]*`hq reply/, 'one whose card is answered: after the answer, in its note');
  assert.deepEqual(reads(ids.runningCodex), { prompt: 'x', note: null });
  for (const id of [ids.done, ids.turn, ids.followedUp]) assert.deepEqual(reads(id), { prompt: 'x', note: null }, "an ended one, the intercom's turn, one whose call is followed up");
  // What each session's hook brings at its next step (hq inbox --hook)
  const inbox = inHq(`const messages = await import(${JSON.stringify(new URL('./messages.ts', import.meta.url).href)});
    console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.entries(ids))}.map(([role, id]) => [role, messages.take(id).map(m => m.text)]))));`);
  assert.equal(inbox.running.length, 1, 'one running on Claude: a message, once across restarts');
  assert.match(inbox.running[0], asks);
  for (const [role, texts] of Object.entries(inbox)) if (role !== 'running') assert.deepEqual(texts, [], role);
  assert.equal(reads(ids.fresh).prompt.match(/hq reply/g)!.length, 1, 'asked once across restarts');
  assert.equal(reads(ids.paused).note!.match(/hq reply/g)!.length, 1);
});
