// Work that starts on an event HQ hears of (hq job --when), so no job holds a seat polling for it: the next deploy or
// the next few, a deploy that recreated a given container, a job's or pull request's work merged and deployed, or a
// time. A wake holds its queued job (jobs.ts READY) until it's met, and the job's note says what happened. Deploys are
// counted from when the job was queued (those that began after it). The server writes a record of each deploy into
// this data folder (infra/deploys.py, called by sync.sh), read here before every claim.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { db, prepared } from './db.ts';
import { publish } from './events.ts';
import * as windows from './windows.ts';

// followed: a call followed up (or given up on), the coordinator's own (ledger.ts followUp), never --when's. ended: the
// call a job was queued on has ended (server.ts), never --when's either.
// sorted: HQ's own job from a template, sorted into the plan by its owner (sorting.ts), which meets it; never --when's.
export type Wake = { kind: 'deploy' | 'recreated' | 'deployed' | 'at' | 'followed' | 'ended' | 'sorted'; arg: string };
type WakeRow = Wake & { job: number; since: number };
type Deploy = {
  file: string;
  sha: string;
  fetched: string;
  finished: string;
  ok: number;
  recreated: string;
  reloaded: string;
};

const MAX_DEPLOYS = 50;
const SERVICE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
// (a time's forms as windows.ts parse reads them)
export const FORMS =
  'deploy, deploy:<n> (the next n deploys), recreated:<service> (a deploy that recreates that container), ' +
  "deployed:<job> or deployed:pr:<n> (that work merged and deployed), or a time ahead (2h, 90m, 2026-10-26 09:00 on the company's clock, 14:30 UTC)";

// --when's text as a wake, or why it can't be read
export function parse(text: string, now = Date.now()): Wake | string {
  const given = text.trim();
  const deploys = /^deploy(?::(\d{1,3}))?$/i.exec(given),
    recreated = /^recreated:(.+)$/i.exec(given),
    deployed = /^deployed:(pr:)?(\d{1,9})$/i.exec(given);
  if (deploys) {
    const n = Number(deploys[1] ?? 1);
    return n >= 1 && n <= MAX_DEPLOYS
      ? { kind: 'deploy', arg: String(n) }
      : `--when deploy:<n> counts 1 to ${MAX_DEPLOYS} deploys`;
  }
  if (recreated)
    return SERVICE.test(recreated[1])
      ? { kind: 'recreated', arg: recreated[1] }
      : `--when recreated: names a container's service, like worker`;
  if (deployed) return { kind: 'deployed', arg: `${deployed[1] ? 'pr:' : ''}${Number(deployed[2])}` };
  const at = windows.parse(given, now, true);
  if (typeof at === 'string') return `can't read --when "${given.slice(0, 40)}": give ${FORMS}`;
  return at > now ? { kind: 'at', arg: String(at) } : `--when "${given.slice(0, 40)}": that time has passed already`;
}

// What hq job or a card (later.ts holdsFor) sent as --when (one, or a list) as wakes, or why it can't wait for them
export function readWhen(given: unknown, now = Date.now()): Wake[] | string {
  const texts = Array.isArray(given) ? given : given == null ? [] : [given];
  const wakes: Wake[] = [];
  for (const text of texts) {
    const wake = parse(String(text), now);
    if (typeof wake === 'string') return wake;
    wakes.push(wake);
  }
  return refusal(wakes) ?? wakes;
}

// Why a job can't wait for these, or undefined: a deployed: names work HQ knows, and a recreated: a service the last
// deploy's record lists (any, before the first record).
function refusal(wakes: Wake[]) {
  const lastDeploy = db.prepare('select services from deploys order by finished desc limit 1').get() as
    { services: string } | undefined;
  const services = JSON.parse(lastDeploy?.services ?? '[]') as string[];
  for (const w of wakes) {
    if (w.kind === 'recreated' && services.length && !services.includes(w.arg))
      return `the server has no ${w.arg} container (${services.join(', ')})`;
    if (w.kind === 'deployed' && !knowsWork(w.arg))
      return `there's no ${w.arg.startsWith('pr:') ? `pull request #${w.arg.slice(3)}` : `work job #${w.arg}`}`;
  }
}

const knowsWork = (arg: string) =>
  arg.startsWith('pr:')
    ? db.prepare('select 1 from prs where number = ?').get(Number(arg.slice(3)))
    : db.prepare("select 1 from jobs where id = ? and kind = 'work'").get(Number(arg));

export function hold(job: number, wakes: Wake[], since = Date.now()) {
  for (const w of wakes)
    db.prepare('insert or ignore into wakes (job, kind, arg, since) values (?, ?, ?, ?)').run(
      job,
      w.kind,
      w.arg,
      since,
    );
}

// Before every claim: the wakes met since, and a job whose last wake is met gets a note with what happened.
export function check(now = Date.now()) {
  readDeploys();
  const waiting = db
    .prepare(
      `select w.job, w.kind, w.arg, w.since from wakes w join jobs j on j.id = w.job
    where w.met is null and j.status = 'queued'`,
    )
    .all() as WakeRow[];
  const woken = new Set<number>();
  for (const w of waiting) {
    const met = metBy(w, now);
    if (met === null) continue;
    db.prepare('update wakes set met = ? where job = ? and kind = ? and arg = ?').run(met, w.job, w.kind, w.arg);
    woken.add(w.job);
  }
  for (const id of woken) {
    if (db.prepare('select 1 from wakes where job = ? and met is null').get(id)) continue;
    const met = (db.prepare('select met from wakes where job = ? order by rowid').all(id) as { met: string }[]).map(
      r => r.met,
    );
    db.prepare("update jobs set note = coalesce(note || char(10) || char(10), '') || ? where id = ?").run(
      `This job waited and starts now: ${met.join('; ')}.`,
      id,
    );
    const { agent } = db.prepare('select agent from jobs where id = ?').get(id) as { agent: string };
    publish({ type: 'log', agent, text: `#${id} can start: ${met.join('; ')}` });
  }
}

// What a queued job still waits for, in words (hq jobs, the projects view.)
export function pending(job: number): string[] {
  return unmet(job).map(describeWake);
}

// The wakes a queued job still waits for
const unmet = (job: number) =>
  prepared('select kind, arg, since from wakes where job = ? and met is null order by rowid').all(job) as WakeRow[];

// The server's deploy records not read yet (one file each, written whole by a rename). A file read once isn't read again,
// and one taken into the deploys table goes, said in the log: the table is what the wakes count.
const readFiles = new Set<string>();
export function readDeploys(dir = `${DATA_DIR}/deploys`) {
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json') && !readFiles.has(f));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`wakes: couldn't read the deploy records in ${dir}:`, err);
    return;
  }
  const names = (v: unknown) =>
    JSON.stringify(Array.isArray(v) ? v.filter(s => typeof s === 'string' && SERVICE.test(s)) : []);
  const iso = (v: unknown) => {
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  };
  for (const file of files) {
    readFiles.add(file);
    try {
      const record = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
      const fetched = iso(record.fetched),
        finished = iso(record.finished);
      if (typeof record.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(record.sha) || !fetched || !finished)
        throw new Error('not a deploy record');
      db.prepare(
        `insert or ignore into deploys (file, sha, fetched, finished, ok, recreated, reloaded, services) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        file,
        record.sha,
        fetched,
        finished,
        record.ok === true ? 1 : 0,
        names(record.recreated),
        names(record.reloaded),
        names(record.services),
      );
    } catch (err) {
      console.error(`wakes: the deploy record ${file} wasn't read:`, (err as Error).message);
      continue;
    }
    // (the folder is the coordinator's once infra/deploys.py has given it the data folder's owner, after a deploy)
    try {
      rmSync(`${dir}/${file}`);
      console.log(`wakes: deploy record ${file} taken in, its file removed`);
    } catch (err) {
      console.error(`wakes: deploy record ${file} taken in, its file kept:`, (err as Error).message);
    }
  }
}

// (exported for jobs.ts stillHolds)
export const clock = (t: number | string) => {
  const s = new Date(t).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
};
const list = (json: string) => (JSON.parse(json) as string[]).join(', ');
const describeDeploy = (deploy: Deploy) =>
  `deploy ${deploy.sha.slice(0, 9)} finished at ${clock(deploy.finished)}` +
  (deploy.recreated !== '[]' ? ` (recreated: ${list(deploy.recreated)})` : ' (recreated nothing)') +
  (deploy.reloaded !== '[]' ? ` (reloaded: ${list(deploy.reloaded)})` : '');
// (begun after `since`: one that fetched main before it doesn't have all the work done by then; both clocks are the server's)
const successfulDeploysSince = (since: number) =>
  db
    .prepare('select * from deploys where ok = 1 and fetched > ? order by finished, file')
    .all(new Date(since).toISOString()) as Deploy[];
const describeWake = (w: WakeRow) => {
  if (w.kind === 'at') return `at ${clock(Number(w.arg))}`;
  if (w.kind === 'recreated') return `after a deploy that recreates ${w.arg}`;
  if (w.kind === 'deployed') return `once ${workOf(w.arg)}'s work is merged and deployed`;
  if (w.kind === 'followed') return `once call #${w.arg}'s follow-up has finished`;
  if (w.kind === 'ended') return `once call #${w.arg} ends`;
  if (w.kind === 'sorted') return "once its project's owner sorts it into the plan (hq inbox)";
  const n = Number(w.arg),
    deploysSoFar = successfulDeploysSince(w.since).length;
  return n === 1 ? 'after the next deploy' : `after ${n} deploys (${deploysSoFar} so far)`;
};
export const workOf = (arg: string) => (arg.startsWith('pr:') ? `pull request #${arg.slice(3)}` : `#${arg}`);

// The first deploy that has work merged at `merged` (an ISO time): one that fetched main after the merge (main only
// moves on).
function deployedAfter(merged: string) {
  return db
    .prepare('select * from deploys where ok = 1 and fetched > ? order by finished, file limit 1')
    .get(new Date(merged).toISOString()) as Deploy | undefined;
}

// The pull request a deployed: wake waits for, or why it never will deploy
type PullRequestRow = { number: number; status: string; merged_at: string | null };
function prOf(arg: string): PullRequestRow | { never: string } | undefined {
  if (arg.startsWith('pr:')) {
    const pr = db.prepare('select number, status, merged_at from prs where number = ?').get(Number(arg.slice(3))) as
      PullRequestRow | undefined;
    return pr?.status === 'closed' ? { never: `pull request #${pr.number} was closed without merging` } : pr;
  }
  const job = db.prepare('select id, status, branch from jobs where id = ?').get(Number(arg)) as
    { id: number; status: string; branch: string | null } | undefined;
  if (!job) return { never: `there's no job #${arg}` };
  const branch = job.branch ?? `job/${job.id}`;
  const pr = db
    .prepare('select number, status, merged_at from prs where branch = ? order by number desc limit 1')
    .get(branch) as PullRequestRow | undefined;
  if (pr?.status === 'closed') return { never: `#${job.id}'s pull request #${pr.number} was closed without merging` };
  if (
    !pr &&
    ['done', 'failed', 'stopped', 'cancelled'].includes(job.status) &&
    !(job.status === 'done' && toCome(branch))
  )
    return { never: `#${job.id} ended (${job.status}) without a pull request` };
  return pr;
}
// Whether a branch's pull request is still to come: it's an open thread's branch, whose next push opens it, or a job
// still at work on it.
const toCome = (branch: string) =>
  !!db
    .prepare(
      `select 1 from threads where branch = $branch and status = 'open' union all select 1 from jobs
      where kind = 'work' and status in ('queued', 'running', 'blocked') and coalesce(branch, 'job/' || id) = $branch`,
    )
    .get({ branch });

// What met a wake, in words, or null while it waits
function metBy(w: WakeRow, now: number): string | null {
  if (w.kind === 'sorted') return null; // (sorting.ts meets it)
  if (w.kind === 'at') return Number(w.arg) <= now ? `the time came (${clock(Number(w.arg))})` : null;
  if (w.kind === 'deploy') {
    const n = Number(w.arg),
      deploy = successfulDeploysSince(w.since)[n - 1];
    return deploy
      ? `${n === 1 ? 'a deploy' : `${n} deploys`} since it was queued, the last: ${describeDeploy(deploy)}`
      : null;
  }
  if (w.kind === 'recreated') {
    const deploy = successfulDeploysSince(w.since).find(x => (JSON.parse(x.recreated) as string[]).includes(w.arg));
    return deploy ? `a deploy recreated ${w.arg}: ${describeDeploy(deploy)}` : null;
  }
  if (w.kind === 'followed') {
    const call = db.prepare('select status, processed_at, job from calls where id = ?').get(Number(w.arg)) as
      { status: string; processed_at: string | null; job: number | null } | undefined;
    if (!call) return `call #${w.arg} is gone`;
    if (call.processed_at) return `call #${w.arg} is followed up (job #${call.job})`;
    return call.status === 'failed'
      ? `call #${w.arg}'s follow-up stopped trying, so what was said on it may not be handled`
      : null;
  }
  // (a call that ended with nothing said leaves no row, and its number can come back for a later call: call.ts handOver)
  if (w.kind === 'ended') {
    const call = db.prepare('select status, ts from calls where id = ?').get(Number(w.arg)) as
      { status: string; ts: string } | undefined;
    return !call || call.status !== 'live' || Date.parse(call.ts) > w.since ? `call #${w.arg} ended` : null;
  }
  const done = deployed(w.arg);
  if (!done) return null;
  if ('never' in done) return `${workOf(w.arg)}'s work will never deploy: ${done.never}`;
  const { pr, deploy } = done;
  return `${workOf(w.arg)}'s work (pull request #${pr.number}, merged ${clock(pr.merged_at!)}) is deployed: ${describeDeploy(deploy)}`;
}

// A job's or pull request's work (a deployed: wake's arg) merged and deployed: its pull request and the first deploy that
// has it; why it never will; or null while it waits. Also feedback.ts's thank-you for a fixed note.
export function deployed(arg: string): { pr: PullRequestRow; deploy: Deploy } | { never: string } | null {
  const pr = prOf(arg);
  if (!pr || 'never' in pr) return pr ?? null;
  if (pr.status !== 'merged' || !pr.merged_at) return null;
  const deploy = deployedAfter(pr.merged_at);
  return deploy ? { pr, deploy } : null;
}
