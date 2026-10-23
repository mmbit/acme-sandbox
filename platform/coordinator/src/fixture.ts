// The test company (platform/coordinator/fixture): the coordinator's tests run against it, never a real company's
// files, so they pass in the foundation and in every company that takes it. Call it before the dynamic import()s.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { saveSecrets } from './secrets.ts';

const at = (path: string) => new URL(path, import.meta.url).pathname;

// What a test process makes in the temp folder (its DATA_DIR, the test company's copy, a test's own folders, and what the
// code under test and the processes it starts write there) goes in a folder of its own, removed when the process exits.
const TMP = mkdtempSync(`${tmpdir()}/coordinator-tests-`);
process.env.TMPDIR = TMP;
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

// A throwaway copy as REPO_DIR (tests change it), with this repo's own platform/ and shared/ linked in: HQ's files and
// the kits are the foundation's, not the company's.
export function fixtureRepo() {
  const repo = mkdtempSync(`${tmpdir()}/fixture-repo-`);
  cpSync(at('../fixture'), repo, { recursive: true });
  for (const dir of ['platform', 'shared']) symlinkSync(at(`../../../${dir}`), `${repo}/${dir}`);
  process.env.REPO_DIR = repo;
  return repo;
}

// A supported historical review schema with a ruled pull request still waiting.
export function historicalDatabase(directory = mkdtempSync(`${tmpdir()}/historical-db-`)) {
  const database = new DatabaseSync(`${directory}/hq.db`);
  database.exec(`
    create table events (id integer primary key, ts text not null, type text not null, agent text,
      "to" text, text text, state text);
    create table prs (number integer primary key, branch text not null, author text not null,
      round integer not null default 0, status text not null default 'open', verdict text, sha text,
      merge_rounds integer not null default 0, final_rounds integer not null default 0, since integer not null default 0,
      files text not null default '[]', added integer, removed integer, links text not null default '[]', why text,
      panel text, gate_fails integer not null default 0, fixes_from text, checks_note text not null default '',
      tests_incomplete integer not null default 0, merged_at text);
    insert into prs (number, branch, author, round, status, merge_rounds, final_rounds)
      values (42, 'review/42', 'bolt', 4, 'stuck', 2, 1);
  `);
  database.close();
  return directory;
}

// Cancellations from before cancelJob kept their time, written into a started coordinator's database (its one-off for
// them not yet run): #7 and #71 undated with their lines on the feed (one id the other's prefix), #72 undated with none,
// and #73 cancelled since, dated, whose line is later. Returns each one's time as the one-off should leave it.
export function undatedCancellations(database: DatabaseSync) {
  const cancelled = { 7: '2026-10-03T09:00:00.000Z', 71: '2026-10-04T09:00:00.000Z', 73: '2026-10-05T09:00:00.000Z' };
  database.exec(`
    insert into jobs (id, created, agent, title, prompt, engine, status, finished) values
      (7, '2026-10-01', 'juno', 'Dropped', 'x', 'claude', 'cancelled', null),
      (71, '2026-10-01', 'juno', 'Dropped too', 'x', 'claude', 'cancelled', null),
      (72, '2026-10-01', 'juno', 'Dropped unsaid', 'x', 'claude', 'cancelled', null),
      (73, '2026-10-01', 'juno', 'Dropped since', 'x', 'claude', 'cancelled', '${cancelled[73]}');
    insert into events (ts, type, agent, text) values
      ('${cancelled[7]}', 'log', 'juno', 'Cancelled #7: not needed'),
      ('${cancelled[71]}', 'log', 'juno', 'Cancelled #71: not needed'),
      ('2026-10-06T09:00:00.000Z', 'log', 'juno', 'Cancelled #73: not needed');
    delete from migrations where id = '2026-10-21-dated-cancels';
  `);
  return { ...cancelled, 72: null };
}

// A database from before task codes meant something, written into a started coordinator's (its one-off for them not
// yet run): each job's code a made-up word of its own, under the unique index it had then, and projects with no prefix.
// Returns the jobs' ids by their codes.
export function madeUpCodes(database: DatabaseSync) {
  database.exec(`
    drop index jobs_by_code; drop index projects_code; alter table projects drop column code;
    create unique index jobs_code on jobs (code);
    insert into jobs (created, agent, title, prompt, engine, code) values
      ('2026-10-01', 'juno', 'Earlier', 'x', 'claude', 'KOHOG'),
      ('2026-10-01', 'juno', 'Done', 'x', 'claude', 'NIBIF');
    delete from migrations where id = '2026-10-21-task-codes';
  `);
  const ids = database.prepare("select id, code from jobs where code in ('KOHOG', 'NIBIF')").all() as { id: number; code: string }[];
  return Object.fromEntries(ids.map(j => [j.code, j.id])) as { KOHOG: number; NIBIF: number };
}

// A database from before replies were set (hq reply), written into a started coordinator's (its one-off for them not yet
// run): calls ended and not followed up, each with its work follow-up in another state (fresh: queued, never started;
// paused: queued again with its session and its note; running on Claude, and on Codex; blocked: parked on its card,
// returned as card), and calls whose follow-up isn't asked: one ended done, one the intercom's turn, one whose call is
// followed up. Returns the jobs' ids by their roles.
export function openFollowUps(database: DatabaseSync) {
  const job = (status: string, o: { kind?: string; engine?: string; session?: string; note?: string } = {}) => Number(database.prepare(`insert into jobs
    (created, agent, title, prompt, engine, status, kind, session, note) values ('2026-10-21', 'juno', 'Follow up on your call with the board', 'x', ?, ?, ?, ?, ?)`)
    .run(o.engine ?? 'claude', status, o.kind ?? 'work', o.session ?? null, o.note ?? null).lastInsertRowid);
  const call = (id: number, processed: string | null = null) => database.prepare(`insert into calls (ts, agent, lines, job, processed_at)
    values ('2026-10-21T08:00:00Z', 'juno', '[]', ?, ?)`).run(id, processed);
  const ids = {
    fresh: job('queued'), paused: job('queued', { session: 's-paused', note: 'You were paused.' }), running: job('running', { session: 's-running' }),
    runningCodex: job('running', { engine: 'codex', session: 's-codex' }), blocked: job('blocked', { session: 's-blocked' }),
    done: job('done'), turn: job('running', { kind: 'chat' }), followedUp: job('running', { session: 's-followed' }),
  };
  for (const [role, id] of Object.entries(ids)) call(id, role === 'followedUp' ? '2026-10-21T09:00:00Z' : null);
  const card = Number(database.prepare(`insert into requests (created, agent, job, kind, title, body)
    values ('2026-10-21', 'juno', ?, 'decision', 'Go ahead?', 'Shall I?')`).run(ids.blocked).lastInsertRowid);
  database.prepare('update jobs set request = ? where id = ?').run(card, ids.blocked);
  database.exec("delete from migrations where id = '2026-10-21-calls-reply'");
  return { ...ids, card };
}

// The test company with its process team (roles.process, Bolt's) in a department
// called 'process', and a product team called 'platform' (Chime): a check that names a department id instead of the
// role fails here. Returns the undo.
export function splitPlatform(repo = process.env.REPO_DIR!) {
  const file = `${repo}/company/org.yaml`, before = readFileSync(file, 'utf8');
  const chime = before.match(/^ {6}- \{ id: chime,.*\n/m)![0];
  writeFileSync(file, before.replace(chime, '').replace('- id: platform\n    name: Platform', '- id: process\n    name: Process')
    .replace(/^roles:/m, `  - id: platform\n    name: Platform\n    room: { kind: server, size: s }\n    agents:\n${chime}\nroles:`));
  return () => writeFileSync(file, before);
}

// A file as a GitHub workflow commits it to the deploy branch, and as the coordinator then trusts it (committed.ts). The
// test company becomes a git repo of the files tests commit this way. by: the commit's author and committer (the
// workflows' bot unless a test says otherwise), at: its time in seconds.
const BOT = { name: 'testco-bot', email: '41898282+github-actions[bot]@users.noreply.github.com' };
export function commitFile(path: string, content: string, subject: string,
  { repo = process.env.REPO_DIR!, by = BOT, at = Math.floor(Date.now() / 1000) } = {}) {
  if (!existsSync(`${repo}/.git`)) {   // (with a first commit before the workflow's: the deploy branch has a history)
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'The test company');
  }
  mkdirSync(dirname(`${repo}/${path}`), { recursive: true });
  writeFileSync(`${repo}/${path}`, content);
  git(repo, 'add', '--', path);
  const date = `@${at} +0000`;
  execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], { stdio: 'pipe', env: { ...process.env,
    GIT_AUTHOR_NAME: by.name, GIT_AUTHOR_EMAIL: by.email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: by.name, GIT_COMMITTER_EMAIL: by.email, GIT_COMMITTER_DATE: date } });
}
export const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', stdio: 'pipe' }).trim();

// The names a key save stored, or null when it refused anything (each refusal's reason: the eval key's test in
// security.test.ts)
export const savedNames = (r: ReturnType<typeof saveSecrets>) => typeof r === 'string' || Object.keys(r.refused).length ? null : r.saved;

// Products whose servers call payments.ts: products/<slug>/product.yaml for each slug, with more lines of manifest if
// given (in the harness's before), and the headers each calls with in a mode, its token included (after the harness), or
// another product's or mode's token to prove a refusal.
export function productFolders(repo: string, slugs: string[], manifest = '') {
  for (const slug of slugs) {
    mkdirSync(`${repo}/products/${slug}`, { recursive: true });
    writeFileSync(`${repo}/products/${slug}/product.yaml`, `name: ${slug}\n${manifest}`);
  }
}
export async function productHeaders() {
  const { tokenFor } = await import('./payments.ts');
  return (slug: string, mode = 'test', token = tokenFor(slug, mode)) => ({
    authorization: `Bearer ${token}`,
    'x-product': slug,
    'x-mode': mode,
    'content-type': 'application/json',
  });
}

// A stand-in for Lettermint's POST /v1/send on a port of its own. on() points the email settings at it, with the key the
// board would save unless key is false, and off() takes both away. It answers a request without that key 401. It keeps every email it's sent
// (received) and those it took (taken, each answered 202 with its id, m-<n>). Each email gets the answer script names
// next, else `answer` (a value, or one of the email):
//   'take': a 202; 'slow': a 202 a second later; 'fail': a 500, which may have gone; 'lose': no answer, the connection
//   closed; 'refuse': a 422, the email refused; 'refuse:<field>': a 422 naming the field, as Lettermint refuses an address.
// hold() keeps the answers back until the release it returns is called (the service has the email, HQ no answer yet).
export type LettermintAnswer = 'take' | 'slow' | 'fail' | 'lose' | 'refuse' | `refuse:${string}`;
const LETTERMINT_KEY = 'lm-key-0123456789abcdefghij';
export async function fakeLettermint() {
  let held: Promise<void> | undefined;
  const fake = {
    received: [] as any[],
    taken: [] as any[],
    script: [] as LettermintAnswer[],
    answer: 'take' as LettermintAnswer | ((mail: any) => LettermintAnswer),
    hold() {
      let release = () => {};
      held = new Promise<void>(resolve => (release = resolve));
      return () => ((held = undefined), release());
    },
    on({ key = true } = {}) {
      Object.assign(process.env, { CARE_EMAIL_SERVICE: 'lettermint', EMAIL_API: `http://localhost:${port}/v1` });
      if (!key) return;
      mkdirSync(process.env.SECRETS_DIR!, { recursive: true });
      writeFileSync(`${process.env.SECRETS_DIR}/CARE_EMAIL_API_KEY`, LETTERMINT_KEY);
    },
    off() {
      delete process.env.CARE_EMAIL_SERVICE;
      delete process.env.EMAIL_API;
      rmSync(`${process.env.SECRETS_DIR}/CARE_EMAIL_API_KEY`, { force: true });
    },
  };
  const service = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.headers['x-lettermint-token'] !== LETTERMINT_KEY) return response.writeHead(401).end('{}');
    const mail = JSON.parse(body);
    const answer = fake.script.shift() ?? (typeof fake.answer === 'function' ? fake.answer(mail) : fake.answer);
    fake.received.push(mail);
    if (answer === 'take' || answer === 'slow') fake.taken.push(mail);
    const id = `m-${fake.taken.length}`;
    await held;
    if (answer === 'slow') await new Promise(resolve => setTimeout(resolve, 1000));
    if (answer === 'take' || answer === 'slow') return response.writeHead(202).end(JSON.stringify({ message_id: id }));
    if (answer === 'fail') return response.writeHead(500).end('{}');
    if (answer === 'lose') return response.destroy();
    const field = answer.slice('refuse:'.length);
    const refusal = field
      ? { message: `The ${field} field is refused (${mail.to[0]}).`, errors: { [field]: ['refused'] } }
      : { message: 'bad address' };
    response.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify(refusal));
  });
  await new Promise<void>(resolve => service.listen(0, resolve));
  const { port } = service.address() as AddressInfo;
  after(() => service.close());
  return fake;
}
