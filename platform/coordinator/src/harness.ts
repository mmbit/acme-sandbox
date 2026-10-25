// The coordinator's tests' one harness: the test company (fixture.ts) in a throwaway DATA_DIR, the server on a free
// port, its callers (the worker, an agent's hq, the board's HQ) and a job's life through the worker's own routes, so a
// test sets state the way it's set in life and reads it where a caller does. GitHub is played here (`github`): the
// only thing the coordinator reaches that leaves the machine.
// this file, the *.test.ts files rewritten onto it, and the exports it made
// needless (each tagged where it was)
//
//   const h = await harness('inflight');               // before any other import of the coordinator's modules
//   const job = await h.start({ agent: 'bolt' });      // made and claimed, as the worker claims it
//   await h.finish(job, { status: 'done', pr: 12, branch: 'job/12', sha: 'abc' });
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureRepo } from './fixture.ts';
import { recordedReviews, type JobFields } from './reviewfixture.ts';
import { recordedPastJobs } from './pastjobs.fixture.ts';
import { recordedCalls } from './calls.fixture.ts';
import { codedArgs, codedBody, word } from './testwords.ts';

export const WORKER_TOKEN = 'worker-secret',
  VOICE_TOKEN = 'voice-secret';
const HQ = new URL('../../worker/bin/hq', import.meta.url).pathname;

type Reply = { status: number; body: any };
// an event of HQ's feed (stream: history, a replayed row; statuses, who's at work now.)
type Fed = { type: string; agent: string; text: string; history?: boolean; statuses?: Record<string, unknown> };
export type Running = { id: number; token: string; seat: string; agent: string; [k: string]: any };

// env: settings the code reads as it loads (on top of the test company's). before(repo): changes to the test company's
// files the code reads as it loads. serve: false for a test of a module that never meets a caller over HTTP.
export async function harness(
  name: string,
  {
    env = {},
    before,
    serve = true,
  }: { env?: Record<string, string>; before?: (repo: string) => void; serve?: boolean } = {},
) {
  const repo = fixtureRepo(),
    dataDir = mkdtempSync(`${tmpdir()}/${name}-test-`);
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    SECRETS_DIR: `${dataDir}/secrets`,
    WORKER_TOKEN,
    VOICE_TOKEN,
    GITHUB_TOKEN: 'test',
    REPO: 'company/test',
    KITS_DIR: `${repo}/kits`,
    ...env,
  }); // (the test company's kits: none unless a test makes some)
  before?.(repo);
  const github = playGithub();
  const { db } = await import('./db.ts');
  const jobs = await import('./jobs.ts');
  const { cancelJob } = await import('./ledger.ts');
  const { ORIGIN } = await import('./config.ts');

  let base = '';
  if (serve) {
    const { app } = await import('./server.ts');
    const server = createServer(app).listen(0);
    server.keepAliveTimeout = 0;
    await new Promise(r => server.once('listening', r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    test.after(() => server.close());
  }

  // A route with a bearer token: a JSON body makes it a POST.
  const call = async (path: string, token: string, body?: unknown): Promise<Reply> => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const worker = (route: string, body?: unknown) => call(`/api/worker/${route}`, WORKER_TOKEN, body ?? {});
  // (a task or project made without a code gets one: testwords.ts.)
  const agent = (route: string, token: string, body?: unknown) =>
    call(`/api/agent/${route}`, token, codedBody(route, body));
  const voice = (route: string, body?: unknown) => call(`/api/voice/${route}`, VOICE_TOKEN, body);
  // Any other caller with its own headers (a product's server with its token, the imitation checkout's page): its raw
  // reply, a redirect not followed. A body that isn't a string (or bytes, a file's) goes as JSON and makes it a POST.
  const send = (
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    new Promise<{ status: number; headers: Record<string, any>; json: any; text: string }>((resolve, reject) => {
      const payload =
        body === undefined || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const q = request(base + path, { method, headers }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => (text += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON: text has it */
          }
          resolve({ status: res.statusCode!, headers: res.headers, json, text });
        });
      });
      q.on('error', reject);
      q.end(payload);
    });

  // The board, signed in to HQ (a passkey's sign-in, which a test can't make, leaves this session row), from HQ's own
  // pages (their Origin).
  const session = `board-${name}`;
  db.prepare('insert into sessions (token, expires) values (?, ?)').run(session, Date.now() + 86_400_000);
  const boardCookie = `s=${session}`;
  const board = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Reply> => {
    const res = await fetch(base + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { cookie: boardCookie, origin: ORIGIN, 'content-type': 'application/json' },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // The real hq script, as the job's agent runs it.
  // (dir: the job's folder, where hq request --park leaves its card for the worker; tmp: the job's own TMPDIR; call: run
  // as the voice line does on a call, HQ_CALL set)
  const hq = (job: { token: string; agent: string; dir?: string; tmp?: string; call?: boolean }, ...args: string[]) =>
    new Promise<{ code: number; out: string }>(r =>
      execFile(
        'bash',
        [HQ, ...codedArgs(args)],
        {
          env: {
            PATH: process.env.PATH,
            HQ_URL: base,
            HQ_TOKEN: job.token,
            HQ_AGENT: job.agent,
            ...(job.dir ? { HQ_JOB_DIR: job.dir } : {}),
            ...(job.tmp ? { TMPDIR: job.tmp } : {}),
            ...(job.call ? { HQ_CALL: '1' } : {}),
          },
        },
        (e, out, err) => r({ code: e ? Number(e.code) : 0, out: out + err }),
      ),
    );

  // A job's life, as the worker lives it. A job made here runs on an engine of its own unless the test names one, so
  // the claim takes this job and no other.
  let planningSlots: Record<string, number> | undefined;
  const reportCapacity = async () => {
    const engines = db.prepare('select distinct engine from jobs').all() as { engine: string }[];
    const isolated = engines.map(j => [j.engine, 1]);
    const slots: Record<string, number> = { ...Object.fromEntries(isolated), ...planningSlots };
    const capacity = { slots, seatRuns: slots, room: Object.values(slots).reduce((sum, n) => sum + n, 0) };
    assert.equal((await worker('room', { capacity })).status, 200);
  };
  // A test worker's configured slots, plus the isolated engines the harness gives its actors.
  const capacity = async (slots: Record<string, number>) => {
    planningSlots = slots;
    for (const engine of Object.keys(slots))
      assert.equal((await worker('seat', { seat: `capacity-${engine}`, engine, state: 'ready', util: 0 })).status, 200);
    await reportCapacity();
  };
  const cancelQueued = () => {
    for (const job of jobs.listJobs() as { id: number; status: string }[])
      if (job.status === 'queued') cancelJob(job.id, 'Test finished');
  };
  let seats = 0,
    engines = 0;
  const claim = async (engine = 'claude', extra: Record<string, unknown> = {}): Promise<Running | null> => {
    const seat = String(extra.seat ?? `seat-${++seats}`),
      r = await worker('claim', { ...extra, seat, engine });
    assert.equal(r.status, 200);
    if (planningSlots) await reportCapacity();
    return r.body && { ...r.body, seat };
  };
  // A job HQ made (a follow-up, an intercom turn), alone on an engine of its own, its wait over.
  const claimJob = async (id: number) => {
    const row = db.prepare("update jobs set engine = 'own-' || id, not_before = 0 where id = ? returning kind").get(id);
    return (await claim(`own-${id}`, (row as { kind: string }).kind === 'chat' ? { kind: 'chat' } : {}))!;
  };
  const queue = (j: JobFields) =>
    jobs.createJob({ title: `${j.agent}'s job`, prompt: 'x', engine: `engine-${++engines}`, word: word(), ...j } as any)
      .id as number;
  const start = async (j: JobFields, extra: Record<string, unknown> = {}) => {
    const id = queue(j),
      engine = j.engine ?? `engine-${engines}`;
    const job = await claim(engine, extra);
    assert.equal(job?.id, id, `job #${id} is claimed`);
    return job!;
  };
  const heartbeat = (job: Running, body: Record<string, unknown> = {}) =>
    worker('heartbeat', { job: job.id, seat: job.seat, ...body });
  const finish = (job: Running, body: Record<string, unknown> = { status: 'done' }) =>
    worker('finish', { job: job.id, seat: job.seat, status: 'done', ...body });
  // A card the job parks on (hq request): its id on the desk phone.
  const park = async (job: Running, request: Record<string, unknown>) => {
    const r = await finish(job, {
      status: 'parked',
      request: { kind: 'decision', urgency: 'today', title: 'A question', body: 'Which?', ...request },
    });
    assert.equal(r.status, 200);
    const card = (await board('/api/requests')).body.find((c: any) => c.job === job.id);
    assert.ok(card, `job #${job.id} parked on a card`);
    return card.id as number;
  };
  const answer = (id: number, answer: string, more: Record<string, unknown> = {}) =>
    board('/api/requests/answer', { id, answer, ...more });
  // A card a running job asks the board live (hq ask): its id.
  const ask = async (job: Running, card: Record<string, unknown> = {}) => {
    const r = await agent('request', job.token, { kind: 'decision', title: 'A question', body: 'Which?', ...card });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  // A thread with a window (windows.ts): its id, for the jobs a test puts on it (createJob thread). Its aim is its
  // deadline unless given; juno gave the time unless `by` says who.
  let threads = 0;
  const dueThread = (o: { deadline?: number; aim?: number; by?: string } = {}) => {
    const id = `due/thread-${++threads}`;
    // (in a project HQ has, juno's: plan.ts reads it)
    db.prepare(
      `insert or ignore into projects (id, name, owner, created, by) values ('due', 'Due', 'juno', ?, 'juno')`,
    ).run(new Date().toISOString());
    db.prepare(
      `insert into threads (id, project, name, owner, goal, created, deadline, aim, deadline_by)
      values (?, 'due', ?, 'juno', 'It ships', ?, ?, ?, ?)`,
    ).run(
      id,
      `Thread ${threads}`,
      new Date().toISOString(),
      o.deadline ?? null,
      o.aim ?? o.deadline ?? null,
      o.deadline == null ? null : (o.by ?? 'juno'),
    );
    return id;
  };
  // A stored state for tests of work already merged on GitHub.
  const { mergedPr, ended, storedPr, failedJobs, clearReviewHistory } = recordedReviews(db, queue);
  // Jobs that ended before the test.
  const pastJob = recordedPastJobs(db, { storedPr, mergedPr });
  const { storedCall, liveCall } = recordedCalls(db, voice);
  // A job as HQ lists it (its status, result, note...)
  const job = (id: number) => (jobs.listJobs() as any[]).find(j => j.id === id);
  // A persisted stuck review whose replacement can still report.
  const stuckReview = (pr: number) => db.prepare("update prs set status = 'stuck' where number = ?").run(pr);
  // A persisted review transferred to another owner.
  const transferPr = (pr: number, author: string) =>
    db.prepare('update prs set author = ? where number = ?').run(author, pr);
  // HQ's feed as a page opens it (/api/events): its latest 50 events, oldest first, then who's at work now (stream; feed:
  // the events alone.)
  const stream = async () => {
    const stop = new AbortController(),
      res = await fetch(base + '/api/events', { headers: { cookie: boardCookie }, signal: stop.signal });
    const reader = res.body!.getReader(),
      text = new TextDecoder();
    let all = '';
    for (;;) {
      // (what's there at once: then the stream only pings)
      const r = await Promise.race([reader.read(), new Promise<null>(done => setTimeout(done, 100, null))]);
      if (!r || r.done) break;
      all += text.decode(r.value);
    }
    stop.abort();
    return all
      .split('\n\n')
      .filter(l => l.startsWith('data: '))
      .map(l => JSON.parse(l.slice(6))) as Fed[];
  };
  const feed = async () => (await stream()).filter(e => e.type !== 'statuses');

  return {
    repo,
    dataDir,
    base,
    db,
    jobs,
    github,
    call,
    send,
    worker,
    agent,
    voice,
    board,
    boardCookie,
    hq,
    queue,
    capacity,
    cancelQueued,
    claim,
    claimJob,
    start,
    heartbeat,
    finish,
    park,
    answer,
    ask,
    job,
    stuckReview,
    transferPr,
    feed,
    stream,
    dueThread,
    mergedPr,
    ended,
    storedPr,
    failedJobs,
    clearReviewHistory,
    storedCall,
    liveCall,
    pastJob,
  };
}

// Waits for what goes on after a route has answered (GitHub's merge, an email the service holds): until `ready()` holds,
// or the test fails naming what it waited for, rather than hang.
export async function until(ready: () => unknown, what: string, ms = 5_000) {
  for (const stop = Date.now() + ms; !ready(); await new Promise(r => setTimeout(r, 2)))
    if (Date.now() > stop) throw new Error(`Still waiting after ${ms / 1000} s: ${what}`);
}

// GitHub, played: the pull requests the coordinator merges, reads and closes, each open until something happens to it.
// A test sets how GitHub answers (`pr(n)`'s fields, or `refuse` for the next merge) and reads what happened to the pull
// request (its state, the title it was merged under), never which calls were made. Anything else goes to the real fetch.
export type PullRequest = {
  state: 'open' | 'closed';
  added?: string; // what its diff adds (github.ts pullRequestDiff)
  files?: import('./github.ts').PullRequestFile[]; // GitHub's own list of its files, in place of `added`'s
  merged: boolean;
  mergeable: boolean | null;
  head: string;
  base: string;
  aheadBy: number;
  title?: string;
  mergedSha?: string;
};
function playGithub() {
  const pulls = new Map<number, PullRequest>();
  const pr = (n: number) => {
    if (!pulls.has(n))
      pulls.set(n, { state: 'open', merged: false, mergeable: true, head: `h${n}`, base: 'main', aheadBy: 2 });
    return pulls.get(n)!;
  };
  // the next merges' answers, in turn (a status and GitHub's message): a race with main, a moved branch...
  const refuse: { status: number; message: string }[] = [];
  // a hook before GitHub answers: a test holds an answer back (a slow or silent GitHub) by returning a promise
  const gh = {
    pr,
    pulls,
    refuse,
    wait: undefined as undefined | ((method: string, n: number, signal?: AbortSignal | null) => Promise<void> | void),
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/')) return real(url, init);
    const method = init.method ?? 'GET',
      n = Number(u.match(/\/pulls\/(\d+)/)?.[1]);
    const compared = u.match(/\/compare\/[^/]+\.\.\.h(\d+)$/);
    await gh.wait?.(method, compared ? Number(compared[1]) : n, init.signal);
    if (compared) return json({ ahead_by: pr(Number(compared[1])).aheadBy });
    const p = pr(n);
    // the files' diffs (github.ts pullRequestDiff): a test sets what a pull request adds as p.added, a page at a time
    if (method === 'GET' && u.includes('/files')) {
      const query = new URL(u).searchParams,
        size = Number(query.get('per_page') ?? 30),
        page = Number(query.get('page') ?? 1);
      const files = p.files ?? [{ patch: (p.added ?? '').replace(/^/gm, '+') }];
      return json(files.slice((page - 1) * size, page * size));
    }
    if (method === 'GET')
      return json({
        merged: p.merged,
        state: p.state,
        mergeable: p.mergeable,
        base: { ref: p.base },
        head: { sha: p.head },
      });
    if (method === 'PATCH') {
      p.state = 'closed';
      return json({});
    }
    // PUT: the merge
    const { commit_title, sha } = JSON.parse(String(init.body));
    if (p.state !== 'open') return json({ message: 'Pull Request is not mergeable' }, 405);
    const refusal = refuse.shift();
    if (refusal) return json({ message: refusal.message }, refusal.status);
    if (p.mergeable === false) return json({ message: 'Pull Request is not mergeable' }, 405);
    Object.assign(p, { state: 'closed', merged: true, title: commit_title, mergedSha: sha });
    return json({ merged: true });
  }) as typeof fetch;
  return gh;
}
