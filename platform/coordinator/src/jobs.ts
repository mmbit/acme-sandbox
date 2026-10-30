// The job queue. Every piece of agent work is a job; seats (Claude/Codex logins) run them.
// Jobs that hit a usage limit wait for the reset and resume in the same session; jobs that need
// the board park on a request and resume with the answer.
// (its messages say deliverable, the board's word for a thread)
import * as ordering from './ordering.ts';
import * as carries from './carries.ts';
import { windowUsed } from '../../worker/src/pace.ts';
import * as sizes from './sizes.ts';
import * as predictions from './predictions.ts';
import * as reviewroom from './reviewroom.ts';
import * as redraws from './redraws.ts';
import { lastPlayed } from './forecast.ts';
import { deadlinePressure, pacedTakes, spareOnly, type Order } from './planner.ts';
import { measuredMb, plannerCapacity, pauseBudget } from './room.ts';
import { db, inOneStep, mergePending, once, planChange, prepared, scrub } from './db.ts';
import { codeIn, codeOf, numbered } from './jobcodes.ts';
import { publish, redact, redactJob, status, type RunningJob } from './events.ts';
import { createHash, randomBytes } from 'node:crypto';
import {
  org,
  brand,
  ceo,
  companyTime,
  names,
  infra,
  roles,
  reads,
  timeZone,
  yamlFile,
  titleOf,
  voiceOf,
  projects,
} from './company.ts';
import { deskName } from './wherework.ts';
import { unshelvedProblem } from './library.ts';
import { languageName } from './language.ts';
import { stylePrompt } from './style.ts';
import { REPO_DIR } from './config.ts';
import {
  visualDecided,
  startReview,
  reviewFinished,
  boardDecided,
  fixFailed,
  touchedUp,
  archiving,
  withdrawn,
  threadTaskEnded,
  type Check,
} from './review.ts'; // (fixFailed; Check; archiving; withdrawn; threadTaskEnded)
import type { ChangedLines } from './findings.ts';
import { announceRequest } from './push.ts';
import * as tips from './tips.ts';
import { saveSecrets, stored, secret, addressKeys } from './secrets.ts';
import * as addresses from './addresses.ts';
import * as approvals from './approvals.ts';
import * as photos from './photos.ts';
import * as documents from './documents.ts';
import * as zips from './zips.ts';
import * as pictures from './pictures.ts'; // the board's pictures with a card's answer
import { ended as chatEnded, hear, parked } from './chat.ts';
import { isIntercom, isQuickRun, QUICK_EFFORT, quickRunStarted, quickRunTurn } from './quickruns.ts';
import { jobEnded } from './messages.ts';
import { oneLine } from './agreements.ts';
import { finished, cancelled, mine } from './ledger.ts';
import { recordUsage } from './usage.ts';
import { carryOver } from './carryover.ts';
import { recordSeatReading } from './headroom.ts';
import { seatReported } from './startholds.ts';
import { checkSeatWarning } from './seatwarning.ts';
import * as models from './models.ts';
import * as engineOnly from './engineonly.ts';
import { runEnded, runStarted, runsLost } from './agenttime.ts';
import { sweepTeam } from './team.ts';
import * as owed from './owed.ts';
import * as later from './later.ts';
import { shownCard } from './shown.ts';
import * as decisions from './decisions.ts';
import * as visualapproval from './visualapproval.ts';
import * as voiceprints from './voiceprints.ts'; // a saved voice's yearly card, its own answer
import * as wakes from './wakes.ts';
import * as meetingseats from './meetingseats.ts';
import * as meetingroom from './meetingroom.ts';
import * as threadorder from './threadorder.ts';
import * as threadends from './threadends.ts';
import { cardProblem } from '../../hq/shell/cardcheck.js';
import * as asking from '../../hq/shell/questions.js'; // a card's questions as form fields, the guest checklist's engine
import * as cardFiles from './cardfiles.ts'; // a card's files to download
import { holdLoose } from './sorting.ts';

type Job = {
  id: number;
  agent: string;
  title: string;
  prompt: string;
  engine: string;
  status: string;
  seat: string | null;
  branch: string | null;
  session: string | null;
  attempts: number;
  request: number | null;
  note: string | null;
  result: string | null;
  customers: number;
  kind: string;
  pr: number | null;
  round: number | null;
  sha: string | null;
  queued_by: string | null;
  downtime: number;
  model: string | null;
  effort: string | null;
  stage: string | null;
  step: string | null;
  for_seat: string | null;
  cli: string | null;
  engine_only: string | null;
  thread: string | null;
  is_check: number;
  suspending: string | null;
  stopping: string | null;
  light: number; // queued on a lighter model (hq job --model)
  up: string | null; // JSON: its hand-up from it to its agent's own model (handUp)
};

const now = () => Date.now();
// A run whose heartbeat hasn't come for this long is lost (requeueAbandoned)
export const STALE_MS = 10 * 60_000;
const GIVE_UP = 5;
// A run the worker's own plumbing snagged (finish) goes again after a wait that doubles from SNAG_WAIT_MS, until it has
// had SNAG_RUNS in a row: about 35 minutes of waits, long enough for GitHub or the network to come back.
const SNAG_WAIT_MS = 5 * 60_000,
  SNAG_RUNS = 4;

// An agent's card shows one state, and an agent can have more than one job running (the intercom and a job, a job and
// a pull request's fixes): it's idle (or paused, or waiting for the board) only once none of its jobs is running; until
// then its card shows the newest one at work, and its panel each of them. A restart forgets every state (events.ts
// status), so an agent with a job running is at work on it from the start.
// (step, round: its name, nameOf.)
// (the project and thread each serves, for the panel.)
const runningJobs = (agent: string, except = 0): RunningJob[] =>
  (
    db
      .prepare(
        `select j.id, j.title, j.step, j.round, j.started, t.name thread, p.name project
  from jobs j left join threads t on t.id = j.thread left join projects p on p.id = t.project
  where j.agent = ? and j.status = 'running' and j.id != ? order by j.started desc, j.id desc`,
      )
      .all(agent, except) as (Named & { id: number; started: string | null; thread: string | null; project: string })[]
  ).map(j => ({
    id: j.id,
    task: nameOf(j),
    since: j.started ?? undefined,
    ...(j.thread && { project: j.project, thread: j.thread }),
  }));
function settle(job: Pick<Job, 'id' | 'agent'>, state: string, text?: string) {
  const jobs = runningJobs(job.agent, job.id);
  publish({
    type: 'status',
    agent: job.agent,
    // (job: the one it's of)
    ...(jobs.length
      ? { state: 'working', job: jobs[0].id, text: jobs[0].task, since: jobs[0].since, jobs }
      : { state, text }),
  });
}
// A job claimed: its agent at work on it, its clock from the job's own start, not this run's, so it goes on across runs
function atWork(job: Job) {
  const jobs = runningJobs(job.agent);
  publish({
    type: 'status',
    agent: job.agent,
    state: 'working',
    job: job.id,
    text: nameOf(job),
    since: jobs.find(j => j.id === job.id)?.since,
    jobs,
  });
}
for (const { agent } of db.prepare("select distinct agent from jobs where status = 'running'").all() as {
  agent: string;
}[]) {
  const jobs = runningJobs(agent).map(redactJob);
  if (!status.has(agent)) status.set(agent, { state: 'working', task: jobs[0].task, since: jobs[0].since, jobs });
}

// The engine and CLI an agent's work runs on: the board's main model, else org.yaml's engine (models.ts asPicked).
function agentEngine(agent: string) {
  for (const d of org().departments ?? [])
    for (const a of d.agents ?? []) if (a.id === agent) return models.asPicked(a);
}

// The board and its members are people, and the company's mascots (brand.yaml) pets, not agents: no job runs, and
// nothing is said, in their name.
export const boardId = (id: string) =>
  id === 'board' ||
  [...(yamlFile('company/org.yaml').board?.members ?? []), ...(brand().mascots ?? [])].some(
    (m: { id: string }) => m.id === id,
  );

// Work for an agent whose engine no seat runs (org.yaml's `engine: api`, a chat that runs on its own key) would wait
// forever, so it's refused where every job is made, in words the caller can act on (hq job prints them; a call's agent
// hears them and picks someone else). A job that names its engine (a hire's, a test's) and HQ's own non-work jobs are
// left alone.
export class NoSeat extends Error {}
export function noSeat(agent: string) {
  const a = findAgent(agent);
  if (!a || models.SEAT_ENGINES.includes(String(a.engine))) return null;
  const name = a.name ?? agent,
    dept = (org().departments ?? []).find((d: { id: string }) => d.id === a.department);
  const others = ((dept?.agents ?? []) as { id: string; name?: string; temp?: boolean; engine?: string }[])
    .filter(o => !o.temp && models.SEAT_ENGINES.includes(String(models.asPicked(o).engine)))
    .map(o => o.id);
  return (
    `no job runs as ${agent}: ${name} runs on ${a.engine}, which no seat runs, so it would never start. Give the work to a ` +
    `colleague who takes jobs${others.length ? ` (${dept.name ?? dept.id}: ${others.join(', ')})` : `, e.g. an engineer who works on ${name}`}`
  );
}

// What a job is made of (createJob). (stage: review.ts Stage; forSeat: a retry keeps its seat, codexShare; cli: the CLI it must run on; thread, from: threadFrom; check: hq job --check; insteadOf: replacedWork; step: review.ts named)
// code: its task's code as its queuer claimed it (jobcodes.ts claim), or the task it follows on from; word: the word of a
// standing task of HQ's, which each run of it carries, in its thread's project. A step of a task (a retry, a review
// loop's run) carries the task's (codeFrom). With none of them, the agent doing it names it (jobcodes.ts name).
type NewJob = {
  size?: sizes.QueuedSize;
  schedule?: { entry: string; routine: string | null; slot: string };
  code?: string;
  word?: string;
  agent: string;
  title: string;
  prompt: string;
  engine?: string;
  kind?: 'work' | 'review' | 'consolidate' | 'chat' | 'meeting' | 'try'; // try: ink/booktry.ts
  pr?: number;
  round?: number;
  branch?: string;
  after?: number;
  sha?: string;
  queuedBy?: string;
  plannedBy?: string;
  customers?: boolean;
  call?: number;
  item?: number;
  downtime?: boolean;
  model?: string;
  effort?: string;
  stage?: string;
  step?: string;
  writes?: string[];
  forSeat?: string | null;
  cli?: string;
  thread?: string | null;
  from?: number;
  check?: boolean;
  insteadOf?: number | number[];
  only?: string; // the work only one engine does it's declared to do (engineonly.ts).
  judges?: string[]; // the files a review judges (review.ts toPanel).
  expedite?: boolean; // the CEO's structural HQ fix: first in line, merged on its checks
  carry?: string; // a commit main took outside a pull request HQ merged, which the job only checks (carries.ts)
  light?: boolean; // its model is a lighter one its queuer chose (hq job --model)
};

//
export function createJob(j: NewJob) {
  if (boardId(j.agent)) throw new Error(`No job runs as the board (${j.agent})`);
  const unrun = !j.engine && (j.kind ?? 'work') === 'work' && noSeat(j.agent);
  if (unrun) throw new NoSeat(unrun);
  const predecessors = Array.isArray(j.insteadOf) ? j.insteadOf : j.insteadOf ? [j.insteadOf] : [];
  const primary = predecessors[0];
  // (an expedited job is in no thread: a thread's tasks share its branch, and it merges alone.)
  const thread = j.expedite ? null : j.thread !== undefined ? j.thread : threadFrom(j);
  const runsOn = engineFor(j, thread);
  const id = insertJob(j, thread, runsOn);
  if (j.size) sizes.recordQueued(id, (j.plannedBy ?? j.queuedBy)!, j.prompt, j.size);
  predictions.recordQueued(id, Date.now(), j.schedule);
  if (runsOn.forSeat && !j.forSeat) shareTo(runsOn.forSeat, id);
  // (a task in place of one that failed takes its place in their thread: threadorder.ts.)
  for (const prior of predecessors.slice(1))
    db.prepare('insert into job_replacements (job, replaces) values (?, ?)').run(id, prior);
  if (primary)
    db.prepare(
      'update jobs set seq = (select coalesce(seq, id) from jobs where id = $was and thread is $thread) where id = $id and thread is not null',
    ).run({ was: primary, id, thread: j.thread !== undefined ? j.thread : threadOf(id) });
  if ((j.kind ?? 'work') === 'work' && !j.pr) taskAdded(id, j);
  publish({
    type: 'log',
    agent: j.agent,
    text: `New ${j.downtime ? 'downtime ' : ''}job #${id}: ${nameOf(j)}`,
  });
  return { id, code: codeOf(id) };
}

// The engine, CLI and model a new job runs on (its own, else its agent's, else Claude's), and a Codex job's seat
// (codexShare). A job on work only one engine does runs on that engine and model, whoever it's for (onlyFor; only: the
// rule's id, which keeps it there.)
function engineFor(j: NewJob, thread: string | null) {
  const rule = onlyFor(j, thread);
  if (rule) return { engine: rule.engine, cli: undefined, forSeat: null, model: rule.model, only: rule.id };
  const runsOn = j.engine ? null : agentEngine(j.agent);
  const engine = j.engine ?? runsOn?.engine ?? 'claude',
    cli = j.cli ?? runsOn?.cli ?? undefined;
  const forSeat = j.forSeat ?? (engine === 'codex' ? codexShare(cli) : null);
  return { engine, cli, forSeat, model: j.model, only: null };
}

// The work only one engine does a new job falls under (engineonly.ts): a review's by the files it judges, any other's as
// it's declared (hq job --only) or the job it replaces had it, else by what its pull request's, branch's or thread's
// pushes change.
function onlyFor(j: NewJob, thread: string | null) {
  if (j.kind === 'review') return engineOnly.ruleFor(j.judges ?? []);
  const primary = Array.isArray(j.insteadOf) ? j.insteadOf[0] : j.insteadOf;
  const declared = j.only ?? (primary ? onlyOf(primary) : null);
  if (declared) return engineOnly.byId(declared);
  const threadBranch = db.prepare('select branch from threads where id = ?').get(thread) as
    { branch: string | null } | undefined;
  return engineOnly.onWork(j.pr, j.branch ?? threadBranch?.branch);
}
const onlyOf = (job: number) =>
  (db.prepare('select engine_only from jobs where id = ?').get(job) as { engine_only: string | null } | undefined)
    ?.engine_only;

// The job's row: a replacement (insteadOf) keeps the call and item of the work it replaces, unless it names its own.
function insertJob(
  j: NewJob,
  thread: string | null,
  { engine, cli, forSeat, model, only }: ReturnType<typeof engineFor>,
) {
  const primary = Array.isArray(j.insteadOf) ? j.insteadOf[0] : j.insteadOf;
  const replaced = primary ? replacedWork(primary) : undefined;
  // customers: a tool put a customer's own details in its prompt (handedCustomerData, below)
  const { lastInsertRowid } = db
    .prepare(
      'insert into jobs (created, agent, title, prompt, engine, kind, pr, round, branch, after, sha, queued_by, customers, call, item, downtime, model, effort, stage, step, writes, for_seat, cli, thread, is_check, instead_of, code, engine_only, judges, expedite, carry, light) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      new Date().toISOString(),
      j.agent,
      j.title,
      j.prompt,
      engine,
      j.kind ?? 'work',
      j.pr ?? null,
      j.round ?? null,
      j.branch ?? null,
      j.after ?? null,
      j.sha ?? null,
      j.queuedBy ?? null,
      j.customers ? 1 : 0,
      j.call ?? replaced?.call ?? null,
      j.item ?? replaced?.item ?? null,
      j.downtime ? 1 : 0,
      model ?? null,
      j.effort ?? null,
      j.stage ?? null,
      j.step ?? null,
      j.writes?.length ? JSON.stringify(j.writes) : null,
      forSeat,
      cli ?? null,
      thread,
      j.check ? 1 : 0,
      primary ?? null,
      j.code ?? codeFrom(j) ?? (j.word ? codeIn(thread, j.word) : null),
      only,
      j.judges ? JSON.stringify(j.judges) : null,
      j.expedite ? 1 : 0,
      j.carry ?? null,
      j.light && !only ? 1 : 0, // (not where work only one engine does sets its model)
    );
  return Number(lastInsertRowid);
}

// A work job in a thread is a task added to its project's plan (plan.ts), by whoever queued it, else by HQ.
function taskAdded(id: number, j: { title: string; queuedBy?: string; plannedBy?: string }) {
  const t = db
    .prepare('select t.id, t.project from jobs j join threads t on t.id = j.thread where j.id = ?')
    .get(id) as { id: string; project: string } | undefined;
  if (t)
    planChange({
      project: t.project,
      thread: t.id,
      what: `task #${id} added: ${j.title}`,
      by: j.plannedBy ?? j.queuedBy ?? 'hq',
    });
}

// ---- replacements
// A job in place of one that failed or was set aside (jobs.instead_of): a review's automatic retry (review.ts again) or a
// job taking over failed work (takeover.ts). It carries the failed job's call and its item, so the item's work goes on
// with it (its thread's deadline goes on by itself: threadFrom). A replacement that's cancelled hands the work back.
const replacedWork = (id: number) =>
  db.prepare('select call, item from jobs where id = ?').get(id) as
    { call: number | null; item: number | null } | undefined;
// (kept prepared: the follow-through read asks it for each ended job carrying the board's items).
export const replacementOf = (job: number) =>
  (
    prepared(
      `select max(j.id) id from jobs j indexed by jobs_state join job_replacement_links r on r.job = j.id
    where r.replaces = ? and j.status != 'cancelled'`,
    ).get(job) as { id: number | null }
  ).id;
// The SQL below is built as other modules load (ledger.ts imports this one in turn), so its builders are hoisted functions.
// Whether the job (an SQL expression) has a replacement queued, under way or ended other than cancelled. (A replacement's
// status here, in lineageFrom and in replacementOf from db.ts jobs_state, and the jobs it reaches in noteholds.ts carried.) The links come first (`cross join`): led by jobs, the view's job_replacements
// half read every job's entry per job asked about, 2 s a plan change's check.
export function hasReplacement(job: string) {
  return `exists (select 1 from job_replacement_links r cross join jobs next indexed by jobs_state on next.id = r.job
    where r.replaces = ${job} and next.status != 'cancelled')`;
}
// Whether the job (an SQL expression for a jobs row) failed and is set aside: another took its place (a replacement), its
// branch has an open pull request, or it pushed work of its own (jobs.sha, threadorder.ts pushed) and its branch's pull
// request merged, which brought that work to main. One that pushed nothing has no work in a merge, though its thread's
// branch merged. None holds its thread (threadorder.ts tasksOf, prerequisites' task order).
export function failedAside(j: string) {
  return `(${j}.status in ('failed', 'stopped') and (${hasReplacement(`${j}.id`)}
    or exists (select 1 from prs p where p.branch = ${workBranch(j)}
      and (p.status in ${OPEN_PRS} or (p.status = 'merged' and ${j}.sha is not null)))))`;
}
// The jobs standing for the jobs `roots` selects (an SQL select of ids, which may name the outer query's columns): those,
// and each replacement of one of them that isn't cancelled. With `carried`, `roots` selects a column of that name before
// each id, and each replacement keeps its root's (noteholds.ts carried: a note's id). Each step reads the job a link
// reaches after the link (`cross join`), as hasReplacement does.
export function lineageFrom(roots: string, carried?: string) {
  const kept = carried ? `${carried}, ` : '',
    keptDown = carried ? `line.${carried}, ` : '';
  return `with recursive line(${kept}id) as (${roots}
    union select ${keptDown}next.id from line join job_replacement_links r on r.replaces = line.id
      cross join jobs next indexed by jobs_state on next.id = r.job where next.status != 'cancelled') select ${kept}id from line`;
}
// The job (an SQL expression) and each job it replaced, back to the first.
export function lineageTo(job: string) {
  return `with recursive line(id) as (select id from jobs where id = ${job}
    union select r.replaces from line join job_replacement_links r on r.job = line.id) select id from line`;
}

// Open work: a job queued, running or waiting for the board, and a pull request in review, stuck or waiting for the
// board's call.
const OPEN_JOB_STATUSES = ['queued', 'running', 'blocked'];
export const OPEN_JOBS = `('${OPEN_JOB_STATUSES.join("', '")}')`;
export const isOpenJob = (job: { status: string }) => OPEN_JOB_STATUSES.includes(job.status);
export const OPEN_PRS = "('open', 'stuck', 'board')";
// A board call's item that won't be worked on any more (ledger.ts): a job carrying it queues nothing, and it carries no
// board's word (BOARD_CALL). Every other status is a live item. Here, not in ledger.ts, which imports this module.
export const ENDED_ITEMS = ['dropped', 'replaced'];

// A job's branches in SQL, for the jobs row `j` names. Its work branch is where its own work goes (its own branch, else
// job/<id>). Its loop branch is the branch whose review loop it's in (its own, else its pull request's).
export const workBranch = (j: string) => `coalesce(${j}.branch, 'job/' || ${j}.id)`;
export const workBranchOf = (job: { id: number; branch: string | null }) => job.branch ?? `job/${job.id}`;
export const loopBranch = (j: string) => `coalesce(${j}.branch, (select p.branch from prs p where p.number = ${j}.pr))`;
// The ids of the jobs whose loopBranch is `branch` (SQL), found through the branch and pr indexes rather than every job's
// row.
export const loopJobs = (branch: string) =>
  `(select id from jobs where branch = ${branch}
    union all select j.id from prs p join jobs j on j.pr = p.number where p.branch = ${branch} and j.branch is null)`;
// The job whose work a `job/<n>` branch holds, in SQL: null for any other branch
export const jobOfBranch = (branch: string) =>
  `case when ${branch} glob 'job/[0-9]*' then cast(substr(${branch}, 5) as integer) end`;
// The job that leads a branch's review loop, in SQL: that of a `job/<n>` branch, and job n for `profile/<n>`, its records
// pull request (the worker's profile and archive lines), whose steps follow n's work into its thread (fromLoop).
const leadOfBranch = (branch: string) =>
  `case when ${branch} glob 'profile/[0-9]*' then cast(substr(${branch}, 9) as integer) else ${jobOfBranch(branch)} end`;
// The ids of the jobs mergePending (db.ts) holds, by index and not by every job's row (seconds off a cold disk): the open
// ones by their state, the done ones through their branch's open pull request. The few open pull requests lead, so
// stale statistics can't make the planner start from every done job.
const MERGE_PENDING_IDS = `select id from jobs indexed by jobs_status where status in ${OPEN_JOBS}
  union select j.id from prs p indexed by prs_open cross join jobs j indexed by jobs_branch on j.branch = p.branch
    where p.status in ${OPEN_PRS} and j.status = 'done' and ${mergePending('j')}
  union select j.id from prs p indexed by prs_open cross join jobs j on j.id = ${jobOfBranch('p.branch')} and j.branch is null
    where p.status in ${OPEN_PRS} and p.branch = ${workBranch('j')} and j.status = 'done' and ${mergePending('j')}`;

// The author of a review loop, by the job's loop branch, otherwise the job itself.
export const WORK_LEAD = `coalesce(${jobOfBranch(loopBranch('j'))}, j.id)`;

// The thread a job serves (projects.ts), given or inherited: that of the job it comes from (`from`: the job that handed
// it on, asked the card it answers, or sent the message it became), else that of the work on its loop branch (the
// review loop's runs and fixes), the newest that has one. None to inherit is null.
export const threadOf = (job: number) =>
  (db.prepare('select thread from jobs where id = ?').get(job) as { thread: string | null } | undefined)?.thread ??
  null;
function threadFrom(j: { from?: number; branch?: string; pr?: number }) {
  if (j.from) return threadOf(j.from);
  return fromLoop('thread', j);
}

// A task's retries and review-loop steps carry its code.
export function codeFrom(j: { insteadOf?: number | number[]; branch?: string; pr?: number }) {
  const replaced = Array.isArray(j.insteadOf) ? j.insteadOf[0] : j.insteadOf;
  if (replaced) return codeOf(replaced);
  return fromLoop('code', j);
}

// The loop's jobs by their branch's index and the branch's own job by its id, then each row: left to the planner, on old
// statistics it read every job's row, brief and output, for the newest with one (seconds off the disk, a job queued
// waiting). No branch and no pull request: no loop to inherit from.
function fromLoop(column: 'thread' | 'code', j: { branch?: string; pr?: number }) {
  if (!j.branch && !j.pr) return null;
  // the new job as a row (`n`), so its loop branch reads as any job's does
  return (
    (
      db
        .prepare(
          `with n (branch, pr) as (values ($branch, $pr)), b (branch) as materialized (select ${loopBranch('n')} from n),
      w (id) as (select id from jobs indexed by jobs_branch, b where jobs.branch = b.branch
        union select ${leadOfBranch('b.branch')} from b)
    select j.${column} from w cross join jobs j on j.id = w.id where +j.${column} is not null order by j.id desc limit 1`,
        )
        .get({ branch: j.branch ?? null, pr: j.pr ?? null }) as Record<typeof column, string> | undefined
    )?.[column] ?? null
  );
}

// When a job started, its first run (claim's coalesce keeps it across the later ones): the clock of an agent at work on
// it counts from there.
export const startedOf = (job: number) =>
  (prepared('select started from jobs where id = ?').get(job) as { started: string | null } | undefined)?.started ??
  undefined;

// A customer's own details (charter rule 7) stay where they came in, and only there (the board, 2026-10-06: the topic,
// the job, its title and its outcome aren't secret, and the board sees everything). A job holds them when a tool puts
// them in its prompt (createJob customers) or it reads them (hq mail, hq orders, a Care case, a customer card's text or
// photos: handedCustomerData); a card holds them when the tool that writes it says so (createRequest customers). It
// doesn't pass to the work a job hands on, and it never hides a title.
export const holdsCustomerData = (job?: number | null) =>
  !!(
    job &&
    (db.prepare('select customers from jobs where id = ?').get(job) as { customers: number } | undefined)?.customers
  );
export const handedCustomerData = (job?: number | null) => {
  if (job) db.prepare('update jobs set customers = 1 where id = ?').run(job);
};
// A reader handed them: its job, or a live call's token (no job) its call, which is about a customer from then on
// (memory.ts customerCall), so what it changes with words is refused (server.ts).
export const readerHanded = (reader: Reader) => {
  if (reader.id) handedCustomerData(reader.id);
  else if (reader.callId) db.prepare('update calls set customers = 1 where id = ?').run(reader.callId);
};
// A job holds keys once it heard a call about a card for keys: the call itself, its summary or its follow-up's report
// (hq call, search, history), or its line on the intercom (chat.ts). The board may read a key out on such a call in a form
// the mask can't match, so the intercom keeps that session's replies to itself.
export const holdsKeys = (job: number) =>
  !!(db.prepare('select about_keys from jobs where id = ?').get(job) as { about_keys: number }).about_keys;
export const handedKeys = (job?: number | null) => {
  if (job) db.prepare('update jobs set about_keys = 1 where id = ?').run(job);
};
export const customerCard = (id: number) =>
  !!(db.prepare('select customers from requests where id = ?').get(id) as { customers: number } | undefined)?.customers;
// Who reads them: the job working on them, and org.yaml's roles.customerData. Any other job, the same agent's included,
// is refused or finds them left out, so a bad package in a job reads only what the job was handed (company/DECISIONS.md,
// 2026-10-08, jobs #7744 and #7844). A live call reads as a reader with no job (id 0).
export type Reader = { id: number; agent: string; callId?: number }; // (callId: a live call's token, with no job)
export const readsCustomerData = (agent: string) => reads(agent, 'customerData');
// A report that holds them: its own job's.
export const readsReport = (job: { id: number; customers: number | boolean }, reader: Reader) =>
  !job.customers || job.id === reader.id || readsCustomerData(reader.agent);
// A customer card: the job that filed it, and a job working on a call about it (the call's follow-up HQ handed the card,
// a job handed out for one of its items: ledger.ts mine).
export function readsCard(id: number, reader: Reader) {
  if (!customerCard(id) || readsCustomerData(reader.agent)) return true;
  if (!reader.id) return false;
  if (db.prepare('select 1 from requests where id = ? and job = ?').get(id, reader.id)) return true;
  return (db.prepare('select id from calls where request = ?').all(id) as { id: number }[]).some(c =>
    mine(reader.id, c.id),
  );
}
export const CARD_REFUSED =
  "a customer card goes only to the job working on it (the job that filed it, or one working on a call about it) and to org.yaml's roles.customerData: ask that job's agent for what you need from it";
export const REPORT_LEFT_OUT = "it holds a customer's own details, so its report stays with that job";

// What's in flight: open work (queued, running, or waiting for the board), so nobody queues the same work twice. hq jobs
// lists it, hq job shows the target's before it adds one, and a starting job's prompt carries it (inFlight).
// pr: the pull request an author's fix job updates, which its title no longer names.
// waits: the further jobs it still waits for (outstanding), by id.
// cards: the cards it still waits for (openCards), by id.
// wakes: the events it still waits for, in words (wakes.ts pending).
// line: the job in words (openLine), which hq prints as it is.
export type OpenJob = {
  id: number;
  code: string | null;
  agent: string;
  title: string;
  step?: string | null;
  round?: number | null;
  status: string;
  after: number | null;
  queued_by: string | null;
  downtime?: number;
  pr?: number | null;
  waits: number[];
  cards: number[];
  wakes: string[];
};
export function openJobs(o: { agent?: string; except?: number; awaitingMerge?: boolean }) {
  const runsHold = held();
  const rows = db
    .prepare(
      redraws.query(`select id, code, agent, title, step, round, kind, status, after, queued_by, downtime, pr, ${heldWith('jobs')} paused_with,
    (select json_group_array(id) from (${outstanding('jobs.id')})) waits,
    (select json_group_array(request) from (${openCards('jobs.id')})) cards
    from jobs where kind = 'work' and ${o.awaitingMerge ? mergePending('jobs') : `status in ${OPEN_JOBS}`} and id != ? and (?2 is null or agent = ?2) order by id`),
    )
    .all(o.except ?? 0, o.agent ?? null) as (Omit<OpenJob, 'waits' | 'cards' | 'wakes'> & {
    kind: string;
    paused_with: string | null;
    waits: string;
    cards: string;
  })[];
  const open = rows.map(({ kind, paused_with, ...row }) => ({
    ...row,
    waits: JSON.parse(row.waits) as number[],
    cards: JSON.parse(row.cards) as number[],
    wakes:
      row.status === 'queued'
        ? [...wakes.pending(row.id), ...heldWakes(row.agent, runsHold), ...pausedWakes({ kind, paused_with })]
        : [],
  }));
  return open.map(j => ({ ...j, line: openLine(j) }));
}
// (its number and code)
export function openLine(j: OpenJob) {
  const downtime = j.downtime ? ' (downtime)' : '';
  const pr = j.pr ? ` (PR #${j.pr})` : '';
  return `${numbered(j)} ${j.agent}, ${openStatus(j)}${downtime}: ${nameOf(j)}${pr}`;
}
// A job's name in agents' lines: its title, and for one the review loop made, its step and round around it (review.ts
// named).
export type Named = { title: string; step?: string | null; round?: number | null };
export function nameOf(j: Named) {
  return j.step ? `${j.step}: ${j.title}${j.round ? ` (round ${j.round})` : ''}` : j.title;
}
function openStatus(j: OpenJob) {
  if (j.status === 'blocked') return 'waiting for the board';
  if (j.status !== 'queued') return j.status;
  const holds: string[] = [];
  if (j.after) holds.push(`after #${j.after}`);
  if (j.waits.length) holds.push(untilMerged(j.waits));
  if (j.cards.length) holds.push(untilAnswered(j.cards));
  holds.push(...j.wakes);
  return ['queued', holds.join(', and ')].filter(Boolean).join(' ');
}
// What still keeps a queued or parked job from starting even expedited, in openStatus's words: READY's own terms (its
// after, its further waits with a redraw's, its cards, its wakes and its time), never a pause or a run's hold, which
// expedite passes. Null once it starts on the next free seat (hq expedite: review.ts expedite).
export function stillHolds(id: number) {
  const j = prepared(
    redraws.query(
      `select j.status, j.after, j.request, j.not_before, ${READY} ready, ${AFTER_MET} after_met,
    (select json_group_array(id) from (${outstanding('j.id')})) waits,
    (select json_group_array(request) from (${openCards('j.id')})) cards
    from jobs j where j.id = $id`,
      '$id',
    ),
  ).get({ id, now: now() }) as {
    status: string;
    after: number | null;
    request: number | null;
    not_before: number;
    ready: number;
    after_met: number;
    waits: string;
    cards: string;
  };
  if (j.ready) return null;
  if (j.status === 'blocked') return `until the board answers card #${j.request}, which it's parked on`;
  const work = [...(j.after_met ? [] : [j.after!]), ...(JSON.parse(j.waits) as number[])],
    cards = JSON.parse(j.cards) as number[];
  const named = (
    db
      .prepare(
        'select id, code, agent, title, step, round from jobs where id in (select value from json_each(?)) order by id',
      )
      .all(JSON.stringify(work)) as ({ id: number; code: string | null; agent: string } & Named)[]
  ).map(w => `${numbered(w)} (${w.agent}: ${nameOf(w)})`);
  const holds = [
    ...(named.length ? [`until ${named.join(' and ')} ${named.length > 1 ? 'are' : 'is'} done and merged`] : []),
    ...(cards.length ? [untilAnswered(cards)] : []),
    ...wakes.pending(id),
    ...(j.not_before > now() ? [`not before ${wakes.clock(j.not_before)}`] : []),
  ];
  return holds.join(', and ') || null;
}
function untilMerged(waits: number[]) {
  const ids = waits.map(id => `#${id}`);
  const verb = ids.length > 1 ? 'are' : 'is';
  return `until ${ids.join(' and ')} ${verb} done and merged`;
}
function untilAnswered(cards: number[]) {
  const ids = cards.map(id => `#${id}`);
  const noun = ids.length > 1 ? 'cards' : 'card';
  const verb = ids.length > 1 ? 'are' : 'is';
  return `until ${noun} ${ids.join(' and ')} ${verb} answered`;
}

// A starting job's prompt lists them all while that stays short. Past that: its own agent's jobs and those of the agents
// it's likely to hand work to (its department, whoever it queued work for in the last two weeks, whoever queued this
// job), plus the jobs it queued itself, and how many others `hq jobs` would show.
const SHORT = 30;
export function inFlight(job: { id: number; agent: string; queued_by?: string | null }) {
  const all = openJobs({ except: job.id });
  let shown = all;
  if (all.length > SHORT) {
    const dept = findAgent(job.agent)?.department;
    const near = new Set<string>([
      job.agent,
      ...(job.queued_by ? [job.queued_by] : []),
      ...(org().departments ?? [])
        .filter((d: any) => d.id === dept)
        .flatMap((d: any) => (d.agents ?? []).map((a: any) => a.id)),
      ...(
        db
          .prepare('select distinct agent from jobs indexed by jobs_queued_for where queued_by = ? and created > ?')
          .all(job.agent, new Date(now() - 14 * 86400e3).toISOString()) as { agent: string }[]
      ).map(r => r.agent),
    ]);
    shown = all.filter(j => near.has(j.agent) || j.queued_by === job.agent);
  }
  const more = all.length - shown.length;
  return `Other open jobs as this run starts (queued, running or waiting for the board)${
    more
      ? `: yours and those of the
agents you work with most (${more} more of others: \`hq jobs\` lists them all)`
      : ''
  }:
${shown.map(j => `- ${j.line}`).join('\n') || '- none'}
Before you queue or split work, check what's open (this list, and \`hq jobs <agent>\` for the latest): if a job already
covers it, extend it (\`hq extend\`, before it starts) or wait on it (\`--after\`, with only what's left) rather than
adding a parallel one.`;
}

// hq extend: more for a job that hasn't started yet, instead of a second job beside it. Only work that has never
// run (a started job's session has read its prompt already: wait on it with --after instead), and only work an agent
// queued: the coordinator's own jobs (the board's answers, its directives) take nothing added. The signature goes after
// the text, like hq job's "(Assigned by ...)", so a sign-off inside the text is never the last word.
export function extendJob(id: number, by: string, text: string) {
  text = text.trim();
  if (!text) return 400;
  const r = db
    .prepare(
      `update jobs set prompt = prompt || ? where id = ? and kind = 'work' and status = 'queued' and session is null
    and queued_by is not null`,
    )
    .run(`\n\n${text}\n(Added by ${by}.)`, id);
  if (!r.changes) return 404;
  publish({ type: 'log', agent: by, text: `Added to job #${id}` });
  return { ok: true };
}

// Downtime work (maintenance: refactoring passes, hardening, log scans, the janitor) with no window above it runs on
// spare capacity only (planner.ts spareOnly), so it never slows the team: a seat takes it only when nothing else on its
// engine can start and less than DOWNTIME_UNDER of its window is used (the fuller of the 5-hour and the weekly one; a
// window not measured yet counts as full). It yields at its next step (paused and resumed later, like a limit) when other
// work waits for its room (makesRoom), or its seat passes DOWNTIME_YIELD. The room it freed is its waiter's (room_for)
// before any spare work's, on every engine (claim freedFor), so the next downtime job can't take it back first.
// Downtime work that windowed work waits for has a latest start, and runs like any other.
export const DOWNTIME_UNDER = 0.6,
  DOWNTIME_YIELD = 0.8;

// The claim and the play share [board word, latest start, id], with reviewroom.ts sharing multi-run seats.
type Claimable = { id: number; kind: string; downtime: number; board: number | boolean; expedite?: number };
// The jobs carrying a call's item: the one handed it (`job`, a test on call_items.job), every job carrying it on (`item`,
// a test on jobs.item: hq job passes it down) and each job in place of one of those (replacements: a review's retry, a
// takeover). One definition for the follow-through check, an item at a time (agreements.ts), and the board's word, every
// open item at once (ITEM_WORK).
// (a declaration: agreements.ts reads it as it loads, in the middle of this module's import cycle, as it does lineageFrom)
export function itemCarriers(job: string, item: string) {
  return lineageFrom(`select j.id from jobs j indexed by jobs_state where j.kind = 'work' and j.id ${job}
  union select j.id from jobs j indexed by jobs_carried where j.kind = 'work' and j.item ${item}`);
}
// An item is handled (or ready, a task or promise) once its job ends done with a pull request open (ledger.ts
// finished()), so the jobs on that pull request's branch carry it on until it merges or closes: its reviews, rulings,
// fixes and up-to-date merges. That's a branch with an open pull request (OPEN_PRS) whose work (the job it's named for,
// or a fix on it) carries a live item, or was handed one (ledger.ts tied). Read from the open pull requests, a few jobs
// each, through db.ts prs_open, jobs_work_branch and jobs_branch.
const LIVE_ITEMS = `select i.id, i.job from call_items i where i.status not in ('${ENDED_ITEMS.join("', '")}')`;
// Work carrying an open item from a board call, and the work on its open pull request: one list, read once a statement
// from the open items, the jobs' item index and the open pull requests (never the jobs' wide rows).
const ITEM_WORK = `${itemCarriers("in (select i.job from call_items i where i.status = 'open')", "in (select i.id from call_items i where i.status = 'open')")}
  union select b.id from prs p indexed by prs_open join jobs b indexed by jobs_branch on b.branch = p.branch where p.status in ${OPEN_PRS}
    and exists (select 1 from jobs w indexed by jobs_work_branch where coalesce(w.branch, 'job/' || w.id) = +p.branch
      and w.kind = 'work' and (w.item in (select id from (${LIVE_ITEMS}))
        or exists (select 1 from (${lineageTo('w.id')}) l where l.id in (select job from (${LIVE_ITEMS})))))`;
export const itemWorkCarriers = () =>
  new Map(
    (
      prepared(`select j.id, ${workBranch('j')} branch from (${ITEM_WORK}) carrier
    join jobs j on j.id = carrier.id`).all() as { id: number; branch: string }[]
    ).map(row => [row.id, row.branch]),
  );
export const itemWorkBranches = () => new Set(itemWorkCarriers().values());
// The board's word: the job a board's call left to follow it up (ledger.ts: calls.job), a check routing the notes it
// sent (routing.ts), a sheet the board sent from its book to its page's owner (booknotes.ts), work carrying a call's
// item (ITEM_WORK), and a meeting's seat when queued work carrying one waits for any of that meeting's seats (--after or
// hq waits: seats take no items). A carrier waits only while queued, so a cancelled or ended one leaves the seats (read
// from jobs_queue, which covers its after).
export const BOARD_CALL = (job: string) =>
  `(exists (select 1 from calls c where c.job = ${job}.id) or exists (select 1 from note_routes r where r.job = ${job}.id)
    or exists (select 1 from book_sheets b where b.job = ${job}.id) or ${job}.id in (${ITEM_WORK}) or ${job}.kind = 'meeting' and exists (select 1 from meeting_seats s
      join meeting_seats o on o.meeting = s.meeting
      join jobs w indexed by jobs_queue on w.status = 'queued' and w.id in (${ITEM_WORK}) where s.job = ${job}.id
      and (w.after = o.job or exists (select 1 from waits x where x.job = w.id and x.on_job = o.job))))`;
// The CEO's hourly follow-through check (followthrough.ts), which runs to its end once started (planner.ts pausable;
export const FOLLOW_THROUGH = (job: string) => `exists (select 1 from followthrough_checks f where f.job = ${job}.id)`;
// The order's first lane (planner.ts compare: the queue's `board`): the board's word, and the CEO's hourly check that
// follows it through. Behind it, the check waited out the board's own work it's there to see, past its start alarm
// (followthrough.ts START_MS; #19927, 27 October).
export const LANE = (job: string) => `(${BOARD_CALL(job)} or ${FOLLOW_THROUGH(job)})`;
// The ids a job still waits for, in id order. Ids only: a jobs row around each would read its brief and report, and on
// stale planner statistics every job's row.
export const outstandingWaits = (job: number) =>
  prepared(redraws.query(outstanding('$job'), '$job')).all({ job }) as { id: number }[];
// A planner snapshot reads the wait edges once against the same resolved redraw relation.
export function outstandingWaitsByJob(jobIds: number[]) {
  const rows = prepared(
    redraws.query(`select pending.job, prior.id, prior.status from outstanding_waits pending
      join jobs prior on prior.id = pending.id where pending.job in (select value from json_each($jobs))
      order by pending.job, prior.id`),
  ).all({ jobs: JSON.stringify(jobIds) }) as (Pick<Job, 'id' | 'status'> & { job: number })[];
  return Map.groupBy(rows, row => row.job);
}
// hq waits: a queued job's further waits (db.ts waits) are added, moved to the work that replaces the job they wait for,
// or dropped. Only the waiting job's agent, whoever queued it, the CEO and the process role can change its waits (the
// morning round cuts waits a job doesn't need). A wait on a job is refused when
// that job needs the waiting job first (through `after`, waits, pauses, task order, thread needs or a redraw, at any depth).
// Neither would ever start. Deployment wakes and expanded review edges are checked atomically by writePlan.
// The shared checks each return why a change is refused, or nothing when it may go ahead.
// (add, and the shared checks)
function whyNotYours(job: number, by: string, waitsFor: number | null) {
  const anyQueuedJob = by === ceo() || inProcess(by);
  const yours = db
    .prepare(
      `select 1 from jobs j where j.id = $job and j.kind = 'work' and j.status = 'queued'
    and (j.agent = $by or j.queued_by = $by or $anyQueuedJob)
    and ($on is null or exists (select 1 from waits w where w.job = j.id and w.on_job = $on))`,
    )
    .get({ job, by, on: waitsFor, anyQueuedJob: Number(anyQueuedJob) });
  if (!yours)
    return `job #${job} isn't a queued job of yours, or one you queued${waitsFor == null ? '' : `, that waits for #${waitsFor}`}`;
}
// The job waited for must still be able to meet the wait: open work, or done work whose latest pull request merged or is
// still pending. Work that ended any other way already did, so nothing would ever release the job or say it's held.
function whyCantMeet(job: number, on: number, role: string) {
  const target = db
    .prepare(
      redraws.query(`select 1 from jobs j where id = ? and kind = 'work'
    and (${mergePending('j')} or ${merged('j')})`),
    )
    .get(on);
  if (!target) return `job #${on} isn't work that ${role}: it ended without work that merged or still can`;
  if (prerequisites([on], { ordered: true }).some(n => n.id === job))
    return `job #${on} already needs #${job} first (through waits, a pause, task order, deliverable needs or a redraw), so neither would ever start: change the dependency with hq waits, hq plan move or hq plan unneed, or resume the pause`;
}
// The unfinished work `from` needs first, at any depth, with `from` itself while unfinished: its after, waits and --until
// jobs of an open pause on its thread (pauses.ts). ordered adds task order, thread needs and redraw barriers.
// includeFrom: false starts at the edges, so a root in its own prerequisites identifies a cycle.
export function prerequisites(from: number[], { includeFrom = true, ordered = false } = {}) {
  return db
    .prepare(
      `${dependencyEdges()}, needs(id) as (
      select 'job/' || value from json_each($from) where $includeFrom
      union select e.needs from edges e join json_each($from) f on e.job = 'job/' || f.value where not $includeFrom
      union select e.needs from needs n join edges e on e.job = n.id)
    select j.id, j.thread, j.kind, j.expedite from needs n join jobs j on j.id = ${jobOfBranch('n.id')}
    where j.id in (select id from pending) order by j.id`,
    )
    .all({
      from: JSON.stringify(from),
      includeFrom: Number(includeFrom),
      ordered: Number(ordered),
    }) as { id: number; thread: string | null; kind: string; expedite: number }[];
}
// The edges prerequisites walks, all at once: each node's needs ('job/<id>' or 'thread/<id>'), ordered as above.
export function needsGraph() {
  const graph = new Map<string, string[]>();
  const edges = db.prepare(`${dependencyEdges()} select job, needs from edges`);
  const rows = edges.all({ ordered: 1 }) as { job: string; needs: string }[];
  for (const { job, needs } of rows) graph.set(job, [...(graph.get(job) ?? []), needs]);
  return graph;
}
// The unfinished jobs are read once, by index (MERGE_PENDING_IDS), and every edge starts from them or from the open and
// failed tasks. Tasks keep only the columns the edges read, never a row's brief and output.
// A failed task only holds the open ones after it in its thread, so only the threads with unfinished work read their
// failed tasks.
function dependencyEdges() {
  return `with recursive ${redraws.relations()},
    pending(id) as materialized (${MERGE_PENDING_IDS}),
    open_threads(thread) as materialized (select distinct j.thread from pending x cross join jobs j indexed by jobs_listed
      on j.id = x.id where j.thread is not null),
    tasks as materialized (select j.id, j.thread, j.seq, j.status, j.branch from (select id from pending
        union select f.id from open_threads t cross join jobs f indexed by jobs_thread_state
          on f.thread = t.thread and f.status = 'failed') x
      cross join jobs j indexed by jobs_listed on j.id = x.id where j.kind = 'work' and j.pr is null
      and j.thread is not null and not ${failedAside('j')}),
    edges(job, needs) as (
      select 'job/' || j.id, 'job/' || j.after from pending x cross join jobs j on j.id = x.id where j.after is not null
      union select 'job/' || w.job, 'job/' || w.on_job from pending x cross join waits w on w.job = x.id
      union select 'job/' || j.id, 'job/' || u.job from jobs j join pauses p on ${pauseHolds('p')} and ${pauseCovers('p', 'j.thread')}
        join pause_until u on u.pause = p.id where j.id in (select id from pending) and (j.thread is not null or not ${deskLets('j')})
      union select 'job/' || j.id, 'job/' || prior.id from tasks j join tasks prior on prior.thread = j.thread
        and (coalesce(prior.seq, prior.id), prior.id) < (coalesce(j.seq, j.id), j.id)
        where $ordered and j.status in ('queued', 'running', 'blocked') and prior.status in ('queued', 'running', 'blocked', 'failed')
      union select 'job/' || j.id, 'thread/' || n.needs from tasks j join thread_needs n on n.thread = j.thread
        join threads t on t.id = n.needs where $ordered and j.status != 'failed' and t.status = 'open'
      union select 'thread/' || t.id, 'job/' || j.id from threads t join tasks j on j.thread = t.id
        where $ordered and t.status = 'open' and j.status != 'failed'
      union select 'thread/' || n.thread, 'thread/' || n.needs from thread_needs n join threads t on t.id = n.needs
        where $ordered and t.status = 'open'
      union ${redraws.dependencies()}
    )`;
}
// An agent adds waits to work they queued. The CEO or Process may also hold HQ-made work, with a reason on the feed.
export function addWait(job: number, on: number, by: string, why = '') {
  why = oneLine(why);
  const refused =
    whyNotYours(job, by, null) ?? whyMadeByHq(job, by, why) ?? whyCantMeet(job, on, `#${job} can wait for`);
  if (refused) return refused;
  // Repeatable: it only writes rows and publishes after its step, so writePlan may run it twice.
  return redraws.writePlan(
    () => {
      holdForMerge(job, on, by, why);
      return { ok: true };
    },
    { repeatable: true },
  );
}
// Trusted plan operations also use these waits after their caller has authorized the plan change.
export function holdForMerge(job: number, on: number, by: string, why = '') {
  if (db.prepare('insert or ignore into waits (job, on_job) values (?, ?)').run(job, on).changes)
    recordWaitChange(job, by, `#${job} waits for #${on} too now${why ? `: ${why}` : ''}`);
}
export function redirectWaits(from: number[], on: number, by: string) {
  const ids = JSON.stringify(from);
  const affected = db
    .prepare(
      `select id, after from jobs where status = 'queued' and
    (after in (select value from json_each($ids)) or exists (select 1 from waits where job = jobs.id
      and on_job in (select value from json_each($ids))))`,
    )
    .all({ ids }) as { id: number; after: number | null }[];
  for (const job of affected) {
    if (job.after !== null && from.includes(job.after))
      db.prepare('update jobs set after = ? where id = ?').run(on, job.id);
    db.prepare(
      `update or replace waits set on_job = ? where job = ? and on_job in (select value from json_each(?))`,
    ).run(on, job.id, ids);
    recordWaitChange(job.id, by, `#${job.id} now waits for #${on} in place of the closed work`);
  }
}
function recordWaitChange(job: number, by: string, text: string) {
  const thread = threadOf(job);
  if (thread) planChange({ project: thread.split('/')[0], thread, what: text, by });
  publishWaitChange(job, by, text);
}
function whyMadeByHq(job: number, by?: string, why = '') {
  const made = db.prepare('select 1 from jobs where id = ? and queued_by is null').get(job);
  if (made && by && (by === ceo() || inProcess(by)) && why) return;
  if (made)
    return (
      `job #${job} was made by HQ (a pull request's fix, the board's answer or a schedule's job), and HQ's jobs ` +
      `take another wait only from the CEO or Process with --why "reason": otherwise queue your own step --after the work it waits for`
    );
}
export function moveWait(job: number, from: number, to: number, by: string, why = '') {
  const refused = whyNotYours(job, by, from) ?? whyCantMeet(job, to, `can replace #${from}'s`);
  if (refused) return refused;
  // Repeatable, as addWait's.
  return redraws.writePlan(
    () => {
      db.prepare('update or replace waits set on_job = ? where job = ? and on_job = ?').run(to, job, from);
      publishWaitChange(job, by, `#${job} waits for #${to} now, in place of #${from}${why ? `: ${oneLine(why)}` : ''}`);
      return { ok: true };
    },
    { repeatable: true },
  );
}
export function dropWait(job: number, from: number, by: string, why = '') {
  const refused = whyNotYours(job, by, from);
  if (refused) return refused;
  db.prepare('delete from waits where job = ? and on_job = ?').run(job, from);
  publishWaitChange(job, by, `#${job} no longer waits for #${from}${why ? `: ${oneLine(why)}` : ''}`);
  return { ok: true };
}

// A card a job waits for (hq job --after request:<id>, hq waits <job> add request:<id>): only the step that needs the
// board's answer waits for it, and the work before that goes on to review. The card's answer goes into the job's prompt
// (tellWaiting), so the job must not have started. Nothing moves a card wait: a card taken off the desk phone releases
// its jobs, and each reads why and can ask again.
export function addCardWait(job: number, request: number, by: string, why = '') {
  why = oneLine(why);
  const refused =
    whyNotYours(job, by, null) ?? whyMadeByHq(job, by, why) ?? whyStarted(job) ?? whyNotAgentCard(request, by);
  if (refused) return refused;
  holdForCard(job, request);
  publishWaitChange(job, by, `#${job} waits for card #${request} too now${why ? `: ${why}` : ''}`);
  return { ok: true };
}
export function dropCardWait(job: number, request: number, by: string, why = '') {
  const refused = whyNotYours(job, by, null);
  if (refused) return refused;
  const dropped = db.prepare('delete from request_waits where job = ? and request = ?').run(job, request);
  if (!dropped.changes) return `job #${job} doesn't wait for card #${request}`;
  publishWaitChange(job, by, `#${job} no longer waits for card #${request}${why ? `: ${oneLine(why)}` : ''}`);
  return { ok: true };
}
// A change by the CEO or the process role on someone else's job also reaches its agent and queuer,
// naming who made it.
function publishWaitChange(job: number, by: string, text: string) {
  const { agent, queued_by } = db.prepare('select agent, queued_by from jobs where id = ?').get(job) as {
    agent: string;
    queued_by: string | null;
  };
  if (agent === by || queued_by === by) return publish({ type: 'log', agent: by, text });
  for (const who of new Set([by, agent, queued_by ?? agent]))
    publish({ type: 'log', agent: who, text: `${text} (changed by ${by})` });
}
function whyStarted(job: number) {
  const started = db.prepare('select 1 from jobs where id = ? and session is not null').get(job);
  if (started)
    return (
      `job #${job} has started already, so it would never read the card's answer: queue the step that ` +
      'needs it as a new job, --after the card'
    );
}
// Only an open card the caller filed. A customer card's answer stays with the job working on it.
export function whyNotAgentCard(request: number, by: string) {
  const open = db.prepare("select 1 from requests where id = ? and status = 'open'").get(request);
  if (!open || !agentCard(request) || customerCard(request) || !askedBy(request, by))
    return `card #${request} isn't an open card you filed`;
}
export function holdForCard(job: number, request: number) {
  db.prepare('insert or ignore into request_waits (job, request) values (?, ?)').run(job, request);
}
// A job queued after a card may read the photos supplied with its answer (server.ts seePhotos).
export const queuedAfterCard = (job: number, request: number) =>
  !!db.prepare('select 1 from request_waits where job = ? and request = ?').get(job, request);
// A card whose answer takes the board's pictures (pictures.ts upload, answerRequest; desk.js keeps the phone's tray in
// step): not one for keys, nor an email card, whose answer is its Send or Discard
export const takesPictures = (r: { secrets: string | null; kind: string }) =>
  !r.secrets && r.kind !== 'credential' && r.kind !== 'mail';
// Who may read what came with a card's answer (hq photos, the board's pictures: server.ts seePhotos, pictures.ts): the
// agent who asked and a job queued after the card; a customer card's go to whoever reads its text (readsCard), refused
// with why for anyone else. true, 404 or the refusal; the caller marks a customer card's reader (handedCustomerData).
export function cardAccess(id: number, reader: Reader): true | 404 | [403, string] {
  if (customerCard(id)) return readsCard(id, reader) ? true : [403, CARD_REFUSED];
  return askedBy(id, reader.agent) || queuedAfterCard(reader.id, id) ? true : 404;
}
// A job ended without merged work (cancelled, failed, done with no pull request),
// so the waits on it are never met and the jobs that wait stay held. Whoever queued each waiting job owns the recovery:
// one job each moves or drops the waits. A job that HQ made, or whose queuer is no longer here, goes to its own agent.
// A pull request closed unmerged hands on its work's waits here too (review.ts close). Returns the recovery jobs,
// for the line that says the job ended.
// (step, round: a job's name, nameOf.)
export function strandedWaits(prior: Named & { id: number; agent: string }, how: string) {
  const held = db
    .prepare(
      `select j.id, j.agent, j.title, j.step, j.round, j.queued_by from waits w join jobs j
    on j.id = w.job where w.on_job = ? and j.kind = 'work' and j.status = 'queued' order by j.id`,
    )
    .all(prior.id) as (Named & { id: number; agent: string; queued_by: string | null })[];
  const owners = new Map<string, typeof held>();
  for (const j of held) {
    const owner = j.queued_by && findAgent(j.queued_by) ? j.queued_by : j.agent;
    owners.set(owner, [...(owners.get(owner) ?? []), j]);
  }
  return [...owners].map(([owner, waiting]) => {
    const each = waiting.map(
      j =>
        `- #${j.id} (${j.agent}: ${nameOf(j)}): \`hq waits ${j.id} move ${prior.id} <job>\` or \`hq waits ${j.id} drop ${prior.id}\``,
    );
    const { id } = createJob({
      agent: owner,
      title: `Job #${prior.id} ended without merged work: move or drop the waits on it`,
      prompt:
        `Job #${prior.id} (${prior.agent}: ${nameOf(prior)}) ${how}, so it will never merge work. Queued jobs you're ` +
        `responsible for wait for its work to merge, besides any --after, and stay held until you move each wait to the job ` +
        `that does that work now (queue it first if nobody has), or drop it if they no longer need it:\n\n${each.join('\n')}`,
    });
    return { owner, job: id, waiting: waiting.map(j => j.id) };
  });
}
// A queued job that can start now: due, and not waiting on a job (`after`) that's unfinished or whose pull request is
// still in review. It waits until that pull request is merged or closed: stuck (the panel couldn't run, or the branch
// moved since the review) and waiting for the board's call are still in review, and the work may yet land as it is
// (#1046). A closed one releases it, and so does a job that was cancelled (ledger.ts cancelJob()): the job starts and
// checks main for itself. Its further waits must all be met (outstanding), and the cards it waits for have left the desk
// phone (openCards), and the events it waits for have happened (wakes.ts). A push held for its thread's next task
// (review.ts heldForThread) is in review too: its pull request opens with the thread's last push. An `after` on a task
// before it in its own thread is that thread's order instead (threadorder.ts afterInOrder).
// Wrap statements using this predicate in redraws.query().
// (AFTER_MET: its after's part, which stillHolds reads too)
const AFTER_MET = `(j.after is null or exists (select 1 from jobs a where a.id = j.after and (${threadorder.afterInOrder('j', 'a')}
    or a.status in ('done', 'failed', 'stopped', 'cancelled')
    and not exists (select 1 from prs where branch = a.branch and status in ('open', 'stuck', 'board'))
    and not exists (select 1 from review_waiting_pushes w where w.push ->> 'branch' = coalesce(a.branch, 'job/' || a.id)))))`;
const READY = `j.status = 'queued' and j.not_before <= $now
  and ${AFTER_MET}
  and not exists (${outstanding('j.id')}) and not exists (${openCards('j.id')})
  and not exists (select 1 from wakes w where w.job = j.id and w.met is null)`; // (wakes.ts)

// The board's own word on a job (`x`, its alias): it follows up a call, works for one (call: queued on it, or handed out
// for one of its items, ledger.handOut), or acts on the board's answer to a card (answers). What the board left for a
// later step is held by pausing its thread or project (pauses.ts), which holds the board's word too.
const BOARD_WORD = (x: string) => `(${x}.call is not null or ${x}.answers is not null
  or exists (select 1 from calls c where c.job = ${x}.id))`;
// While the company is paused: the intercom, and the board's own word with everything on its pull request (any job on
// its branch: reviews, rulings, checks, fixes), never held, so what the board asks for runs to its merge without anyone
// naming it; the jobs the pause names, likewise, and everything on the pull requests it names. Nothing else, reviews of
// other work included: a review spends a seat as work does.
// An expedited job too: nothing holds it
const PAUSE_LETS = `($paused = 0 or j.kind = 'chat' or j.expedite = 1 or ${BOARD_WORD('j')}
  or exists (select 1 from jobs w where (w.id = cast(substr(j.branch, 5) as integer) or w.branch = j.branch)
    and ${BOARD_WORD('w')})
  or j.pr in (select value from json_each($prs))
  or exists (select 1 from json_each($allow) a join jobs w on w.id = a.value
    where w.id = j.id or coalesce(w.branch, 'job/' || w.id) = j.branch))`;
export function pauseAllowed() {
  const { paused: isPaused, allow, prs } = letsParams();
  if (!isPaused) return null;
  const allowed = db
    .prepare(`select j.id from jobs j where j.status in ${OPEN_JOBS} and ${PAUSE_LETS}`)
    .all({ paused: isPaused, allow, prs }) as { id: number }[];
  return new Set(allowed.map(job => job.id));
}

// What a pause names for the work in no thread, the CEO's desk (hq project pause unsorted, or projects.yaml
// groups.unsorted's code: pauses.ts), so a hold the CEO puts in reaches the call's work, HQ's fix rounds and its fault
// jobs there too.
export const DESK = 'unsorted';
// Work in no thread a pause of it lets go: the intercom, a meeting's seats (set for their time), a board call's
// follow-up (the board heard, which is how a hold is put in and lifted), expedited work, and an owner's sort (sortLets).
export const deskLets = (j: string) =>
  `(${j}.kind in ('chat', 'meeting') or ${j}.expedite = 1 or exists (select 1 from calls c where c.job = ${j}.id)
    or ${sortLets(j)})`;
// An owner's sort (a planning job, planning.ts) holding something open on a thread no pause holds: a job HQ made that
// waits for it (sorting.ts), review findings or a proposal for that thread. A hold doesn't keep the owner from judging
// work it lets run, or that work would wait on a sort the hold never lets start (board, 25 Oct).
function sortLets(j: string) {
  return `exists (select 1 from planning_jobs pj join proposals p on p.heard_by = pj.job
    join threads t on t.id = coalesce((select s.thread from sorts x join jobs s on s.id = x.job where x.proposal = p.id),
      (select r.thread from review_inbox r where r.proposal = p.id), p.thread)
    where pj.job = ${j}.id and p.status = 'open' and t.status = 'open' and ${pausedWith('t.id')} is null)`;
}
// Work (fix rounds too) of an agent a kind of run holds until the lent machine has finished one (runs.ts holds), and
// everything on a paused thread or project, or in no thread with the desk paused, but the intercom: work, a pull
// request's reviews, rulings and fixes (pauses.ts)
// Wrap statements using this predicate in redraws.query().
const HOLD_LETS = `(j.expedite = 1 or (j.kind != 'work' or j.agent not in (select value from json_each($held)))
  and ${heldWith('j')} is null)`;
const ROOM_WAITER = `${READY} and ${PAUSE_LETS} and ${HOLD_LETS} and j.kind != 'chat'`;

// A pause (`p`, its row's alias) that holds: not resumed, and not waiting for a decision of the board's it has answered
// or released (pauses.ts). What else it waits for (its time, its --until jobs) only wakes its owner to judge: only a
// resume lifts it (board, 25 Oct).
// Wrap statements using this predicate in redraws.query().
export function pauseHolds(p: string) {
  return `${p}.resumed is null and (${p}.decision is null
    or exists (select 1 from decisions d where d.id = ${p}.decision and d.answered is null and d.released is null))`;
}
// Whether pause `p` (its row's alias) is on thread `thread` (an SQL expression; null: the desk): the thread itself, or
// its whole project. The one copy the claim, the plan's edges and the heartbeat's suspension read, so they hold the same
// work.
function pauseCovers(p: string, thread: string) {
  return `${p}.project = coalesce(substr(${thread}, 1, instr(${thread}, '/') - 1), '${DESK}')
    and (${p}.thread is null or ${p}.thread = ${thread})`;
}
// The open pause holding work on a thread (`thread`, an SQL expression; null: the desk), as what it pauses: the
// thread's own id first, else its project's. Null for none.
// Wrap statements using this expression in redraws.query().
export function pausedWith(thread: string) {
  return `(select coalesce(p.thread, p.project) from pauses p where ${pauseHolds('p')} and ${pauseCovers('p', thread)}
    order by p.thread is null, p.id limit 1)`;
}
// The open pause holding job `j` (its row's alias), as pausedWith: never what no pause holds (pauseLets)
export function heldWith(j: string) {
  return `(case when ${pauseLets(j)} then null else ${pausedWith(`${j}.thread`)} end)`;
}
// Work no pause holds: the intercom, what the desk's pause lets go, a job a pause woke its owner with to judge it
// (pausewake.ts wake), even once the pause is on new conditions, the job a
// thread's merge woke its owner with (threadjudge.ts wake), and the CEO's hourly follow-through check, which judges the
// holds themselves, whichever project made() puts it in.
export function pauseLets(j: string) {
  return `(${j}.kind = 'chat' or ${j}.thread is null and ${deskLets(j)}
    or exists (select 1 from pause_wakes woke where woke.job = ${j}.id)
    or exists (select 1 from threads judged where judged.judge = ${j}.id) or ${FOLLOW_THROUGH(j)})`;
}
export const pausedOn = (job: number) =>
  (
    db.prepare(redraws.query(`select ${heldWith('j')} target from jobs j where j.id = ?`)).get(job) as {
      target: string | null;
    }
  ).target;
// Whether a pause holds running work `job`, which then yields at its next step (heartbeat) and goes on in its session
// once the pause lifts, as under the company's pause: a pause suspends what runs, not only what's queued (board, call
// 169). Not the run that made it (pauses.by_job), which runs on to its end.
export const pauseSuspends = (job: number) =>
  !!db
    .prepare(
      redraws.query(`select 1 from jobs j join pauses p on ${pauseHolds('p')} and ${pauseCovers('p', 'j.thread')}
      where j.id = $job and p.by_job is not $job and not ${pauseLets('j')} limit 1`),
    )
    .get({ job });
// What a pause holds, by name: the desk's (wherework.ts deskName) or a thread's or
// project's id
export const pauseName = (target: string) => (target === DESK ? deskName() : target);
const pausedWakes = (row: { kind: string; paused_with: string | null }) =>
  row.kind !== 'chat' && row.paused_with ? [`paused with ${pauseName(row.paused_with)}`] : [];

// The work that starts as soon as a seat and room free up (READY), by id: the follow-through check's read
// (followthrough.ts).
export const readyWork = () => {
  const ready = db
    .prepare(
      redraws.query(`select j.id from jobs j where ${READY} and ${PAUSE_LETS} and ${HOLD_LETS}
    and j.kind = 'work' and j.downtime = 0 order by j.id`),
    )
    .all({
      now: now(),
      ...letsParams(),
    }) as { id: number }[];
  return ready.map(j => j.id).filter(id => !threadorder.holds(id));
};

// How many jobs an engine's ready seats would start now (stalls.ts): each once, when one of those seats takes it
// (seatTakes, and a paced seat only what it takes till its weekly reset: pacedTakes, as claim). Neither the intercom's
// nor downtime work, which waits for spare capacity by design. `cli`: the seat's CLI, its engine's own if it hasn't
// reported one (claim). `pacedUntil`: a paced seat's weekly reset.
export type ReadySeat = { id: string; cli: string; pacedUntil: number | null };
export const readyOn = (engine: string, seats: ReadySeat[]) => {
  const takes = db
    .prepare(
      redraws.query(`select j.id, ${LANE('j')} board, s.value ->> 'pacedUntil' until from jobs j join json_each($seats) s
      where ${READY} and ${PAUSE_LETS} and ${HOLD_LETS} and j.kind != 'chat' and j.downtime = 0
      and ${seatTakes("s.value ->> 'id'", "s.value ->> 'cli'")}`),
    )
    .all({
      now: now(),
      engine,
      seats: JSON.stringify(seats),
      ...letsParams(),
    }) as { id: number; board: number; until: number | null }[];
  const timings = takes.some(t => t.until !== null) ? ordering.current().timings : new Map();
  return new Set(
    takes
      .filter(t => pacedTakes(ordering.key(t.id, t.board, timings), t.until ?? undefined) && !threadorder.holds(t.id))
      .map(t => t.id),
  ).size;
};

// GET /api/jobs (HQ's HUD line): every open job (running, waiting for the board, queued) and the latest finished ones, each with what
// HQ needs to say in words what it is and what it waits for. review: a run of the review loop (a panel's review, the
// consolidator's ruling or check, an author's fixes for them: review.ts Stage), which HQ shows only when asked. paused: it started and is
// back in the queue (a usage limit, a restart, a downtime yield), `until` when it may go on. ready: it starts on the next
// free seat (READY). The request it waits on by its title, and the job it waits for (after) by its agent and title, with
// where that job is (whereIs). waits: the further jobs it still waits for, each with its agent, title and state
// (WAIT_STATE). cards: the cards it still waits for, each with its title.
// Cancelled review-loop runs (dropped when a push started a round over) aren't news, so the finished ones
// leave them out. Those are the latest FINISHED of each, the work and the loop's: reviews outnumber the work two to one.
const FINISHED = 40,
  loop = (j = '') => `(${j}kind in ('review', 'consolidate') or ${j}stage is 'fix')`;
// Where a job another waits for is (`a`, its row): queued, running, board (waiting for the board), review (done, its
// pull request in review) or call (its pull request waits for the board's call). Null once nothing of it is pending.
const whereIs = (a: string) => `case when ${a}.id is null then null when ${a}.status = 'blocked' then 'board'
  when ${a}.status in ('queued', 'running') then ${a}.status
  else (select case p.status when 'board' then 'call' else 'review' end from prs p
    where p.branch = coalesce(${a}.branch, 'job/' || ${a}.id) and p.status in ('open', 'stuck', 'board') order by p.number desc limit 1) end`;
// Where a further wait (outstanding) is, as whereIs says it, or how it ended
// without merged work: failed, cancelled, or unmerged (done with no pull request, or its latest closed).
const WAIT_STATE = `coalesce(${whereIs('w')}, case w.status when 'done' then 'unmerged' else w.status end)`;
export const listJobs = (t = now()) =>
  jobRows(
    `j.id in (select id from jobs where status in ${OPEN_JOBS}
    union select * from (select id from jobs where status not in ${OPEN_JOBS} and not ${loop()} order by id desc limit ${FINISHED})
    union select * from (select id from jobs where +status in ('done', 'failed', 'stopped') and ${loop()} order by id desc limit ${FINISHED}))`,
    t,
  );
// One job as listJobs words it, however old (null if there's none): the projects view opening a job asked for by its
// number, which its latest finished may no longer hold.
export const findJob = (id: number, t = now()) =>
  Number.isSafeInteger(id) ? (jobRows(`j.id = ${id}`, t)[0] ?? null) : null;
// Jobs as listJobs words them, those `where` picks (an SQL condition on j, which may name $now and the named values
// `values` gives), newest first. The projects view's (projects.ts) carry their thread and whether they're a check.
// (values)
// Each names its code, as its after and each of its waits do. Its waits come by their ids first, then each job by its id:
// on stale planner statistics a `where w.id in (…)` scans every job's row for each job listed.
// Each card it waits on, and its own (request_shown), says whether it's on the desk phone now (shown).
// and, held, the work it waits to go live (holds; its own: request_holds).
type Listed = {
  engine: string;
  stage: string | null;
  id: number;
  agent: string;
  kind: string;
  status: string;
  seat: string | null;
  ready: number;
  after: number | null;
  waits: string;
  cards: string;
  request_shown: string | null;
  request_holds: string | null;
  thread: string | null;
  downtime: number;
  paused_with: string | null;
  pr: number | null;
  branch: string | null;
  triage: string | null;
};
export function jobRows(where: string, t = now(), values: Record<string, string | number> = {}) {
  const runsHold = held();
  const rows = db.prepare(listedQuery(where)).all({
    ...values,
    now: t,
    iso: new Date(t).toISOString(),
    held: JSON.stringify(runsHold?.agents ?? []),
  }) as Listed[];
  return listedRows(rows, t, runsHold);
}
// jobRows' statement. Its jobs come from db.ts jobs_listed, which holds every column read of `j` here, never a row's
// prompt and output: each a walk through its overflow pages on a cold file, for every row listed. A `where` picks them
// by id (a thread's: through its index, as getThread), which the index seeks; a column of j read here belongs in that
// index too (projects.test.ts checks the plan).
export const listedQuery = (where: string) =>
  redraws.query(`select j.id, j.code, j.created, j.finished, j.agent, j.title, j.engine, j.status, j.seat,
    j.attempts, j.request, q.title request_title, j.result, j.kind, j.pr, j.round, j.stage, j.step, j.downtime, j.after,
    j.thread, coalesce(j.seq, j.id) seq, j.is_check "check", j.call, j.item, j.branch, -- (branch: the projects view folds a review under its job; seq: its place in its thread, plan.ts)
    ${heldWith('j')} paused_with,
    (select json_object('job', t.job, 'base', t.base, 'selection', json(t.selection)) from review_triage t
      where t.pr = j.pr and t.round = j.round and t.job <= j.id order by t.job desc limit 1) triage,
    ${loop('j.')} review, j.status = 'queued' and j.session is not null paused,
    case when j.status = 'queued' and j.not_before > $now then j.not_before end until, ${READY} and ${HOLD_LETS} ready,
    a.agent after_agent, a.title after_title, a.code after_code, ${whereIs('a')} after_state,
    (select json_group_array(json_object('id', w.id, 'code', w.code, 'agent', w.agent, 'title', w.title, 'state', ${WAIT_STATE}))
      from (${outstanding('j.id')}) o cross join jobs w on w.id = o.id) waits,
    ${CARD_COLUMNS}
  from jobs j indexed by jobs_listed left join requests q on q.id = j.request left join jobs a on a.id = j.after
  -- listJobs: the latest finished from the newest down (+status: not through the state's index, which holds every done job)
  where ${where}
  order by j.id desc`);
function listedRows(rows: Listed[], t: number, runsHold: ReturnType<typeof held>) {
  // wakes: the events it still waits for, in words (hq job --when), a kind of run's hold on its agent's work, the
  // pause on its thread or project, and its thread's order (threadorder.ts.)
  const inOrder = threadorder.words();
  const heldBy = (row: Listed) => [
    ...(row.kind === 'work' ? heldWakes(row.agent, runsHold) : []),
    ...pausedWakes(row),
    ...inOrder(row),
  ];
  // a queued job's start and rank (queuePlaces).
  const places = queuePlaces(rows, t);
  return rows.map(row => ({
    ...row,
    ...(row.ready && inOrder(row).length && { ready: 0 }),
    triage: row.triage ? JSON.parse(row.triage) : null,
    waits: JSON.parse(row.waits),
    cards: JSON.parse(row.cards),
    request_shown: row.request_shown && JSON.parse(row.request_shown),
    request_holds: row.request_holds && JSON.parse(row.request_holds),
    wakes: row.status === 'queued' ? [...wakes.pending(row.id), ...heldBy(row)] : [],
    ...(places.get(row.id) ?? { start: null, rank: null }),
  }));
}
// Where each queued job of `rows` stands: start, when the plan starts it (the latest play's, forecast.ts), a time; rank,
// its place among every queued job in the claim's order (ordering.claimOrder), which HQ lists the queue in.
function queuePlaces(rows: { id: number; status: string }[], t: number) {
  const places = new Map<number, { start: number | null; rank: number | null }>();
  if (!rows.some(row => row.status === 'queued')) return places;
  const plan = lastPlayed()?.usual;
  const queued = db
    .prepare(
      `select j.id, j.kind, j.downtime, ${LANE('j')} board from jobs j where j.status = 'queued' and j.kind != 'chat'`,
    )
    .all() as Claimable[];
  const rank = new Map(queued.sort(ordering.claimOrder(ordering.current(t).timings)).map((j, i) => [j.id, i]));
  for (const row of rows)
    if (row.status === 'queued')
      places.set(row.id, { start: plan?.get(row.id)?.start ?? null, rank: rank.get(row.id) ?? null });
  return places;
}
// The jobs that a job (`job`, an SQL expression) still waits for in db.ts waits,
// besides its `after`. A wait is met once its job ended done and the latest pull request on its branch merged. A job that
// ended without one (no pull request, closed unmerged, failed or cancelled) holds it until the wait is moved or removed.
// Work found on main already meets its waits (review.ts close).
// Wrap statements using this query in redraws.query().
// Filter each union arm by the job so lookups seek its own waits without scanning every wait.
function outstanding(job: string) {
  return `select prior.current_job id from waits pending join wait_states prior on prior.id = pending.on_job
      where pending.job = ${job} and not prior.met
    union select id from redraw_holds where waiter = ${job} order by id`;
}
// A job (`prior`, its row's alias) ended done and the latest pull request on its branch merged: a wait's test, and a
// pause's --until (pauses.ts)
// Wrap statements using this predicate in redraws.query().
export function merged(prior: string) {
  return `(select met from wait_states where id = ${prior}.id)`;
}

// redraws.relations includes these for batch planning, claims, lists and pause eligibility.
// Keep wait_states inline so callers can seek only the jobs they need while sharing the wait-met rule. Every wait's job
// and its replacement come from db.ts jobs_state, not their rows: status and branch sit after the brief, and each
// statement reads every wait (seconds on a cold file).
export function waitRelations() {
  return `wait_states as not materialized (
      select prior.id, coalesce(current.job, prior.id) current_job,
        (prior.status = 'done' and original.branch is not null
          or ${hasReplacement('prior.id')} and coalesce(replacement.status = 'done' and replaced.branch is not null, 0)) met
      from jobs prior indexed by jobs_state left join redraw_current current on current.prior = prior.id
        left join jobs replacement indexed by jobs_state on replacement.id = current.job
        left join merged_branches original on original.branch = coalesce(prior.branch, 'job/' || prior.id)
        left join merged_branches replaced on replaced.branch = coalesce(replacement.branch, 'job/' || replacement.id)),
    outstanding_waits as not materialized (
      select pending.job, prior.current_job id from waits pending join wait_states prior on prior.id = pending.on_job
        where not prior.met
      union select waiter, id from redraw_holds)`;
}
// The cards a job (`job`, an SQL expression) still waits for in db.ts request_waits: those still open, whether or not
// they're on the desk phone yet.
export function openCards(job: string) {
  return `select pending.request from request_waits pending join requests card on card.id = pending.request
    where pending.job = ${job} and card.status = 'open' order by pending.request`;
}
// Whether a card (`card`, a requests row's alias) is on the desk phone at the query's $iso, as JSON true or false: a
// card held or hidden for later is open but not there yet.
const shownJson = (card: string) => `json(case when ${shownCard(card, '$iso')} then 'true' else 'false' end)`;
// The work a card (`card`, a requests row's alias) is held for until it's live (later.ts holdsFor), as a JSON array: each
// job by id, code and agent, a pull request by the latest task on its branch (not a review loop's round: those carry
// jobs.pr); empty for a card that isn't held.
// (the branch's work through db.ts jobs_work_branch: with the planner's statistics each held card read every job row.
const holdsJson = (
  card: string,
) => `json((select json_group_array(json_object('id', w.id, 'code', w.code, 'agent', w.agent))
  from request_holds h join jobs w on w.id = case when h.work like 'pr:%'
    then (select max(p.id) from jobs p indexed by jobs_work_branch join prs r on coalesce(p.branch, 'job/' || p.id) = +r.branch
      where r.number = cast(substr(h.work, 4) as integer) and p.kind = 'work' and p.stage is null)
    else cast(h.work as integer) end
  where h.request = ${card}.id))`;
// jobRows' columns for the cards a job waits on, and its own (q).
const CARD_COLUMNS = `(select json_group_array(json_object('id', c.id, 'title', c.title, 'shown', ${shownJson('c')},
      'holds', ${holdsJson('c')})) from requests c where c.id in (${openCards('j.id')})) cards,
    case when q.id is not null then ${shownJson('q')} end request_shown,
    case when q.id is not null then ${holdsJson('q')} end request_holds`;

// Give a seat the first job in the shared order it can run (only chats, for the slot kept free for the intercom); spare
// downtime work only when there's nothing else. `util`: the share of the seat's window used so far (the fuller of the
// 5-hour and the weekly one). `probe`: the worker doesn't know it yet and this claim may start downtime work to measure it
// (server.ts), but only work: a review or the consolidator's check doesn't yield (heartbeat), so it could run on a seat
// that's already full. `room`: the claim is below the worker's room line, with that many MB free, so a job starts only
// when its measured memory fits (room.ts measuredMb), whatever its kind. `pacedUntil`: the seat's week runs ahead of its
// pace (the worker's pacedUntil, while the board has pacing on), so until that weekly reset it takes only the board's
// word and work whose latest start comes before it (planner.ts pacedTakes). Jobs abandoned by a crashed worker are
// requeued first.
// settings 'company.paused': {"since": "...", "allow": [job ids], "prs": [pull request numbers]} while the board has the
// company paused, else absent.
export const paused = () => {
  const row = db.prepare("select value from settings where key = 'company.paused'").get() as
    { value: string } | undefined;
  return row ? (JSON.parse(row.value) as { since: string; allow?: number[]; prs?: number[] }) : null;
};
// settings 'runs.held': {"agents": [ids], "until": "until …", "line": "…"} while a kind of run holds their work (runs.ts
// holds), else absent.
export const held = () => {
  const row = db.prepare("select value from settings where key = 'runs.held'").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as { agents: string[]; until: string; line: string }) : null;
};

const heldWakes = (agent: string, runsHold: ReturnType<typeof held>) =>
  runsHold?.agents.includes(agent) ? [runsHold.until] : [];

export function claim(
  seat: string,
  engine: string,
  kind?: string,
  util = 1,
  probe = false,
  slot?: string,
  room?: number,
  pacedUntil?: number,
) {
  requeueAbandoned();
  sweepTeam(); // the members of runs that ended without saying so
  wakes.check(); // the deploys, merges and times queued jobs wait for (hq job --when)
  holdLoose(); // HQ's work made in no deliverable waits for the CEO to place it
  const cli =
    (db.prepare('select coalesce(cli, engine) cli from seats where id = ?').get(seat) as { cli: string } | undefined)
      ?.cli ?? engine;
  const fits = claimable(seat, engine, cli, util, probe, kind, room);
  if (!fits.length) {
    meetingseats.pick(fits, slot, seat);
    return null;
  }
  const reserved = meetingroom.first(fits, kind, slot);
  const sorted = reserved.jobs.length
    ? inClaimOrder(reserved.jobs, seat, engine, kind, pacedUntil, room, reserved.gathering)
    : [];
  const first = meetingseats.pick(sorted, slot, seat);
  if (!first) return null;
  const job = db.prepare('select * from jobs where id = ?').get(first.id) as Job;
  // A board-named job (only a hand-edited database could hold one) never runs, gets a token or speaks.
  if (boardId(job.agent)) {
    db.prepare("update jobs set status = 'failed', result = 'No job runs as the board', finished = ? where id = ?").run(
      new Date().toISOString(),
      job.id,
    ); // (finished)
    return null;
  }
  const token = startRun(job, seat);
  // A task in its thread's order runs on the thread's branch, and its briefing says where it is (the worker's inThread).
  const inThread = threadorder.claimed(job);
  const moved = moveToSeat(job, seat, engine, cli);
  atWork(job);
  quickRunStarted(job);
  return claimed(job, token, moved, inThread);
}

function requeueAbandoned() {
  runsLost(now() - STALE_MS);
  // Jobs abandoned by a crashed worker go back to the queue, but not forever: attempts counts the runs in a row that
  // didn't end cleanly (finish() resets it), so a long-lived intercom or a job parked a few times isn't given up on.
  const dead = db
    .prepare("select id from jobs where status = 'running' and heartbeat < ? and attempts >= ?")
    .all(now() - STALE_MS, GIVE_UP) as { id: number }[];
  for (const { id } of dead)
    finish(id, {
      status: 'failed',
      result: `Gave up: its last ${GIVE_UP} runs in a row stopped without reporting back (a worker crash or a lost connection each time).`,
    });
  // Like a run cut off by a restart (finish()), each gets its note again with the line saying so, and its agent's card
  // rests as for a paused run.
  const stale = db
    .prepare("select id, agent, note from jobs where status = 'running' and heartbeat < ?")
    .all(now() - STALE_MS) as Pick<Job, 'id' | 'agent' | 'note'>[];
  for (const j of stale) {
    db.prepare("update jobs set status = 'queued', seat = null, note = ? where id = ?").run(pausedNote(j.note), j.id);
    settle(j, 'sleeping', 'Paused');
  }
}

// The board paused the company (a reorganisation): running jobs finish and their pull requests are still reviewed,
// new work waits; the intercom and the jobs the pause names still run.
// The Claude intercom's turns go to its own slot alone: another slot's seat may start
// draining, which stops what that slot runs at its next step, and the board would wait out the stop and the resume.
// A job that must run on one CLI (createJob cli) goes only to a seat that runs it; a seat not reported yet runs its
// engine's own, as reportSeat records for a seat with no provider of another CLI.
// Work of an agent with a fallback on this seat's engine and CLI (models.ts) comes here too, before it has started,
// while no seat its own engine and CLI (or its own Codex seat) has is ready: they're out, at their limit or past
// their stop.
function claimable(
  seat: string,
  engine: string,
  cli: string,
  util: number,
  probe: boolean,
  kind?: string,
  room?: number,
  yielding: number[] = [],
) {
  const ready = db
    .prepare(`select id, engine || ':' || coalesce(cli, engine) runner from seats where ${SEAT_READY}`)
    .all({ now: now() }) as { id: string; runner: string }[];
  // The jobs it could take, then the first of them in the shared order (ordering.claimOrder).
  const candidates = db
    .prepare(
      redraws.query(`select j.id, j.kind, j.downtime, j.expedite, ${READY} ready, ${LANE('j')} board, $room is null and $util < $under and ($probe = 0 or kind = 'work') spare,
      j.status = 'running' yielding
    from jobs j where (j.status = 'queued' or j.status = 'running' and j.id in (select value from json_each($yielding)))
    and j.not_before <= $now
    and ($kind is null and (kind != 'chat' or j.engine != 'claude') or kind = $kind)
    and (${seatTakes('$seat', '$cli')}
      or ${FALLS_BACK} and j.agent in (select value from json_each($fallbacks))
      and iif(j.for_seat is null, j.engine || ':' || coalesce(j.cli, j.engine) not in (select value from json_each($readyRunners)),
        j.for_seat not in (select value from json_each($readySeats))))
    and ${PAUSE_LETS} and ${HOLD_LETS}`),
    )
    .all({
      engine,
      seat,
      yielding: JSON.stringify(yielding),
      now: now(),
      kind: kind ?? null,
      util,
      under: DOWNTIME_UNDER,
      room: room ?? null,
      probe: probe ? 1 : 0,
      ...letsParams(),
      cli,
      fallbacks: JSON.stringify(models.fallingBackTo(engine, cli)),
      readyRunners: JSON.stringify(ready.map(r => r.runner)),
      readySeats: JSON.stringify(ready.map(r => r.id)),
    }) as (Claimable & { spare: number; yielding: number; ready: number })[];
  return candidates;
}

// Spare downtime work only on a seat with spare room, and only when nothing else can start.
function inClaimOrder(
  fits: (Claimable & { spare: number; ready: number })[],
  seat: string,
  engine: string,
  kind?: string,
  pacedUntil?: number,
  room?: number,
  gathering = false,
) {
  // An expedited job starts before anything else, whatever the plan, pacing or room freed for another says (the board,
  // call 118).
  const expedited = fits.filter(j => j.expedite && j.ready).sort((a, b) => a.id - b.id);
  if (expedited.length) return expedited;
  const plan = ordering.current();
  const ordered = claimOrderOn(
    seat,
    engine,
    pacedUntil,
    plan,
    kind === 'chat' || gathering ? [] : freedRoom(plan),
  )(fits);
  if (room === undefined) return ordered;
  // Memory admission follows eligibility and order, so smaller undated runs cannot keep taking a window's room.
  const admitted: typeof ordered = [];
  for (const job of ordered) {
    if ((measuredMb(job.id) ?? Infinity) <= room) admitted.push(job);
    else if (ordering.key(job.id, job.board, plan.timings).latestStart !== null) break;
  }
  return admitted;
}

// A pause reserves its room from the first yield request until its waiter starts, on whichever engine: work after the
// waiter in the base order (spare work too) can't take the free memory the waiter needs beside the release. The
// intercom has its own slot.
function freedRoom(plan: ReturnType<typeof ordering.current>) {
  return (
    db
      .prepare(
        redraws.query(`select j.id, j.kind, j.downtime, ${LANE('j')} board from jobs j where ${ROOM_WAITER}
        and j.id in (select room_for from jobs where status in ('queued', 'running') and room_for is not null)`),
      )
      .all({ now: now(), ...letsParams() }) as Claimable[]
  ).filter(w => plan.eligible(w.id) && seatReadyFor(w.id, now(), null, () => plan));
}

// The claim's order on one seat, its reads made once: makesRoom orders the seat's work again for every run that might
// yield (yielding: that run leaves the seat's running set).
function claimOrderOn(
  seat: string,
  engine: string,
  pacedUntil: number | undefined,
  plan: ReturnType<typeof ordering.current>,
  freedFor: Claimable[],
) {
  const key = (j: Claimable) => ordering.key(j.id, j.board, plan.timings);
  const running = db.prepare("select id, kind from jobs where status = 'running' and seat = ?").all(seat) as (Pick<
    Claimable,
    'kind'
  > & { id: number })[];
  const limit = plannerCapacity()?.seatRuns[engine] ?? Infinity;
  const base = ordering.claimOrder(plan.timings);
  // (a run that would yield started already, what it needed first met: an expedited one keeps its place, so it never
  // makes room for other work)
  return (fits: (Claimable & { spare: number; ready: number; yielding?: number })[], yielding: number[] = []) => {
    const expedited = fits.filter(j => j.expedite && (j.ready || j.yielding)).sort((a, b) => a.id - b.id);
    if (expedited.length) return expedited;
    const order = reviewroom.claimOrder<Claimable>(
      running.filter(r => !yielding.includes(r.id)),
      limit,
      base,
      j => key(j).latestStart !== null,
    );
    const eligible = fits.filter(
      j =>
        plan.eligible(j.id) &&
        (j.spare || !spareOnly(j, key(j))) &&
        pacedTakes(key(j), pacedUntil) &&
        !freedFor.some(w => w.id !== j.id && base(w, j) < 0),
    );
    const needsRoom = eligible.some(j => !spareOnly(j, key(j)));
    return eligible.filter(j => !needsRoom || !spareOnly(j, key(j))).sort(order);
  };
}

function startRun(job: Job, seat: string) {
  // The agent's own credential for this run (HQ_TOKEN): only its hash is kept, and it stops working when the job
  // stops running. A new claim gets a new token.
  const token = randomBytes(32).toString('base64url');
  // The note (a call's transcript, the board's answer) stays until the run ends: a run cut off before its session
  // took it in gets it again (finish()). What a stop cut (cut) goes out once, with this claim.
  db.prepare(
    "update jobs set status = 'running', seat = ?, heartbeat = ?, attempts = attempts + 1, token = ?, started = coalesce(started, ?), held_by = null, cut = null, room_for = null where id = ?",
  ).run(seat, now(), sha256(token), new Date().toISOString(), job.id); // (started)
  db.prepare('update jobs set room_for = null where room_for = ?').run(job.id);
  runStarted(job.id, seat);
  return token;
}

// The job takes the claiming seat's engine and CLI (moved: a fallback's), and a Codex job the seat itself.
function moveToSeat(job: Job, seat: string, engine: string, cli: string) {
  const moved = job.engine !== engine || (job.cli ?? job.engine) !== cli;
  if (moved) {
    db.prepare('update jobs set engine = ?, cli = ?, for_seat = null where id = ?').run(engine, cli, job.id);
    Object.assign(job, { engine, cli, for_seat: null });
  }
  // A Codex job made with no seat signed in is for the first seat that claims it, so a later limit can't move it.
  if (engine === 'codex' && !job.for_seat) {
    db.prepare('update jobs set for_seat = ? where id = ?').run(seat, job.id);
    shareTo(seat, job.id);
  }
  return moved;
}

// What the worker gets for a claimed job: the job, its token, its agent and the company it works for.
function claimed(job: Job, token: string, moved: boolean, inThread: ReturnType<typeof threadorder.claimed>) {
  // The model it runs on is its own runner's (modelOf): the board's pick can differ from where the job is by now.
  const found = findAgent(job.agent),
    fallback = found?.fallback;
  const a = found && { ...found, ...modelOf(job, found) };
  if (moved && fallback)
    publish({
      type: 'log',
      agent: job.agent,
      text: `Job #${job.id} runs on ${fallback.name}: its own model's seats are out or at their limit`,
    });
  const n = names(),
    mail = infra(); // the company it works for: what it's called, and what its agents commit as
  const company = {
    name: n.name,
    phone: n.phone,
    newsletter: n.newsletter,
    intercom: n.intercom,
    agentEmailDomain: mail.AGENT_EMAIL_DOMAIN,
    agentsEmail: mail.AGENTS_EMAIL,
    language: languageName(), // what the board reads and hears in (language.ts.)
    timeZone: timeZone(), // and the clock its times are on
    stylePrompt: stylePrompt(),
    lighter: models.lighterChoices(job.engine).map(({ id, name }) => ({ id, name })),
  };
  const quickRun = quickRunTurn(job);
  // (title: as agents read it, a review step's with its step and round: nameOf.)
  // (archiving: the agent's open pull request that already moves its older profile lines, for the worker's oversized())
  return {
    ...job,
    title: nameOf(job),
    token,
    // (a quick run's turn, in the fields every worker reads and its run records keep: a reload keeps the deadline)
    ...(quickRun && { quickReply: true, quickReplyUntil: quickRun.until }),
    // (the title as its prompts say it: with its focus, company.ts titleOf)
    agentInfo: a && { ...a, role: titleOf(a) },
    company,
    ...(job.kind === 'work' || isIntercom(job) ? { inFlight: inFlight(job), archiving: archiving(job.agent) } : {}),
    ...carryOver(job), // (resumes or closingReports)
    ...(inThread && { inThread }),
    ...(found && a && lightRun(job, a.model, found.model)),
  };
}

// A run on the lighter model its queuer chose (hq job --model) is told so, and how to hand the work up to its agent's
// own model (lighter: the worker's briefing). The run after a hand-up (handUp) starts a new session in the job's kept
// clone, with its note (handedUp), until it has a session of its own.
const ranLight = (job: Job) => job.kind === 'work' && !!job.light && !!job.model;
function lightRun(job: Job, model: string | null | undefined, own: string | null | undefined) {
  const lighter =
    ranLight(job) && model === job.model
      ? { name: models.choiceName(job.model!), own: models.choiceName(own ?? '') }
      : undefined;
  const up = job.up && !job.session ? handUpOf(job.up) : undefined;
  return {
    ...(lighter && { lighter }),
    ...(up && { handedUp: { from: models.choiceName(up.from), note: up.note } }),
  };
}
// A hand-up as the job's history shows it (hq history): from which model, and its note where the job's report shows.
export function handUpLine(json: string, withNote: boolean) {
  const up = handUpOf(json);
  return { from: models.choiceName(up.from), ...(withNote && { note: up.note }) };
}
// (jobs.up is written by handUp alone)
const handUpOf = (json: string) => JSON.parse(json) as { from: string; note: string };

const letsParams = () => {
  const pause = paused();
  return {
    paused: pause ? 1 : 0,
    allow: JSON.stringify(pause?.allow ?? []),
    prs: JSON.stringify(pause?.prs ?? []),
    held: JSON.stringify(held()?.agents ?? []),
  };
};

// What a seat claims as its own (claim): its engine's work, for that seat or for none, on a CLI the seat runs (createJob
// cli).
// The arguments are SQL expressions, and the statement binds $engine.
const seatTakes = (seat: string, cli: string) =>
  `j.engine = $engine and (j.for_seat is null or j.for_seat = ${seat}) and (j.cli is null or j.cli = ${cli})`;
// (never work only its own engine does: engineonly.ts.)
const FALLS_BACK = "j.kind = 'work' and j.session is null and j.engine_only is null";
// A seat that takes work now: ready, or past the reset its drain or sleep waits for. The statement binds $now. (exported for panel.ts)
export const SEAT_READY = "(state = 'ready' or state in ('draining', 'sleeping') and until <= $now)";

// Whether a ready seat takes the job now (seatTakes, and a paced one only what it takes till its weekly reset:
// pacedTakes, as claim), or that one seat (`on`): a meeting's seats each need one before the meeting gathers, and a slot
// holds a seat only while the seat it claims on is one (meetingseats.ts pick). `plan`: the queue's latest starts, for a
// caller asking of many jobs at once (makesRoom).
export function seatReadyFor(job: number, t = now(), on: string | null = null, plan = () => ordering.current(t)) {
  const seats = db
    .prepare(
      `select iif(s.pace is null or s.week_resets <= $now, null, s.week_resets) until, ${LANE('j')} board, j.expedite from jobs j
    join (select * from seats where ${SEAT_READY}) s on s.engine = j.engine and ($on is null or s.id = $on)
    and (j.for_seat is null or j.for_seat = s.id) and (j.cli is null or j.cli = coalesce(s.cli, s.engine))
    where j.id = $job`,
    )
    .all({ job, now: t, on }) as { until: number | null; board: number; expedite: number }[];
  // (pacing holds no expedited job)
  if (!seats.length || seats.some(s => s.until === null || s.expedite)) return seats.length > 0;
  const order = ordering.key(job, seats[0].board, plan().timings);
  return seats.some(s => pacedTakes(order, s.until!));
}

// Whether a queued job waits only for seats at their limits: every seat that would take it (seatTakes, or its agent's
// fallback's before it has started, as claim does) is draining or asleep until a reset still ahead. No seat for it, or
// one signed out, won't come back by itself: that's no such wait. A paused seat takes no work, so it doesn't count.
export function seatsOut(job: number, t = now()) {
  const { agent } = db.prepare('select agent from jobs where id = ?').get(job) as { agent: string };
  const seats = db
    .prepare(
      `select id, engine, coalesce(cli, engine) cli, state, ${SEAT_READY} ready from seats where state != 'paused'`,
    )
    .all({ now: t }) as { id: string; engine: string; cli: string; state: string; ready: number }[];
  const takes = db.prepare(
    `select ${seatTakes('$seat', '$cli')} own, ${FALLS_BACK} fallsBack from jobs j where j.id = $job`,
  );
  const theirs = seats.filter(s => {
    const { own, fallsBack } = takes.get({ job, seat: s.id, cli: s.cli, engine: s.engine }) as {
      own: number;
      fallsBack: number;
    };
    return own || (fallsBack && models.fallingBackTo(s.engine, s.cli).includes(agent));
  });
  return theirs.length > 0 && theirs.every(s => !s.ready && ['draining', 'sleeping'].includes(s.state));
}

// The model and effort a run asks for, those of the engine and CLI the job is on: its fallback's once it moved there, the
// board's pick (else a scheduled entry's lighter model or effort, schedule.ts, or its agent's) where the job is on the
// pick's own. A job that began or was made on another (a pick changed, a fallback cleared after it moved) gets its
// engine's, as a model of another engine is refused there. Work only one engine does runs on its rule's model, whatever
// the pick or fallback (engineonly.ts.) A quick run thinks at QUICK_EFFORT (quickruns.ts).
function modelOf(job: Job, found: NonNullable<ReturnType<typeof findAgent>>) {
  const picked = pickedModel(job, found),
    rule = engineOnly.byId(job.engine_only);
  return { ...picked, ...(rule && { model: rule.model }), ...(isQuickRun(job) && { effort: QUICK_EFFORT }) };
}
function pickedModel(job: Job, found: NonNullable<ReturnType<typeof findAgent>>) {
  const runner = models.runner(job),
    { fallback } = found;
  if (fallback && models.runner(fallback) === runner)
    return { model: fallback.id, effort: readModels()[fallback.engine]?.effort ?? null };
  // (a lighter model its queuer chose holds under the board's pick too: hq job --model checked it runs on the pick's
  // seats.)
  if (models.runner(found) === runner)
    return {
      model: found.cli && !job.light ? found.model : (job.model ?? found.model),
      effort: job.effort ?? found.effort,
    };
  const own = readModels()[job.engine];
  return { model: own?.model ?? null, effort: own?.effort ?? null };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Who is calling with an agent token: the job it was minted for, while that job runs.
export const tokenJob = (token: string) =>
  token
    ? (db.prepare("select id, agent from jobs where token = ? and status = 'running'").get(sha256(token)) as
        { id: number; agent: string } | undefined)
    : undefined;

export const jobAgent = (id: number) =>
  (db.prepare('select agent from jobs where id = ?').get(id) as { agent: string } | undefined)?.agent;

// Only the seat that claimed a job reports on it, and only while it runs.
export const runsOn = (id: number, seat: unknown) =>
  !!db.prepare("select 1 from jobs where id = ? and status = 'running' and seat = ?").get(id, String(seat));

// Of the given jobs, the ones that have ended (done, failed, stopped or cancelled), with their kind: their folders can go (the
// worker's sweepEnded). A done work job whose pull request can still merge keeps its, as a fix round on it goes on in
// its session (resumes); one with no pull request has none to wait for (coalesce: its status reads null).
export const ended = (ids: number[]) =>
  ids.length
    ? db
        .prepare(
          `select id, kind from jobs j where status in ('done', 'failed', 'stopped', 'cancelled')
  and id in (${ids.map(() => '?').join(',')}) and not coalesce(kind = 'work' and ${mergePending('j')}, 0)`,
        )
        .all(...ids)
    : [];

// The agent with its department, charter, its voice on calls (voiceOf), and the model, effort and auto-compact window it
// runs on (company/models.yaml, overridable per agent in org.yaml). (voice)
export function findAgent(id: string) {
  const files = readModels();
  for (const d of org().departments ?? [])
    for (const own of d.agents ?? [])
      if (own.id === id) {
        const a = models.asPicked(own),
          m = files[a.engine] ?? {};
        return {
          ...a,
          department: d.id,
          charter: d.charter,
          voice: voiceOf(own),
          model: a.model ?? m.model ?? null,
          effort: a.effort ?? m.effort ?? null,
          autocompact: a.autocompact ?? m.autocompact ?? null,
        };
      }
}

// Whether an agent is on the team that runs the foundation here:
// the department of org.yaml's process role, whatever the company calls it. It asks for the server's GitHub key and can
// send a stuck pull request back to the panel. False for everyone if the process role isn't in a department.
export function inProcess(id: string) {
  const team = findAgent(roles().process)?.department;
  return !!team && findAgent(id)?.department === team;
}

// The model and effort for the board's calls (models.yaml `calls`; the voice line asks for them with each call).
export const callModel = () => {
  const m = readModels().calls ?? {};
  return { model: m.model ?? 'claude-opus-5-5', effort: m.effort ?? 'low' };
};

function readModels(): Record<string, { model?: string; effort?: string; autocompact?: number | string }> {
  return yamlFile('company/models.yaml'); // ({} when it's missing or doesn't parse)
}

// Running work pauses for ready work that can't wait (the design note "One way work is ordered", Making room): work
// that waits for room a run holds, with a seat ready to start it (a seat out of its window frees nothing by pausing), and
// that comes before it in the shared order and can't wait (planner.ts pauseVictim: the board's word after ROOM_AFTER_MS,
// a latest start within PAUSE_MS, or spare downtime work in its way). What it waits for is the worker's (InTheWay): with
// a seat of its own free, a slot or memory, which any run frees; with every seat it would start on at its run cap, a run
// on one of those. One running job per such work, the last in the order of those that free it first: this run yields
// when it's one of them, for the work it answers (undefined: it runs on). Every run's heartbeat carries the same report,
// so each picks the same runs.
type InTheWay = { short: boolean; capped: string[] };
type RoomRun = Claimable & Order & { engine: string; seat: string; followThrough: number | boolean };
type RoomWaiter = Claimable & Order & { engine: string; seats: string[]; created: number };
// Worked out once for every run's heartbeat while the worker's report, the queue and the seats stay as they are (on the
// live server, as ordering.ts keeps its plan): each run sends one a minute, and each played every seat's claim again,
// several seconds that held HQ (24 October).
const ROOM_KEEP_MS = 20_000;
let roomKept: { at: number; key: string; victims: Map<number, number> } | undefined;
function makesRoom(id: number, room: InTheWay) {
  const t = now();
  if (!ordering.live()) return roomFor(room, t).get(id); // (tests and scripts: every heartbeat reads afresh)
  const key = JSON.stringify([
    room,
    db
      .prepare(
        `select count(*) n, total(id) ids, total(julianday(created)) made, total(not_before) held, total(coalesce(room_for, 0)) freed,
      total(expedite) expedited from jobs where status in ('queued', 'running')`,
      )
      .get(),
    db.prepare("select group_concat(id || state || coalesce(pace, '') || coalesce(until, '')) seats from seats").get(),
  ]);
  if (!roomKept || roomKept.key !== key || Math.abs(t - roomKept.at) > ROOM_KEEP_MS)
    roomKept = { at: t, key, victims: roomFor(room, t) };
  return roomKept.victims.get(id);
}
function roomFor(room: InTheWay, t: number): Map<number, number> {
  const expedited = expeditedRoom(room, t);
  if (expedited) return expedited;
  if (!room.short && !room.capped.length) return new Map();
  // Meeting dates admit paced seats but never ask running work to yield.
  const queued = db
    .prepare(
      redraws.query(
        `select j.id, j.kind, j.engine, j.created, j.downtime, ${LANE('j')} board from jobs j where ${ROOM_WAITER} and j.kind != 'meeting'`,
      ),
    )
    .all({ now: t, ...letsParams() }) as (Claimable & { engine: string; created: string })[];
  if (!queued.length) return new Map();
  const plan = ordering.current(t);
  const running = roomRuns(plan);
  const claims = roomClaims(
    t,
    plan,
    running.map(v => v.id),
  );
  const waiting = queued
    .map(w => ({ ...w, seats: claims.seats.filter(s => claims.order(s).some(j => j.id === w.id)) }))
    .filter(w => w.seats.length && (room.short || w.seats.every(s => room.capped.includes(s))));
  if (!waiting.length) return new Map();
  const key = (j: { id: number; board: number | boolean }) => ordering.key(j.id, j.board, plan.timings);
  const ahead = waiting
    .map(w => ({ ...w, ...key(w), created: Date.parse(w.created) }))
    .sort(ordering.claimOrder(plan.timings));
  return roomVictims(ahead, running, room, t, (w, selected) =>
    w.seats.some(
      s =>
        (selected.some(v => s === v.seat) || !room.capped.includes(s)) &&
        claims.order(
          s,
          selected.map(v => v.id),
        )[0]?.id === w.id,
    ),
  );
}

function roomRuns(plan: ReturnType<typeof ordering.current>) {
  return (
    db
      .prepare(
        `select j.id, j.kind, j.downtime, j.engine, j.seat, j.expedite, ${LANE('j')} board, ${FOLLOW_THROUGH('j')} followThrough
        from jobs j where j.status = 'running'`,
      )
      .all() as {
      id: number;
      kind: string;
      downtime: number;
      engine: string;
      seat: string;
      board: number;
      followThrough: number;
      expedite: number;
    }[]
  ).map(v => ({ ...v, ...ordering.key(v.id, v.board, plan.timings) }));
}

// Read the same candidates and order as a normal claim after freeing capacity. A proposed victim joins the queue
// and leaves its seat's running set, so a review preference cannot give the place straight back to it. Each ready
// seat's candidates (with every run that might yield) and its order's reads are read once; a seat's order with a group
// yielding (none: as it stands) is played when asked, once.
function roomClaims(t: number, plan: ReturnType<typeof ordering.current>, yielders: number[]) {
  const freed = freedRoom(plan);
  const onSeat = new Map(
    readySeats(t).map(s => {
      const fits = claimable(s.id, s.engine, s.cli, s.util, false, undefined, undefined, yielders).filter(
        j => j.kind !== 'chat',
      );
      return [
        s.id,
        {
          fits,
          order: claimOrderOn(s.id, s.engine, s.pacedUntil ?? undefined, plan, freed),
          played: new Map<string, Claimable[]>(),
        },
      ] as const;
    }),
  );
  const order = (seat: string, yielding: number[] = []): Claimable[] => {
    const s = onSeat.get(seat);
    if (!s) return [];
    const key = yielding.join(',');
    if (!s.played.has(key))
      s.played.set(
        key,
        s.order(
          s.fits.filter(j => !j.yielding || yielding.includes(j.id)),
          yielding,
        ),
      );
    return s.played.get(key)!;
  };
  return { seats: [...onSeat.keys()], order };
}

// The ready seats as a claim reads them: how much of its window each has used, and until when it's paced.
function readySeats(t: number) {
  const seats = db
    .prepare(
      `select id, engine, coalesce(cli, engine) cli, util, resets, week, week_resets,
      iif(pace is null or week_resets <= $now, null, week_resets) pacedUntil from seats where ${SEAT_READY}`,
    )
    .all({ now: t }) as {
    id: string;
    engine: string;
    cli: string;
    util: number | null;
    resets: number | null;
    week: number | null;
    week_resets: number | null;
    pacedUntil: number | null;
  }[];
  return seats.map(s => ({
    ...s,
    util:
      windowUsed(
        {
          util: s.util ?? undefined,
          resets: s.resets ?? 0,
          week: s.week ?? undefined,
          weekResets: s.week_resets ?? 0,
        },
        t,
      ) ?? 1,
  }));
}

// An expedited job takes its room from the latest-started work, retaining each paused session.
function expeditedRoom(room: InTheWay, t: number) {
  if (!room.short && !room.capped.length) return undefined;
  const seats = (db.prepare('select id from seats').all() as { id: string }[]).map(s => s.id);
  const waiter = (
    db
      .prepare(redraws.query(`select j.id from jobs j where ${READY} and j.expedite = 1 order by j.id`))
      .all({ now: t }) as { id: number }[]
  )
    .map(w => ({ ...w, seats: seats.filter(s => seatReadyFor(w.id, t, s)) }))
    .find(w => w.seats.length && (room.short || w.seats.every(s => room.capped.includes(s))));
  if (!waiter) return undefined;
  const open = waiter.seats.some(s => !room.capped.includes(s));
  const running = db
    .prepare("select id, seat, kind, expedite from jobs where status = 'running' order by started desc, id desc")
    .all() as { id: number; seat: string; kind: string; expedite: number }[];
  const budget = pauseBudget(
    running.map(r => r.id),
    t,
  );
  const candidates = running.filter(r => r.kind === 'work' && !r.expedite);
  const selected = reviewroom.pauseGroup(
    candidates,
    (remaining, chosen) => remaining.find(r => open || chosen.length || waiter.seats.includes(r.seat)),
    chosen =>
      chosen.length > 0 &&
      budget.fits(
        waiter.id,
        chosen.map(r => r.id),
      ),
  );
  return new Map(selected.map(r => [r.id, waiter.id]));
}

function roomVictims(
  waiting: RoomWaiter[],
  running: RoomRun[],
  room: InTheWay,
  t: number,
  startsAfterYield: (waiter: RoomWaiter, victims: RoomRun[]) => boolean,
) {
  const victims = new Map<number, number>();
  const budget = pauseBudget(
    running.map(r => r.id),
    t,
  );
  for (const w of waiting) {
    const open = w.seats.some(s => !room.capped.includes(s));
    const candidates = running.filter(r => !victims.has(r.id) && !r.expedite);
    const limit = plannerCapacity(t)?.seatRuns[w.engine] ?? Infinity;
    const reviewSeat = w.seats.find(s =>
      reviewroom.needsRoom(
        w,
        candidates.filter(r => r.seat === s),
        limit,
      ),
    );
    const selected = reviewroom.pauseGroup(
      candidates,
      (remaining, chosen) => {
        const constrained = !open && !chosen.length;
        const eligible = constrained
          ? remaining.filter(r => (reviewSeat ? r.seat === reviewSeat : w.seats.includes(r.seat)))
          : remaining;
        const victim = reviewroom.roomVictim(w, eligible, t, { limit, capped: !open, needsReview: !!reviewSeat });
        return victim && remaining.find(r => r.id === victim.id);
      },
      chosen =>
        chosen.length > 0 &&
        budget.fits(
          w.id,
          chosen.map(v => v.id),
        ) &&
        startsAfterYield(w, [...running.filter(r => victims.has(r.id)), ...chosen]),
    );
    if (!selected.length) continue;
    const released = selected.map(v => v.id);
    for (const id of released) victims.set(id, w.id);
    budget.reserve(w.id, released);
  }
  return victims;
}

// A running job's heartbeat says when to yield, and why. Deadline pressure can pause lower work, reviews and rulings.
// Other room and downtime yields keep their normal tool-boundary pause. A deadline yield asks the worker to stop
// immediately and preserve the session and clone, including a review's unfinished verdict.
// A job someone stopped (hq stop) hears it here: `stop`, who and why, ends the run now.
// Work yields back to the queue in its session (the board, 18 October): while the company is paused, unless the pause
// lets it through, while a pause of its deliverable or project holds it (pauseSuspends), and to make room (makesRoom).
// reined: its job is past its share of HQ's time (reins.ts). The beat still keeps the run's lease and tells a stop, a
// suspension, a pause and a room yield (makesRoom's replay of the claims is kept for every run's beat, not this job's
// own); its downtime-window check, which places the job in the played plan, waits for a beat within the share:
// `reined`, and the worker keeps the window yield it heard last
export function heartbeat(
  id: number,
  o: { util?: number; probe?: boolean; reined?: boolean } & Partial<InTheWay> = {},
) {
  db.prepare("update jobs set heartbeat = ? where id = ? and status = 'running'").run(now(), id);
  const job = db
    .prepare(
      `select downtime, kind, thread, stopping, suspending, off_worker, ${LANE('j')} board from jobs j where id = ?`,
    )
    .get(id) as
    | {
        downtime: number;
        kind: string;
        thread: string | null;
        stopping: string | null;
        suspending: string | null;
        off_worker: number;
        board: number;
      }
    | undefined;
  if (job?.stopping) return { ok: true, stop: job.stopping };
  // (a review or ruling paused with its thread stops at its next step while the pause holds: suspendReview; one HQ takes
  // off the worker for its room yields with or without a pause: offWorker)
  if (job?.suspending && (job.off_worker || pausedOn(id)))
    return { ok: true, yield: job.off_worker ? 'waiting' : 'paused' };
  const roomFor = makesRoom(id, { short: !!o.short, capped: o.capped ?? [] });
  if (roomFor !== undefined) {
    db.prepare('update jobs set room_for = ? where id = ?').run(roomFor, id);
    const waiter = ordering.key(roomFor, false, ordering.current().timings);
    return { ok: true, yield: 'waiting', ...(deadlinePressure(waiter, now()) ? { immediate: true } : {}) };
  }
  if (job?.kind !== 'work') return { ok: true };
  const { paused: isPaused, allow, prs } = letsParams();
  if (
    isPaused &&
    !db.prepare(`select 1 from jobs j where j.id = $id and ${PAUSE_LETS}`).get({ id, paused: isPaused, allow, prs })
  )
    return { ok: true, yield: 'paused' };
  if (pauseSuspends(id)) return { ok: true, yield: 'paused' };
  if (o.reined) return { ok: true, reined: true };
  const spare =
    o.util !== undefined &&
    o.util >= (o.probe ? DOWNTIME_UNDER : DOWNTIME_YIELD) &&
    !!job.downtime &&
    spareOnly(job, ordering.key(id, job.board, ordering.current().timings));
  return spare ? { ok: true, yield: 'window' } : { ok: true };
}

// hq stop <job> "why": a running job ends stopped. Its commits stay on its branch without opening a pull request.
// Its item returns open to its owner for judgment. One paused mid-run
// (a limit, a restart) is stopped as it starts again. Its own agent or the CEO; the reason is logged, and the worker hears
// it with the run's next heartbeat, within a minute. A job that never ran is cancelled instead (hq cancel). A review or
// ruling on a paused thread pauses instead (suspendReview).
export function stopJob(id: number, by: string, why: string) {
  const job = db
    .prepare('select id, agent, title, step, round, kind, status, session, thread from jobs where id = ?')
    .get(id) as  // (step, round)
    | {
        id: number;
        agent: string;
        title: string;
        step: string | null;
        round: number | null;
        kind: string;
        status: string;
        session: string | null;
        thread: string | null;
      }
    | undefined;
  if (!job) return `there's no job #${id}`;
  if (by !== job.agent && by !== ceo()) return `only ${job.agent}, whose job it is, or the CEO stops #${id}`;
  if (job.kind === 'review' || job.kind === 'consolidate') return suspendReview(job, by, why);
  if (job.kind !== 'work') return `#${id} is the coordinator's own (${job.kind}), not work`;
  if (job.status === 'queued' && !job.session) return `#${id} never ran: cancel it instead (hq cancel ${id})`;
  if (job.status !== 'running' && job.status !== 'queued')
    return `#${id} isn't running (${job.status === 'blocked' ? 'it waits for the board' : job.status})`;
  db.prepare('update jobs set stopping = ? where id = ?').run(`${by}: ${why}`, id);
  publish({ type: 'log', agent: by, text: `Stopping #${id} (${job.agent}: ${nameOf(job)}): ${why}` });
  return { ok: true, running: job.status === 'running' };
}
// A review or ruling can't end early: what it wrote so far isn't a verdict. On a paused thread it yields at its next step
// instead (heartbeat), back in the queue in its session, and the pause holds it until it lifts.
function suspendReview(
  job: {
    id: number;
    agent: string;
    title: string;
    step: string | null;
    round: number | null;
    kind: string;
    status: string;
    thread: string | null;
  },
  by: string,
  why: string,
) {
  const target = pausedOn(job.id);
  if (!target)
    return `#${job.id} is the coordinator's own (${job.kind}), not work: it pauses only with its deliverable (hq deliverable pause)`;
  if (job.status !== 'running')
    return `#${job.id} isn't running (${job.status}): the pause on ${target} holds it until it lifts`;
  db.prepare('update jobs set suspending = ? where id = ?').run(`${by}: ${why}`, job.id);
  publish({ type: 'log', agent: by, text: `Pausing #${job.id} (${job.agent}: ${nameOf(job)}) with ${target}: ${why}` });
  return { ok: true, running: true, paused: target };
}
// A job HQ takes off the worker for its room (blocks.ts, jam.ts). Work is stopped (stopJob). A review or ruling can't end
// early (suspendReview), so it yields at its next step instead, back in the queue in its session, and starts again only
// when the worker has room for its claim. What's not running is left as it is, said so.
export function offWorker(id: number, why: string) {
  const job = db.prepare('select kind, status from jobs where id = ?').get(id) as
    { kind: string; status: string } | undefined;
  if (job?.kind !== 'review' && job?.kind !== 'consolidate') return stopJob(id, ceo(), why);
  if (job.status !== 'running') return `#${id} isn't running (${job.status})`;
  db.prepare('update jobs set suspending = ?, off_worker = 1 where id = ?').run(`${ceo()}: ${why}`, id);
  publish({ type: 'log', agent: ceo(), text: `Taking #${id} off the worker until it has room: ${why}` });
  return { ok: true, running: true, yields: true };
}

// In one transaction, so its dozen writes cost one disk sync, and a hand-off that throws leaves the job running for the
// worker's retry
export function finish(id: number, r: Parameters<typeof finishJob>[1]) {
  return inOneStep(() => finishJob(id, r));
}
// Outcomes a worker reports when a run ends.
// (gates; tests)
type RunEnd = {
  status: 'done' | 'failed' | 'stopped' | 'limited' | 'parked' | 'interrupted' | 'yielded' | 'snagged' | 'up';
  result?: string;
  up?: string; // (up: hq up's note, handUp.)
  landing?: { summary: string; result: string }; // (snagged)
  session?: string;
  branch?: string;
  resetAt?: number;
  output?: string;
  pr?: number;
  files?: string[];
  links?: string[];
  frontmatter?: { path: string; text: string | null }[];
  knowledge?: { docs: { path: string; text: string }[]; files: string[] };
  sha?: string;
  settings?: { path: string; before: string | null; after: string | null }[];
  pushedSince?: { sha: string; files: string[] };
  lines?: ChangedLines;
  gates?: Check;
  tests?: Check;
  carry?: carries.Checked['carry'];
  // a task's own profile lines, sent to main on a branch of their own (the worker's profile split).
  profile?: { pr: number; branch: string; sha: string; files: string[] };
  touchup?: unknown;
  overtime?: boolean; // a quick run the worker stopped at its deadline (quickruns.ts QUICK_RUN_MS)
  // a profile pull request's fix that left nothing for main: the worker withdrew its branch.
  withdrawn?: boolean;
  seat?: string;
  usage?: unknown;
  lost?: unknown;
  lostAt?: unknown;
  members?: string[];
  request?: {
    kind: string;
    title: string;
    body: string;
    urgency?: string;
    secrets?: string;
    address?: unknown;
    approves?: string;
    photos?: unknown;
    documents?: unknown;
    zips?: unknown;
    questions?: unknown;
    products?: unknown;
    back?: unknown;
    topic?: unknown;
    visibleFrom?: unknown;
    decides?: unknown;
  };
};
function finishJob(id: number, r: RunEnd) {
  const job = db.prepare('select * from jobs where id = ?').get(id) as Job | undefined;
  if (!job) return 404;
  if (['done', 'failed', 'stopped', 'cancelled'].includes(job.status)) return { ok: true }; // reported twice: hand-offs happen once
  // Snagged: the worker couldn't reach GitHub (the mirror's fetch at the run's start, or the push or pull request after
  // a run that ended well), never the agent's doing. Like a run a restart cut
  // off, the job goes back in the queue, a few runs in a row; then, or an intercom turn (retryChat), it failed.
  if (r.status === 'snagged' && (job.kind === 'chat' || job.attempts >= SNAG_RUNS)) r = { ...r, status: 'failed' };
  // A hand-up from a run on its agent's own model has nowhere to go: the run failed (hq up refuses it first).
  if (r.status === 'up' && !ranLight(job))
    r = {
      ...r,
      status: 'failed',
      result:
        `${r.result ?? ''}\n\nhq up hands a job on a lighter model up to its agent's own, and this one ran on its own.`.trim(),
    };
  if (job.status === 'running')
    runEnded(
      id,
      r.status,
      r.status === 'interrupted' && typeof r.lostAt === 'string' ? Date.parse(r.lostAt) : undefined,
    );
  // the run's token use (usage.ts): a bad report never stops the finish
  if (r.usage && job.status === 'running')
    try {
      recordUsage({
        job: id,
        engine: job.engine,
        seat: r.seat ?? job.seat,
        session: r.session ?? job.session,
        usage: r.usage,
      });
    } catch (err) {
      console.error(`Job #${id}: usage not recorded:`, err);
    }
  const keep = (field: string, v?: string) => v && db.prepare(`update jobs set ${field} = ? where id = ?`).run(v, id);
  keep('session', r.session);
  keep('branch', r.branch);
  keep('output', r.output);
  // A task's own profile lines, sent to main on a branch of their own whatever became of the run (the worker's profile
  // split): their pull request merges as records do.
  const profile = job.kind === 'work' ? r.profile : undefined;
  if (profile) startReview(profile.pr, profile.branch, job.agent, profile.files, profile.sha);
  // A suspension lasts one run. A resumed review runs to its end.
  if (job.suspending) db.prepare('update jobs set suspending = null, off_worker = 0 where id = ?').run(id);

  // The board's words are never dropped: a run cut off by a limit or a restart keeps the note it started with (what
  // the board said, a call's transcript) and gets it again, and a failed intercom turn is tried again twice before
  // the CEO starts over (chat.ts).
  const retryChat = isIntercom(job) && r.status === 'failed' && job.attempts < 3;
  // A task's push makes its branch its thread's (threadorder.ts).
  threadorder.pushed(job, r);
  // attempts counts runs in a row that failed or were abandoned: a run that ends any other way (done, parked, or handed
  // back by a restart, a usage limit or a downtime yield, which are nobody's fault) starts the count again.
  if (r.status !== 'failed' && r.status !== 'snagged') db.prepare('update jobs set attempts = 0 where id = ?').run(id);
  if (r.status === 'snagged') {
    // Its next run lands a run that ended well (landing: the worker's land) rather than doing the job again; a later
    // snag that never got that far keeps it.
    const landing = r.landing ? JSON.stringify(r.landing) : null;
    const at = now() + SNAG_WAIT_MS * 2 ** Math.max(0, job.attempts - 1);
    db.prepare(
      "update jobs set status = 'queued', seat = null, not_before = ?, note = ?, landing = coalesce(?, landing) where id = ?",
    ).run(at, pausedNote(job.note), landing, id);
    settle(
      job,
      'sleeping',
      `The worker's own step failed: tried again at ${companyTime(at)}`, // (on the board's clock)
    );
  } else if (r.status === 'limited' || r.status === 'interrupted' || r.status === 'yielded' || retryChat)
    handBack(job, r, retryChat);
  else if (r.status === 'parked' && r.request) {
    if (!parkOnCard(job, r.request)) return { ok: true };
  } else if (r.status === 'up') handUp(job, r);
  else {
    recordEnd(job, r);
    handOn(job, r);
  }
  jobEnded(id); // colleagues' messages it never read become jobs (unless it's only paused: messages.ts)
  carries.ended(id, r); // Queue the carry's fix in this finish transaction, once
  return { ok: true };
}

// A run handed back (a limit, a restart, a downtime yield, an intercom turn to try again) waits in the queue.
function handBack(job: Job, r: RunEnd, retryChat: boolean) {
  // A limit's hold is its seat's, not the job's: the first seat of its engine with room lets it go (setSeat). One
  // that reported ready with a reading before this finish (after the worker worked out resetAt) lets it go now.
  // A Claude turn on the chat slot (the intercom's, a quick run's) isn't held at all: the slot takes it again on the first
  // seat with room, a draining one too (the board's reserve, which setSeat doesn't count).
  const chatTurn = job.kind === 'chat' && job.engine === 'claude';
  const heldBy = r.status === 'limited' && !chatTurn ? (r.seat ?? job.seat) : null;
  const roomElsewhere =
    heldBy !== null &&
    !!db
      .prepare(
        `select 1 from seats where engine = ? and id is not ? and state = 'ready'
      and (util is not null or week is not null)`,
      )
      .get(job.engine, heldBy);
  db.prepare("update jobs set status = 'queued', seat = null, not_before = ?, note = ?, held_by = ? where id = ?").run(
    retryChat ? now() + 120_000 : roomElsewhere || chatTurn ? 0 : (r.resetAt ?? 0),
    pausedNote(job.note),
    roomElsewhere ? null : heldBy,
    job.id,
  );
  db.prepare('update jobs set cut = ? where id = ?').run(cutNote(r), job.id);
  settle(
    job,
    'sleeping',
    r.status === 'limited' ? `Out of AI capacity until ${companyTime(r.resetAt ?? 0)}` : 'Paused',
  );
}

// A run on the lighter model its queuer chose found the work bigger than it looked (hq up): the job goes back in the
// queue at once, on its agent's own model, its branch and kept clone as they are. Its next run starts a new session there
// with the run's note in its briefing (lightRun): the other model can't reuse this session's cache, so going on in it
// would write the whole conversation again. jobs.up keeps the hand-up, and the run ends as 'up' (runs.ended_as), so
// hand-ups can be counted.
function handUp(job: Job, r: RunEnd) {
  const from = job.model!,
    own = models.choiceName(findAgent(job.agent)?.model ?? 'its own model');
  db.prepare(
    "update jobs set status = 'queued', seat = null, not_before = 0, held_by = null, session = null, model = null, light = 0, up = ? where id = ?",
  ).run(JSON.stringify({ from, note: r.up, at: new Date().toISOString() }), job.id);
  settle(job, 'idle', `Handed #${job.id} up to ${own}`);
  publish({
    type: 'log',
    agent: job.agent,
    text: `#${job.id} was bigger than it looked on ${models.choiceName(from)}: handed up to ${own}, on the same branch`,
  });
}

// A run parked on a card waits for the board's answer; false when the card was refused, and the job resumes to fix it.
function parkOnCard(job: Job, request: NonNullable<RunEnd['request']>) {
  // a card whose choices would show wrong is refused here too: hq request checks it first, but files it even when that check got no answer
  // (and its questions)
  const cardBody = String(request.body ?? '');
  const problem =
    cardProblem(sharePart(cardBody).body, Array.isArray(request.back) && request.back.length > 0) ??
    unshelvedProblem(cardBody) ??
    questionsProblem(request.questions) ??
    later.parkProblem(job.id);
  const req = problem ? 400 : fileParkedCard(job, request, cardBody);
  if (typeof req === 'number') {
    // refused (photo fields that don't make sense, a grant that isn't live:/site:<slug>, keys with an approval): the job resumes to fix it
    db.prepare("update jobs set status = 'queued', seat = null, not_before = 0, note = ? where id = ?").run(
      problem
        ? `Your hq request was refused: ${problem}. Fix it and ask again.`
        : 'Your hq request was refused. ' +
            'Photo fields need 1 to 8 different labels of 1 to 80 characters, and only go with an answer box (no keys or approvals); ' +
            "document and zip fields too, and --documents-to names one of the company's own addresses that isn't for the board alone (like invoices); " +
            "an approval grants live:<slug> or site:<slug> only, and asks for no keys; keys a company tool is done with (a closed credential grant's) can't be asked for again; " +
            "--address goes on a credential card asking for four of a company tool's own keys (name, street, postcode, city); " +
            '--product and --back name products (products/<slug>), on a card that asks for no keys; a --topic is 1 to 40 characters; ' +
            '--visible-from is a day (2026-10-13) or a UTC time (2026-10-13T08:00Z), within a year; --decides names an awaited CEO decision or your review-assigned visual decision. Fix it and ask again.',
      job.id,
    );
    return false;
  }
  db.prepare("update jobs set status = 'blocked', seat = null, request = ?, note = null where id = ?").run(
    req.id,
    job.id,
  );
  settle(job, 'waiting', `Waiting for the board: ${request.title}`);
  parked(job);
  return true;
}

function fileParkedCard(job: Job, request: NonNullable<RunEnd['request']>, body: string) {
  const {
    kind,
    title,
    urgency,
    secrets,
    address,
    approves,
    photos,
    documents,
    zips,
    questions,
    products,
    back,
    topic,
    visibleFrom,
    decides,
  } = request; // (zips, visibleFrom, address, questions, decides)
  return createRequest({
    kind,
    title,
    body,
    urgency,
    secrets,
    address,
    approves,
    photos,
    documents,
    zips,
    questions,
    products,
    back,
    topic,
    visibleFrom,
    decides,
    agent: job.agent,
    job: job.id,
  });
}

// A run that ended. A stopped run keeps who stopped it and why.
function recordEnd(job: Job, r: RunEnd) {
  db.prepare(
    "update jobs set status = ?, seat = null, result = ?, finished = ?, note = null, stopping = case when ? = 'stopped' then stopping end, landing = null where id = ?",
  ).run(r.status, r.result ?? null, new Date().toISOString(), r.status, job.id);
  settle(job, 'idle');
  // (the feed shows the opening; the whole report stays on the job, for the projects view and the call notes)
  publish({
    type: 'log',
    agent: job.agent,
    text: `${r.status === 'done' ? 'Finished' : r.status === 'stopped' ? 'Stopped' : 'Failed'} #${job.id}: ${preview(r.result ?? job.title, 300)}`,
  });
}

// What an ended run hands on: the waits on it, its review, the call ledger and the jobs after it.
function handOn(job: Job, r: RunEnd) {
  // work that ended without a pull request never meets the waits on it, but a task's on its thread's branch does, at the
  // thread's merge (threadorder.ts.)
  const later = r.status === 'done' && threadorder.onThreadBranch(job, r.branch);
  if (job.kind === 'work' && (r.status === 'failed' || !r.pr) && !later)
    strandedWaits(
      job,
      r.status === 'stopped' ? 'stopped' : r.status === 'failed' ? 'failed' : 'ended done with no pull request',
    );
  // (one that pushed nothing, or failed, ends its thread, once all of it is in: threadends.ts endedEmpty.)
  const ended = r.status === 'failed' || (r.status === 'done' && !r.sha);
  if ((job.kind === 'work' || job.kind === 'meeting') && ended && !r.pr && !later && job.thread)
    threadends.endedEmpty(job.thread);
  // Hand-offs to the review panel: a finished pull request gets reviewed; finished reviews move on.
  if ((job.kind === 'work' || job.kind === 'chat') && r.status === 'done' && r.pr)
    startReview(
      r.pr,
      r.branch ?? job.branch!,
      job.agent,
      r.files ?? [],
      r.sha,
      r.links ?? [],
      r.frontmatter ?? [],
      r.knowledge,
      r.pushedSince,
      r.settings ?? [],
      r.gates,
      r.tests,
      r.lines,
      job.id,
    ); // (settings; gates; lines)
  // (a thread task that ended without a push lets go of a push held for it: review.ts heldForThread)
  if (threadorder.isTask(job) && !(r.status === 'done' && r.pr)) threadTaskEnded(job.thread);
  if (job.kind === 'chat') chatEnded(job, r.status, r.result, r.overtime === true);
  finished(job, r.status); // the call ledger: its items, and a call it follows up
  if (r.status === 'failed') failedAfter(job, r.result);
  if (r.status === 'failed' && job.kind === 'work') fixFailed(job); // an author's job on a pull request runs again
  if (job.kind === 'consolidate' && r.status === 'done' && r.touchup) touchedUp(job, r.touchup);
  if (job.kind === 'work' && r.status === 'done' && job.pr && r.withdrawn)
    withdrawn(job.pr).catch(err => console.error(`Could not close PR #${job.pr}:`, err));
  if (job.kind !== 'work' && job.kind !== 'chat' && job.pr)
    reviewFinished({ ...job, status: r.status, pr: job.pr, round: job.round ?? 1, branch: job.branch! }).catch(err =>
      console.error('Could not pass the review on:', err),
    );
}

// The opening of a long text for a one-line preview, marked when it's cut.
export const preview = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}… (cut)` : t);

// A job waiting for this one (hq job --after) starts once it ends, failed or not (READY): a failure is news it needs,
// so it starts with the report as its note. Any agent can wait on any job, though. A report that holds a customer's own
// details stays with its job (readsReport): a waiting job hears that it failed, and whose it is. So does another agent's
// job waiting on the CEO's intercom chat job: its last message is a reply to the board, not a report. A waiting job
// handed the whole of a customer's report (roles.customerData) holds those details too.
//
function failedAfter(job: Job, result?: string) {
  const owner = String(findAgent(job.agent)?.name ?? job.agent),
    customer = holdsCustomerData(job.id);
  for (const w of db.prepare("select id, agent from jobs where after = ? and status = 'queued'").all(job.id) as {
    id: number;
    agent: string;
  }[]) {
    const failed = `Job #${job.id} (${nameOf(job)}), which this job waited for, failed`;
    const whole = `${failed}. Its report:\n\n${result?.trim() || '(none)'}\n\nCheck what it left before you build on it.`;
    const own = w.agent === job.agent,
      ask = own
        ? 'check what it left (its branch, its pull request)'
        : `ask ${owner} what it left (hq say ${job.agent})`;
    const kept =
      job.kind === 'work'
        ? `${failed}. Its report holds a customer's own details, so it stays with that job: ${ask} before you build on it.`
        : own
          ? `${failed}. Its last message is a reply in the intercom that holds a customer's own details, so it stays in that conversation: check the intercom before you build on it.`
          : `${failed}. Its report is a reply in the intercom, so it stays with ${owner}: ask them what it left before you build on it (hq say ${job.agent}).`;
    const handed =
      readsReport({ id: job.id, customers: customer }, w) && (job.kind === 'work' || w.agent === job.agent);
    db.prepare("update jobs set note = ? || coalesce(char(10) || char(10) || note, '') where id = ?").run(
      handed ? whole : kept,
      w.id,
    );
    if (handed && customer) handedCustomerData(w.id);
  }
}

const PAUSED =
  'You were paused (a usage limit, a restart, the company paused, or to make room for other work). Continue where you left off.';
// What a stop cut: the run's own processes (the worker lists them as it pauses the run, or as its container stops, or
// at its last look before the server went down) and, when it paused the run, the team members still at work, whose
// sessions end with the lead's. Its next run is told plainly, once (claim hands it out and clears it). A reload of the
// worker's own process cuts nothing, so it sends none.
function cutNote(r: { status: string; lost?: unknown; lostAt?: unknown; members?: string[] }) {
  const lost = Array.isArray(r.lost)
    ? r.lost
        .filter((p): p is string => typeof p === 'string')
        .slice(0, 12)
        .map(p => preview(p, 300))
    : [];
  const members = r.members ?? [];
  const when =
    typeof r.lostAt === 'string' && !Number.isNaN(Date.parse(r.lostAt))
      ? ` at ${companyTime(Date.parse(r.lostAt))}`
      : '';
  const how =
    r.status === 'interrupted'
      ? "when the worker's container was restarted (a deploy that changed its image or settings, or the server going down)"
      : 'when this job was paused';
  const cut = [
    lost.length &&
      `These processes of yours were running${when} and were stopped ${how}:\n${lost.map(p => `- ${p}`).join('\n')}\nNothing starts them ` +
        'again for you: run again whatever you still need. What they had finished writing is still there; a file one was writing may be cut short.',
    members.length &&
      `Your team members still at work were stopped with it: ${members.join(', ')}. Start each again by the same name with ` +
        "what's left of their part; what they wrote is still in your folder.",
  ].filter(Boolean);
  return cut.length ? cut.join('\n\n') : null;
}
const PAUSED_AGAIN = `${PAUSED} This run started with the message below. Here it is again in case it never reached you; if you already acted on it, don't do it twice.`;
const pausedNote = (note: string | null) =>
  !note ? PAUSED : note.startsWith(PAUSED) ? note : `${PAUSED_AGAIN}\n\n${note}`;
// A failed run's stand-in (review.ts again()) starts with the message the failed run started with, if it had more than
// "you were paused".
const FAILED =
  "Your job on this failed before it ended, and this one runs it again. It started with the message below. Here it is again in case it never reached you; if you already acted on it, don't do it twice.";
export const failedNote = (note: string | null) =>
  !note || note === PAUSED ? null : note.startsWith(FAILED) ? note : `${FAILED}\n\n${note}`;

// (windows, whether the seat is paced, the worker's pacedUntil, and whether it may run on credits past its limits)
// A reading without a window's reset keeps the last one known. HQ drops a past
// 5-hour reset and rolls a past weekly one forward (seats.js).
type Windows = {
  fiveHourObservedAt?: number | null;
  weekObservedAt?: number | null;
  util?: number;
  resets?: number;
  week?: number;
  weekResets?: number;
  pace?: boolean;
  credits?: boolean;
};
export function setSeat(id: string, engine: string, state: string, until?: number, note?: string, w: Windows = {}) {
  const share = (n: unknown) => (typeof n === 'number' && isFinite(n) ? Math.min(1, Math.max(0, n)) : null),
    at = (n: unknown) => (typeof n === 'number' && isFinite(n) ? n : null);
  db.prepare(
    `insert into seats (id, engine, state, until, note, updated, util, resets, week, week_resets, pace, credits)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set engine = excluded.engine, state = excluded.state, until = excluded.until,
    note = excluded.note, updated = excluded.updated, util = excluded.util, resets = coalesce(excluded.resets, seats.resets),
    week = excluded.week, week_resets = coalesce(excluded.week_resets, seats.week_resets), pace = excluded.pace,
    credits = excluded.credits`,
  ).run(
    id,
    engine,
    state,
    until ?? null,
    note ?? null,
    now(),
    share(w.util),
    at(w.resets),
    share(w.week),
    at(w.weekResets),
    w.pace === true ? 1 : null,
    w.credits === true ? 1 : null,
  );
  recordSeatReading(id, w);
  seatReported(id);
  checkSeatWarning(id);
  tips.seatRead(id, share(w.week));
  // A ready seat with a reading is one the worker gives jobs to, so the jobs a limit holds, on any seat of its engine,
  // may go on now: a job paused while every seat was full starts on the first to get room (a 5-hour window resetting, a
  // drain lifted), not at its own seat's reset, days off for a full week. A seat back from a restart has no reading yet
  // and lets nothing go until it's measured.
  const measured = share(w.util) !== null || share(w.week) !== null;
  if (state === 'ready' && measured)
    db.prepare(
      "update jobs set not_before = 0, held_by = null where status = 'queued' and held_by is not null and engine = ?",
    ).run(engine);
  return { ok: true };
}

export const listSeats = () => db.prepare('select * from seats order by id').all();

// When the worker last called in: each idle slot asks for work every 15 s, and its main-merge loop asks every 15 s
// whatever runs. Quiet for a minute, it runs nothing: it's restarting, or never came up. A coordinator that just started
// counts from its start.
const WORKER_QUIET_MS = 60_000;
let workerAt = now();
export const workerHeard = (t = now()) => {
  workerAt = t;
};
export const workerQuiet = (t = now()) => t - workerAt > WORKER_QUIET_MS;

// Codex work is shared out evenly between the Codex seats. A Codex job is for the seat with
// the fewest shares in the last week, and only that seat claims it (claim). A seat that is out (at its limit, draining,
// closed) keeps its share: its jobs wait for it, so a full account never rolls its work over onto the next. The seats counted are the Codex seats the worker reported signed in, not one waiting for a
// sign-in (it may never have been an account). With none, the first seat to claim the job becomes its seat (claim).
// A seat not measured yet counts like any other: sorted as full, it would leave one account with nearly everything.
const SHARE_DAYS = 7;
// `cli`: only the seats that run that CLI count (a job that must run on it: createJob).
export function codexShare(cli?: string): string | null {
  const since = now() - SHARE_DAYS * 86400e3;
  const seat = db
    .prepare(
      `select s.id from seats s where s.engine = 'codex' and s.state in ('ready', 'draining', 'sleeping', 'closed')
    and (? is null or coalesce(s.cli, s.engine) = ?)
    order by (select count(*) from codex_shares c where c.seat = s.id and c.at > ?), coalesce((select max(c.id) from codex_shares c where c.seat = s.id), 0), s.id
    limit 1`,
    )
    .get(cli ?? null, cli ?? null, since) as { id: string } | undefined;
  return seat?.id ?? null;
}
export function shareTo(seat: string, job: number | null) {
  db.prepare('insert into codex_shares (seat, at, job) values (?, ?, ?)').run(seat, now(), job);
  db.prepare('delete from codex_shares where at < ?').run(now() - 4 * SHARE_DAYS * 86400e3);
}
// A seat the board paused or removed: the Codex jobs that were for it go to whichever seat of their engine claims them
// next (seats.ts). A removed seat lets go of its running and blocked jobs too, so one that goes back to the queue later
// isn't left waiting for a seat that is gone.
export const releaseSeat = (id: string, removed = false) =>
  db
    .prepare(
      `update jobs set for_seat = null where for_seat = ? and status in (${removed ? "'queued', 'running', 'blocked'" : "'queued'"})`,
    )
    .run(id);

// Whether a call's agent can answer, as the worker last reported its Claude seats: the voice line gets the one with the
// most room, a draining seat too (the board's reserve), so it can't only when every Claude seat is asleep at its limit
// (until: the first to wake) or signed out. Only the subscription seats count: the worker gives the voice line a login
// token, never a key seat's key (worker.ts voiceSeat). No Claude seat reported yet (a worker starting): it doesn't guess. The voice
// line says it at pickup, before the board starts talking (platform/voice/server.py).
export function callSeat(
  t = now(),
): { room: true } | { room: false; why: 'limit'; until: number } | { room: false; why: 'signin' } {
  const all = db
    .prepare(
      `select s.state, s.until, coalesce(l.provider, 'anthropic') = 'anthropic' sub from seats s
    left join seat_list l on l.id = s.id where s.engine = 'claude'`,
    )
    .all() as { state: string; until: number | null; sub: number }[];
  if (!all.length) return { room: true };
  const seats = all.filter(s => s.sub);
  if (seats.some(s => s.state === 'ready' || s.state === 'draining' || (s.state === 'sleeping' && (s.until ?? 0) <= t)))
    return { room: true };
  const waking = seats.filter(s => s.state === 'sleeping').map(s => s.until!);
  return waking.length ? { room: false, why: 'limit', until: Math.min(...waking) } : { room: false, why: 'signin' };
}

// Board requests: the desk phone.
// A card's topic, which its list groups it by. It's a word or two (billing, hosting), with its spaces tidied and the case
// as written. The phone groups "Ads" with "ads". No topic is { ok: true, topic: null }. Anything but a string of 1 to 40
// characters is { ok: false }.
export function topicOf(t: unknown): { ok: true; topic: string | null } | { ok: false } {
  if (t == null) return { ok: true, topic: null };
  if (typeof t !== 'string') return { ok: false };
  const tidy = t.replace(/\s+/g, ' ').trim();
  return tidy && tidy.length <= 40 ? { ok: true, topic: tidy } : { ok: false };
}
// What's wrong with a card's questions (hq ask --questions), worded for the agent, or null
export function questionsProblem(v: unknown) {
  const q = v === undefined || v === null ? null : asking.questions(v);
  return typeof q === 'string' ? `its --questions: ${q}` : null;
}
// A card rings at once from the board's own work or work the pass gives a latest start (a windowed thread's, or what one
// waits for).
const urgentWork = (job?: number) => {
  const timing = job == null ? undefined : ordering.current().timings.get(job);
  return !!timing && (timing.latestStart !== null || !!timing.board);
};
// What a card is made of (createRequest)
type NewCard = {
  kind: string;
  title: string;
  body: string;
  urgency?: string;
  agent?: string;
  job?: number;
  seat?: string;
  secrets?: string;
  pr?: number;
  approves?: string;
  photos?: unknown;
  documents?: unknown;
  zips?: unknown;
  customers?: boolean;
  products?: unknown;
  back?: unknown;
  topic?: unknown;
  visibleFrom?: unknown;
  address?: unknown;
  questions?: unknown;
  decides?: unknown;
  holds?: string[];
  files?: cardFiles.CardFile[];
  walk?: unknown;
  // the book note (its id) or the page (its address) it's about, as bookasks.ts place() found them
  note?: number | null;
  page?: string | null;
};
export function createRequest(r: NewCard) {
  const topic = topicOf(r.topic);
  if (!topic.ok) return 400;
  // A decision still awaited, filed by the CEO or its review-assigned card author.
  const decides = r.decides == null ? null : Number(r.decides);
  if (
    decides !== null &&
    (!decisions.canLink(decides, r.agent!) ||
      !decisions.isOpen(decides) ||
      (decisions.mergeDecision(decides) && !decisions.canFile(decides)))
  )
    return 400;
  if (decides !== null && decisions.mergeDecision(decides)) r = { ...r, questions: decisions.mergeQuestions };
  // a card for later (later.ts): off the desk phone, and silent, until then. holds: the work it waits for to go live,
  // the same way (later.ts holdsFor)
  const hidden = later.hiddenUntil(r.visibleFrom);
  if (!hidden.ok) return 400;
  // an approval grants one thing, shown in HQ's words: no keys with it (saving them could approve something else, even on Not now)
  if (r.approves && (!approvals.grantable(r.kind, r.approves) || r.secrets)) return 400;
  const box = answerBox(r);
  if (!box || keysRefused(r)) return 400;
  // the products a card is about (its answer is feedback on them) and brings back (owed.ts); never a card for keys or a sign-in
  const about = owed.slugs(r.products),
    back = owed.slugs(r.back);
  if (!about || !back || ((about.length || back.length) && (r.secrets || r.seat || r.kind === 'credential')))
    return 400;
  const reworded = rewordSeatCard(r.seat, r.body);
  if (reworded) return reworded;
  // A card from the board's own work, or work with a latest start, rings whatever urgency its agent gave it (urgentWork).
  const urgency = urgentWork(r.job) ? 'now' : (r.urgency ?? 'today');
  const id = insertCard(r, urgency, topic.topic, hidden.at, box);
  owed.tag(id, about, back, r.job);
  if (decides !== null) decisions.link(decides, id, r.agent!);
  publish({ type: 'log', agent: r.agent ?? roles().process, text: `Asked the board: ${r.title}` });
  // (one about a note shows in the book too, under the note's group: its page is read again.)
  bookReadsAgain(r);
  const shows = !hidden.at && !r.holds?.length;
  if (shows) {
    announceRequest({
      id,
      kind: r.kind,
      title: r.title,
      urgency,
      grant: r.approves ? approvals.describe(r.approves) : undefined,
    }); // rings the board's devices, or waits for the digest (a card for later or held: when it shows, later.ts sweep)
    tips.cardShows({ kind: r.kind, agent: r.agent ?? null });
  }
  return { id };
}

// A card's photo fields go next to an answer box: not with keys, an approval or a sign-in (and document and zip fields,
// and questions as form fields, questions.js, which go where photos go). Their columns, or null when one is refused.
function answerBox(r: NewCard) {
  const fields = photos.parseFields(r.photos),
    files = documents.parseFields(r.documents),
    zipFields = zips.parseFields(r.zips);
  if (fields === null || files === null || zipFields === null) return null;
  const asked = r.questions === undefined || r.questions === null ? null : asking.questions(r.questions);
  if (typeof asked === 'string' || ((fields || files || zipFields || asked) && (r.secrets || r.approves || r.seat)))
    return null;
  // files to download (cardfiles.ts): never on a card for keys
  if (r.files?.length && (r.secrets || r.seat)) return null;
  const column = (v: unknown) => (v ? JSON.stringify(v) : null);
  return { photos: column(fields), documents: column(files), zips: column(zipFields), questions: column(asked) };
}

// Keys a card may not ask for: a closed credential grant's, again, and on an address card anything but one delivery
// address, a company tool's own four
function keysRefused(r: NewCard) {
  if (r.secrets && approvals.closedFor(r.secrets.split(','))) return true;
  return (
    r.address != null &&
    r.address !== false &&
    (r.address !== true || r.kind !== 'credential' || !addressKeys(String(r.secrets ?? '').split(',')))
  );
}

// A seat has one card at a time: a second only takes its words, without ringing again (seats.ts).
function rewordSeatCard(seat: string | undefined, body: string) {
  const open =
    seat &&
    (db.prepare("select id from requests where seat = ? and status = 'open'").get(seat) as { id: number } | undefined);
  if (!open) return undefined;
  db.prepare('update requests set body = ? where id = ?').run(body, open.id);
  return { id: open.id };
}

// The card's row, and the work it's held for (later.ts holdsFor)
function insertCard(
  r: NewCard,
  urgency: string,
  topic: string | null,
  hiddenUntil: string | null,
  box: NonNullable<ReturnType<typeof answerBox>>,
) {
  // r.customers: a card a gated tool writes about one customer, with their details in it (customerCard)
  const { lastInsertRowid } = db
    .prepare(
      `insert into requests (created, agent, job, kind, title, body, urgency, seat, secrets, pr, approves, photos, documents, zips, customers, topic, hidden_until, address, questions, walk, note, page)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      r.agent ?? null,
      r.job ?? null,
      r.kind,
      r.title,
      r.body,
      urgency,
      r.seat ?? null,
      r.secrets || null,
      r.pr ?? null,
      r.approves || null,
      box.photos,
      box.documents,
      box.zips,
      r.customers ? 1 : 0,
      topic,
      hiddenUntil,
      r.address === true ? 1 : null,
      box.questions,
      r.walk === true ? 1 : 0, // its maker's walk-through offered (walkthroughs.ts)
      r.note ?? null, // (note, page)
      r.page ?? null,
    ); // (hidden_until, address, questions, walk)
  if (r.files?.length) cardFiles.keep(Number(lastInsertRowid), r.files);
  for (const work of r.holds ?? [])
    db.prepare('insert into request_holds (request, work) values (?, ?)').run(lastInsertRowid, work);
  return Number(lastInsertRowid);
}

// hq ask and hq request's card (server.ts): held for the work it waits for (later.ts holdsFor), which hq ask names with
// --when; the reply says so (held). A refusal says why.
export function fileCard(r: Parameters<typeof createRequest>[0] & { when?: unknown }) {
  const holds = later.holdsFor(r.job, r.when);
  if (typeof holds === 'string') return holds;
  const card = createRequest({ ...r, holds });
  return typeof card === 'object' && holds.length ? { ...card, held: later.heldFor(card.id) } : card;
}

// The desk phone also shows which of a credential request's keys are already saved, and, for an approval with a
// grant (or a credential request carrying a company tool's grant), what approving
// does in the coordinator's own words. Newest first, a changed card as of its change.
// A card for later (later.ts) is left out until its time, unless `hidden` asks for those too (agents see them, with when);
// once it shows, it counts as changed then: first in the list and unread again, as a new card.
// Tips (tips.ts) come after every other card, so one never takes another's place in the 100.
const requestRows = (status: string, hidden = false) =>
  (
    db
      .prepare(
        `select * from requests where status = ? and (? or ${later.SHOWN})
    order by kind = '${tips.KIND}', max(coalesce(changed, created), coalesce(hidden_until, '')) desc, id desc limit 100`,
      )
      .all(status, hidden ? 1 : 0, new Date().toISOString()) as any[]
  ).map(r => ({
    ...r,
    ...(r.hidden_until > (r.changed ?? r.created) ? { changed: r.hidden_until } : {}),
    ...(r.secrets ? { saved: stored(r.secrets.split(',')) } : {}),
    ...grants(r),
    ...(r.photos ? { photos: photos.state(r.id, r.photos) } : {}),
    ...(r.documents ? { documents: documents.state(r.id, r.documents) } : {}), // (documents)
    ...(r.zips ? { zips: zips.state(r.id, r.zips) } : {}), // (zips)
    ...(r.questions ? { questions: JSON.parse(r.questions) } : {}),
    ...withFiles(r.id),
    ...(owed.productsOf(r.id).some(product => product.back) ? { back: true } : {}),
  }));
// a card's files to download, by name (cardfiles.ts)
const withFiles = (id: number) => {
  const files = cardFiles.of(id);
  return files.length ? { files } : {};
};
// (an address card with the board's saved addresses' labels)
export const listRequests = (status = 'open') =>
  requestRows(status).map(r => ({ ...r, ...shareable(r), ...(r.address ? { addresses: addresses.list() } : {}) }));

// A card's Share part (a part after a line of --- that starts with "Share:") is what the board can
// forward to whoever has to act on it, written by the card's author for that outsider. The desk phone sends only that
// (the phone's share sheet, or the clipboard), never the card, and it never shows as part of the card. A card about
// keys has none to send, whatever its author wrote; nor do the coordinator's own (sign-ins, reviews).
const PART = /\n\s*-{3,}\s*\n/,
  SHARE = /^\s*share:[ \t]*/i;
// Only the first Share part is sent; any later one leaves the card too (the board would forward one, read another).
export function sharePart(body: string) {
  const parts = body.split(PART),
    at = parts.findIndex((p, i) => i > 0 && SHARE.test(p));
  if (at < 0) return { body };
  return {
    body: parts.filter((p, i) => !(i > 0 && SHARE.test(p))).join('\n\n---\n\n'),
    share: parts[at].replace(SHARE, '').trim(),
  };
}
const shareable = (r: { id: number; kind: string; body: string | null; secrets: string | null }) => {
  const { body, share } = sharePart(r.body ?? '');
  const own = r.kind === 'login' || r.kind === 'review' || r.kind === 'credential' || !!r.secrets;
  return { body, ...(share && !own ? { share } : {}) };
};
const grants = (r: { kind: string; approves: string | null; secrets: string | null }) => {
  const closed = r.secrets && approvals.closedFor(r.secrets.split(','));
  if (closed) return { grants: closed.closedCard };
  const g = r.approves || (r.secrets && r.kind === 'credential' && approvals.credentialGrant(r.secrets.split(',')));
  return g ? { grants: approvals.describe(g) } : {};
};

// The board's archive (HQ's desk phone › Answered): the cards that have left the desk phone, answered or taken off it,
// newest first, with what the board answered, so a card's presentation, clips and pictures can be opened again. Not a
// seat's sign-in. Every card comes whole, whatever it's about (the board, 2026-10-02 and 2026-10-06). A key typed into
// a card's key fields never reaches it: answerRequest keeps only which were saved.
// A page at a time, so every card stays reachable: { cards, more, total }; before = the last card shown, for the next page.
const ARCHIVED = "status != 'open' and kind != 'login'",
  ARCHIVE_PAGE = 50;
// The finder ranks these small rows locally. Full cards and their attachments load only when opened.
export function listArchiveIndex() {
  return db
    .prepare(
      `select id, title, agent, created, answered from requests where ${ARCHIVED}
      order by coalesce(answered, created) desc, id desc`,
    )
    .all();
}

export function listArchive(before?: number) {
  const at = before
    ? (db
        .prepare(`select coalesce(answered, created) as k, id from requests where id = ? and ${ARCHIVED}`)
        .get(before) as { k: string; id: number } | undefined)
    : undefined;
  if (before && !at) return { cards: [], more: false, total: 0 };
  const rows = db
    .prepare(
      `select id, created, answered, agent, kind, title, body, answer, closing, status, photos from requests where ${ARCHIVED}
    ${at ? 'and (coalesce(answered, created) < ? or (coalesce(answered, created) = ? and id < ?))' : ''}
    order by coalesce(answered, created) desc, id desc limit ?`,
    )
    .all(...(at ? [at.k, at.k, at.id] : []), ARCHIVE_PAGE + 1) as any[];
  const total = (db.prepare(`select count(*) as n from requests where ${ARCHIVED}`).get() as { n: number }).n;
  return {
    more: rows.length > ARCHIVE_PAGE,
    total,
    cards: rows.slice(0, ARCHIVE_PAGE).map(r => {
      const shown = {
        id: r.id,
        created: r.created,
        answered: r.answered,
        agent: r.agent,
        kind: r.kind,
        title: r.title,
        status: r.status,
      };
      return {
        ...shown,
        body: r.body,
        answer: r.answer,
        closing: r.closing,
        ...(r.photos ? { photos: photos.state(r.id, r.photos) } : {}),
        ...withFiles(r.id),
      };
    }),
  };
}
// A photo the board added to a card, for the archive: none from an open card (the desk phone shows its own).
// (A card with key fields takes no photos: createRequest.)
export const archivePhoto = (id: number, field: number) => {
  const r = db.prepare("select photos from requests where id = ? and status != 'open'").get(id) as
    { photos: string | null } | undefined;
  return r?.photos ? photos.fileFor(id, field) : undefined;
};

// A field's line goes after what the board typed; with nothing typed there are no blank lines first
const withLine = (answer: string, line: string) => [answer, line].filter(Boolean).join('\n\n');
// approve: the board pressed Approve on an approval request with a grant. That, and the board saving all of a credential
// grant's keys (approvals.ts), are the only ways an approval record is written.
// address, on an address card: use, a saved address the board picked, goes into the
// card's keys as if typed; save, the label a typed one is saved under for next time, once all four keys are in.
// answers: a card's questions', in their order
// pictureIds: the pictures the board added to its answer, uploaded for this card (pictures.ts); the answer names them, as
// an intercom line does. One no longer waiting refuses the answer and is named.
export function answerRequest(
  id: number,
  answer: string,
  secrets: Record<string, unknown> = {},
  approve = false,
  address: { use?: unknown; save?: unknown } = {},
  answers: unknown = [],
  pictureIds?: unknown,
  review = false,
) {
  const req = db.prepare("select * from requests where id = ? and status = 'open'").get(id) as any;
  if (!req) return 404;
  if (review && !owed.productsOf(id).some(product => product.back)) return 400;
  const waitingPictures = pictures.waiting(pictureIds, id);
  if (!waitingPictures || (waitingPictures.ids.length && !takesPictures(req))) return 400;
  if (waitingPictures.missing.length)
    return [
      409,
      'a picture is no longer waiting to be sent: it was sent already, removed, or went unsent for a day',
      { missing: waitingPictures.missing },
    ];
  const questions = questionsAnswered(req.questions, answers, answer);
  if (!questions) return [400, 'every question needs its answer'];
  answer = questions.answer;
  if (req.secrets) {
    const keys = keysAnswered(req, secrets, address);
    if (typeof keys !== 'string') return keys;
    answer = keys;
  }
  if (req.approves) {
    if (approve && !approvals.record(req.approves, id)) return 400;
    if (!approve) approvals.decline(req.approves, id); // a tool's grant hears Not now too
    answer = approve
      ? `Approved. ${approvals.describe(req.approves)}${answer ? ` The board added: ${answer}` : ''}`
      : `Not approved.${answer ? ` The board said: ${answer}` : ''}`;
  }
  answer = withLine(answer, pictures.mention(waitingPictures.ids));
  // A notice (kind notice: news, no question) is closed with the desk phone's Got it, a word optional: taken without one,
  // its record says so, and no job is made to hear it (a job parked on it goes on: below)
  // So is a card that brings work back, answered with notes on its preview in review mode (review): the notes queue
  // their own job as they're sent (feedback.ts)
  const gotIt = (req.kind === 'notice' && !answer.trim()) || review;
  if (review) answer = 'Leaving notes on the preview, in review mode.';
  else if (gotIt) answer = 'Got it.';
  const withFiles = filesAnswered(req, answer);
  if (typeof withFiles === 'number') return withFiles;
  answerRecorded(req, withFiles, questions.asked, waitingPictures.ids);
  if (!voiceprints.settleYearlyCard(req.id)) answerHeard(req, withFiles, gotIt);
  return { ok: true };
}
// A card about a note, filed, answered on the desk phone or in the book, or taken off the desk phone unanswered: the
// book reads the note's page again (a card about a page shows on the desk phone only: bookasks.ts)
const bookReadsAgain = (req: { agent?: string | null; note?: number | null }) =>
  req.note != null &&
  publish({ type: 'book', agent: req.agent ?? roles().process, text: 'ask', ...notePage(req.note) });
// The Notebook page a book note's group is on, as a 'book' event names it (HQ reads that page again: its answers and
// cards are under the group); none for a note of the old book's sheets with no group.
export const notePage = (note: number) => {
  const g = db.prepare('select page from notebook_groups where note = ? and deleted is null').get(note) as
    { page: number } | undefined;
  return g ? { page: g.page } : {};
};

// A card's questions, each answered (questions.js: Yes, a number, an option or a short text), lead the agent's answer, one
// line each; what the board typed follows them. null: one has no answer (an optional one may be left blank).
type Asked = { title: string; type?: string; unit?: string; options?: string[]; optional?: boolean; answer?: string };
function questionsAnswered(questions: string | null, answers: unknown, answer: string) {
  if (!questions) return { asked: null, answer };
  const asked = JSON.parse(questions) as Asked[];
  const given = Array.isArray(answers) ? answers : [],
    each = asked.map((q, k) => asking.given(q, given[k]));
  if (each.some(a => a === null)) return null;
  const done = asked.map((q, k) => ({ ...q, answer: each[k]! }));
  return {
    asked: done,
    answer: [asking.answerLines(done, each), answer.trim() && `The board added: ${answer.trim()}`]
      .filter(Boolean)
      .join('\n\n'),
  };
}

// A key card's answer: the keys go to the server's key store; the answer only says which were saved (a closed grant's
// says so). Anything but a string is the reply: a refusal, or keys still to come.
function keysAnswered(req: any, secrets: Record<string, unknown>, address: { use?: unknown; save?: unknown }) {
  const closed = approvals.closedFor(req.secrets.split(','));
  if (closed) return closed.closedAnswer;
  const names: string[] = req.secrets.split(','),
    use = req.address && address.use != null ? addresses.parts(Number(address.use)) : undefined;
  const label = req.address && address.use == null && address.save != null ? String(address.save) : null;
  if (use === null) return [400, 'That saved address is gone: pick another, or type it.', { refused: {} }];
  const labelRefused = label === null ? null : addresses.refusal(label);
  if (labelRefused) return [400, labelRefused, { refused: {} }];
  if (use) secrets = Object.fromEntries(names.map((n, i) => [n, use[i]]));
  const saveOutcome = saveSecrets(names, secrets);
  if (typeof saveOutcome === 'string') return [400, saveOutcome, { refused: {} }];
  const { saved, refused } = saveOutcome,
    missing = names.filter(n => !stored([n]).length),
    refusedNames = Object.keys(refused);
  if (saved.length) {
    scrub();
    // The current status uses the newly saved keys too
    for (const current of status.values()) {
      current.task = redact(current.task);
      if (current.jobs) current.jobs = current.jobs.map(redactJob);
    }
  }
  // some keys still to come, or refused (each with why, for the desk phone): the
  // request stays on the desk phone with what's saved
  if (missing.length || refusedNames.length) {
    if (saved.length) {
      db.prepare('update requests set answer = ? where id = ?').run(
        `Saved so far: ${stored(names).join(', ')}.`,
        req.id,
      );
      publish({
        type: 'log',
        agent: req.agent ?? roles().process,
        text: `The board saved ${saved.join(', ')} for request #${req.id}; still to come: ${missing.join(', ') || 'none (a replacement was refused)'}.`,
      });
    }
    return refusedNames.length
      ? [400, `Not saved: ${refusedNames.join(', ')}.`, { refused, missing }]
      : { ok: true, missing };
  }
  // all of a credential grant's keys: saving them is the board's yes (approvals.ts), recorded here only
  const grant = req.kind === 'credential' && !req.approves ? approvals.credentialGrant(names) : null;
  if (grant) approvals.record(grant, req.id);
  if (label !== null) addresses.save(label, names.map(secret));
  return `Saved on the server: ${names.join(', ')}. ${
    grant ? approvals.credential(grant)!.saved : 'Jobs get the test keys as environment variables (without _TEST_).'
  }`;
}

// The lines a card's photo, zip and document fields add to its answer, or the status refusing it while one it requires
// hasn't come
function filesAnswered(req: any, answer: string) {
  if (req.photos) {
    // every required photo first; the agent's answer says how many came and how to fetch them
    const line = photos.answerLine(req.id, req.photos);
    if (typeof line === 'number') return line;
    answer = withLine(answer, line);
  }
  // every required zip imported
  if (req.zips) {
    const line = zips.answerLine(req.id, req.zips);
    if (typeof line === 'number') return line;
    answer = withLine(answer, line);
  }
  // every required file, then each filed as mail: last, since filing can't be undone
  if (req.documents) {
    const line = documents.fileAll(req.id, req.title, req.documents);
    if (typeof line === 'number') return line;
    answer = withLine(answer, line);
  }
  return answer;
}

// The card leaves the desk phone answered, with its questions' answers and the pictures sent with it
function answerRecorded(req: any, answer: string, asked: Asked[] | null, pictureIds: number[]) {
  db.prepare("update requests set status = 'answered', answer = ?, answered = ? where id = ?").run(
    answer,
    new Date().toISOString(),
    req.id,
  );
  visualapproval.answered(req.id, asked, answer);
  // the board's decision this card asks (decisions.ts): what waits for it goes on
  db.prepare('update decisions set answered = ? where request = ? and answered is null').run(
    new Date().toISOString(),
    req.id,
  );
  if (asked) db.prepare('update requests set questions = ? where id = ?').run(JSON.stringify(asked), req.id);
  pictures.answered(pictureIds);
  bookReadsAgain(req);
}

// Who hears the answer: the asker, the jobs waiting for the card, the panel, or a parked job resuming
function answerHeard(req: any, answer: string, gotIt: boolean) {
  if (decisions.mergeCard(req.id)) {
    void visualDecided(req.id).catch(err => console.error('Could not resume visual merges:', err));
    return;
  }
  const id = req.id;
  // the asking job may read the answer itself (hq wait), whether or not tell() runs; the intercom's chat job hears it as a
  // chat line (tell())
  const panel = req.kind === 'review' && !!req.pr;
  if (panel)
    boardDecided(req.pr, answer).catch(err => console.error("Could not act on the board's review decision:", err));
  // A pull request's review card is the coordinator's own: the panel acts on it. Every other one is heard (a review card
  // without a pull request is an agent's, filed before 27 Sep 2026, when agents still could), but a guest card answered
  // without a word (its Done: guests.ts), which is nothing to hear. A tool's card has no asker to tell: its tool hears the
  // tap. A card about products is heard by each product's owner too (owed.ts).
  // (a deadline's line, kind late, taken without a word likewise, and a notice's Got it: gotIt above)
  // The jobs waiting for the card read the answer when they start (tellWaiting). When the asker no longer hears it, the
  // first of them (heir) hears it in its place, and no new job is made for it. The products' lines go to the job that
  // hears it, and each other waiting job reads which job brings each product back.
  const waitingLine = `The board answered card #${id} ("${req.title}"), which this job waited for, on its desk phone: ${answer}`;
  if (
    !req.secrets &&
    !panel &&
    !gotIt &&
    (answer || !['guest', 'late'].includes(req.kind)) &&
    !approvals.toolKind(req.kind)
  ) {
    const heir = askerHears(req) ? undefined : waitingFor(id)[0];
    const heard = owed.answered(req, answer, heir, (extra, others) => {
      tellWaiting(id, waitingLine, job => (job === heir ? extra : others));
      return tell(req, `The board answered your request #${id} ("${req.title}") on its desk phone: ${answer}${extra}`, {
        audience: true,
        waiting: heir,
      });
    });
    if (heard) db.prepare('update requests set heard_by = ? where id = ?').run(heard, id);
  }
  // A key request's answer (which keys were saved) makes no job, nor does a notice's Got it, but a job parked on it would
  // wait for good, like one on a closed request (endParked): it resumes with the answer.
  else if (req.secrets || gotIt) {
    tellWaiting(id, waitingLine);
    db.prepare(
      "update jobs set status = 'queued', not_before = 0, note = ? where id = ? and status = 'blocked' and request = ? and kind = 'work'",
    ).run(
      `The board answered your request #${id} ("${req.title}") on its desk phone: ${answer}\n\n${AUDIENCE}`,
      req.job,
      id,
    );
  }
}

// Whether the job that filed a card hears its answer itself: the intercom's chat, or a job parked on it or still running
// (tell()).
function askerHears(req: { id: number; job: number | null }) {
  const asker = req.job
    ? (db.prepare('select status, kind, request from jobs where id = ?').get(req.job) as
        { status: string; kind: string; request: number | null } | undefined)
    : undefined;
  return (
    asker?.kind === 'chat' || asker?.status === 'running' || (asker?.status === 'blocked' && asker.request === req.id)
  );
}

// The board talked a request through on a call (call.ts, ledger.ts): the job that hears it is the call's follow-up. An
// open request stays on the desk phone until the agent closes it (hq close); it can be answered by now, since the board
// may fill in its card during the call (a key request's keys).
export function discussRequest(id: number, brief: string, call: number) {
  const req = db.prepare('select * from requests where id = ?').get(id) as any;
  if (!req) return 404;
  const where =
    req.status === 'open'
      ? `The request stays on the board's desk phone: close it with \`hq close ${id}\` once it's dealt with (or when you file a new one in its place).`
      : `The request is no longer on the board's desk phone (${req.status}): \`hq history '#${id}'\` says what became of it.`;
  const job = tell(
    req,
    `The board called you about your desk phone request #${id} ("${req.title}"). ${where}\n\n${brief}`,
    { call },
  );
  return { ok: true, job };
}

// A parked job resumes with the answer as its next turn, which reads like the board talking in the session: it isn't.
export const AUDIENCE =
  "The board isn't in this session: it answered on the desk phone and has moved on, and nobody reads your messages here live. They go to the job's log, so write them as a report on the work, not as a reply to the board. If something needs the board's judgment, file it with hq ask or hq request; thanks, acknowledgements and \"we're on it\" go nowhere.";

// After a call, the board reads a reply kept as short as the intercom's, in the little Markdown HQ shows as such. A work
// follow-up sets it (hq reply, ledger.ts reply), and its last message is its report for the log (WORK_REPORT); the
// intercom's turn that follows up a call about its own card replies with its final message (tell(), chat.answered()).
export const SHORT_NOTES =
  'Write it for the board, at most about 80 words, like a reply in the intercom: lead with what was decided, then anything still open for the board (a decision or an answer it owes). No list of queued or running work: the board\'s projects view shows it. A time only for something the board asked about, said plainly ("this evening"). No job, item, pull request or card numbers: name the person instead. Never what the board said told back to it. Emojis are welcome. For example: "The store link goes to the top of every page, and Ada has it. Still yours: whether the shop opens Friday. 👍"';
export const WORK_REPORT =
  "Your last message is this job's report for the log, never the board's: the items, records, checks and numbers go there.";
export const callNotesAsk = () =>
  `Set what the board reads about this call (${names().os} → Calls) with \`hq reply "..."\` before this job ends (the call isn't followed up without it): what you took from it. ${SHORT_NOTES} ${WORK_REPORT}`;
// A card the CEO's intercom filed: a call about it is heard in the chat (tell()).
export const askedInIntercom = (request: number) =>
  !!db.prepare("select 1 from requests r join jobs j on j.id = r.job where r.id = ? and j.kind = 'chat'").get(request);

// Somebody has to hear it: the job that asked, if it's parked waiting, or else a new job for the agent who asked.
// A running job reads the board's answer itself with hq wait, but a call isn't an answer (hq wait never returns it),
// so a call about the request always reaches a job: that job is the call's follow-up (ledger.ts). Returns the job
// that hears it. The CEO's intercom never runs hq wait: a request its chat job made is heard in the chat (chat.hear), by
// the latest chat job in whatever state, with the conversation, and a failed turn doesn't lose it.
// waiting: a job waiting for the card that read the answer already (tellWaiting), so an asker that has ended needs no new
// job.
function tell(
  req: { id: number; agent: string | null; job: number | null; title: string },
  note: string,
  o: { call?: number; audience?: boolean; waiting?: number } = {},
) {
  // (a job parked on another request since isn't this one's to resume: the call becomes a job of its own)
  const job = req.job
    ? (db.prepare('select id, status, kind, request from jobs where id = ?').get(req.job) as
        { id: number; status: string; kind: string; request: number | null } | undefined)
    : undefined;
  if (job && isIntercom(job)) {
    // (an intercom turn's reply goes to the board: no AUDIENCE line; a quick run's not)
    return hear(
      note,
      o.call
        ? `Call with ${findAgent(ceo())?.name ?? 'the CEO'} · about request #${req.id}`
        : `Answered request #${req.id} on the desk phone`,
      o.call,
    );
  }
  if (o.audience) note = `${note}\n\n${AUDIENCE}`;
  if (job?.status === 'blocked' && job.request === req.id) {
    db.prepare(
      "update jobs set status = 'queued', not_before = 0, note = ?, call = coalesce(?, call), answers = ? where id = ?",
    ).run(note, o.call ?? null, req.id, req.job);
    return req.job!;
  } else if (o.waiting) {
    return o.waiting;
  } else if ((job?.status !== 'running' || o.call) && req.agent) {
    const running =
      job?.status === 'running'
        ? `\n\nYour job #${req.job}, which asked, is still running and doesn't hear this call: this job is where it lands.`
        : '';
    //
    // (on the asking job's thread, so its latest start is that thread's: planner.ts backward)
    const answering = createJob({
      agent: req.agent,
      code: codeOf(req.job ?? null) ?? undefined, // (the asking task's code.)
      title: `The board on: ${req.title}`.slice(0, 140),
      call: o.call,
      from: req.job ?? undefined,
      prompt: `${note}${running}\n\nAct on what the board decided, and pass changes on to whoever owns them.`,
    }).id;
    // (the board's word: a pause lets it through, PAUSE_LETS)
    db.prepare('update jobs set answers = ? where id = ?').run(req.id, answering);
    return answering;
  }
  return req.job ?? undefined;
}

// The cards an agent files itself, the only ones hq close and hq rewrite touch: not the coordinator's own (a pull request's
// review card, a seat's sign-in, a guest card, an email card, a gated tool's card: agentRequest in server.ts refuses to file those too).
// (an email card's drafter withdraws its open draft with hq close all the same: outbox.withdraw)
// (a rewritten sign-in card's link is the desk phone's "Open the sign-in page" button)
export const cardKind = (id: number) =>
  (db.prepare('select kind from requests where id = ?').get(id) as { kind: string } | undefined)?.kind;
export const agentCard = (id: number) => {
  const kind = cardKind(id);
  return !!kind && !['review', 'login', 'guest', 'mail', 'call', 'late'].includes(kind) && !approvals.toolKind(kind); // (mail: outbox.ts, late: reserved for HQ; call: callouts.ts)
};

// An agent rewrites its own open request (hq rewrite); the CEO may rewrite any an agent filed, to keep the desk phone short.
// team: a team member's own request is the one its job filed (its name may be another job's member's too).
export function rewriteRequest(id: number, agent: string, body: string, from?: number, team = false) {
  if (!body.trim() || body.length > 20_000) return 400;
  if (!agentCard(id)) return 404;
  const theirs = db
    .prepare(`select 1 from requests where id = ? and status = 'open' and (agent = ? or ? = ?) and (? = 0 or job = ?)`)
    .get(id, agent, team ? '' : agent, ceo(), team ? 1 : 0, from ?? 0);
  if (!theirs) return 404;
  newBody(id, body.trim());
  return { ok: true };
}
// hq topic: an agent sets or changes the topic of an open card it filed, of any kind (an email draft's or a guest's too).
// The CEO can, on any open card. The card doesn't come back as new, as its words are the same. team: as rewriteRequest.
// The reply is the topic as stored. A credential in it is redacted by then (db.ts), so it's never echoed back.
export function setTopic(id: number, agent: string, topic: unknown, from?: number, team = false) {
  const t = topicOf(topic);
  if (!t.ok || !t.topic) return 400;
  const r = db
    .prepare(
      `update requests set topic = ? where id = ? and status = 'open' and (agent = ? or ? = ?) and (? = 0 or job = ?)`,
    )
    .run(t.topic, id, agent, team ? '' : agent, ceo(), team ? 1 : 0, from ?? 0);
  if (!r.changes) return 404;
  return {
    ok: true,
    topic: (db.prepare('select topic from requests where id = ?').get(id) as { topic: string }).topic,
  };
}
// An open card whose text changes (hq rewrite) comes back as a new one: first on the desk phone,
// unread in HQ, and ringing the board's devices as a new card would. The same text again changes nothing. A card for later
// stays silent: it rings, if it's urgent, when it shows (later.ts).
function newBody(id: number, body: string) {
  const now = new Date().toISOString();
  const r = db
    .prepare(
      'update requests set body = ?, changed = ? where id = ? and body != ? returning kind, title, urgency, approves, hidden_until',
    )
    .get(body, now, id, body) as
    { kind: string; title: string; urgency: string; approves: string | null; hidden_until: string | null } | undefined;
  if (r && !later.heldFor(id) && !later.isHidden(r.hidden_until, now))
    announceRequest({
      id,
      kind: r.kind,
      title: r.title,
      urgency: r.urgency,
      grant: r.approves ? approvals.describe(r.approves) : undefined,
    });
}

// An agent takes its own request off the desk phone (hq close). A job parked on it now waits for nothing: it ends (endParked).
// job: a team member's, only the request its own job filed
export function closeRequest(id: number, agent: string, job?: number) {
  const r = db
    .prepare(
      "update requests set status = 'done', answered = ? where id = ? and agent = ? and status = 'open' and (? is null or job = ?)",
    )
    .run(new Date().toISOString(), id, agent, job ?? null, job ?? null);
  if (!r.changes) return 404;
  bookReadsAgain(
    db.prepare('select agent, note, page from requests where id = ?').get(id) as Parameters<typeof bookReadsAgain>[0],
  );
  owed.withdrawn(id); // a --back card taken off before the board saw it brought nothing back
  endParked(id, `its request #${id} was closed by ${agent}`);
  unanswered(id, `${agent} closed it`);
  return { ok: true };
}

// HQ ends a card whose matter ended by itself (watch.ts): an open one leaves the desk phone as HQ's doing, and an answered
// one keeps the board's answer as it was. closing: HQ's line about it, kept apart from the answer.
export function endRequest(id: number, closing: string) {
  const req = db.prepare('select status, agent, note, page from requests where id = ?').get(id) as
    { status: string; agent: string | null; note: number | null; page: string | null } | undefined;
  if (!req) return 404;
  db.prepare('update requests set closing = ? where id = ?').run(closing, id);
  if (req.status !== 'open') return { ok: true };
  db.prepare("update requests set status = 'done', answered = ? where id = ?").run(new Date().toISOString(), id);
  bookReadsAgain(req);
  owed.withdrawn(id);
  endParked(id, `HQ took its request #${id} off the desk phone`);
  unanswered(id, closing);
  return { ok: true };
}

// A card that left the desk phone without an answer releases the jobs waiting for it (READY), and each reads why. The
// step that waited may still need the answer: then it asks for it itself, parked, since nothing comes before it.
function unanswered(request: number, why: string) {
  const { title } = db.prepare('select title from requests where id = ?').get(request) as { title: string };
  tellWaiting(
    request,
    `Card #${request} ("${title}"), which this job waited for, left the board's desk phone without an ` +
      `answer: ${why}. Check whether what it asked for came about another way. If this job still needs the board's answer, ` +
      'ask for it with hq request, which parks the job until it comes.',
  );
}

// The jobs waiting for a card (db.ts request_waits) that haven't started: the end of each one's prompt takes the card's
// answer, or why it left the desk phone without one, and then what extraFor gives that job.
function tellWaiting(request: number, line: string, extraFor: (job: number) => string = () => '') {
  const append = db.prepare('update jobs set prompt = prompt || ? where id = ?');
  for (const job of waitingFor(request)) append.run(`\n\n${line}${extraFor(job)}`, job);
}
const waitingFor = (request: number) =>
  (
    db
      .prepare(
        `select w.job from request_waits w join jobs j on j.id = w.job
  where w.request = ? and j.status = 'queued' and j.session is null order by w.job`,
      )
      .all(request) as { job: number }[]
  ).map(w => w.job);

// A job parked on a request (hq request) is woken only by its answer (tell()). A request taken off the desk phone without
// one (hq close: moot, or filed again) would leave it waiting for the board for good, in every open-jobs list, and holding
// every job queued --after it. It ends cancelled, which releases those as hq cancel does (READY), with the
// reason on its agent's feed. Not the intercom's chat job: the board's next line resumes it (chat.ts say()). (The only
// other way a request is done: the login flow, after its answer, and a seat's sign-in has no job.)
function endParked(request: number, why: string) {
  for (const { id } of db
    .prepare("select id from jobs where status = 'blocked' and request = ? and kind = 'work'")
    .all(request) as { id: number }[]) {
    db.prepare(
      "update jobs set status = 'cancelled', seat = null, result = ?, finished = ?, note = null where id = ?",
    ).run(`Cancelled: ${why}`, new Date().toISOString(), id);
    cancelled(id, why);
    jobEnded(id); // colleagues' messages it never read become jobs
  }
}
// Credential cards from before key fields took a key in a plain answer box: what was typed there leaves the table, so
// every stored answer can be shown and passed on as it is, and such a card still open leaves the desk phone as endRequest
// ends one (its parked asker cancelled, the jobs waiting on it told why). At the server's start (server.ts), once every
// module endRequest reaches is loaded.
export function liftPlainKeyCards() {
  once('2026-10-20-plain-key-cards', () => {
    const plainKeyCard = "kind = 'credential' and coalesce(secrets, '') = ''";
    db.prepare(`update requests set answer = ? where ${plainKeyCard} and answer is not null`).run(
      "The board answered on its desk phone. A key may be in its answer, so it isn't passed on: ask again for the keys by name (they go in the card's key fields).",
    );
    const openCards = db.prepare(`select id from requests where ${plainKeyCard} and status = 'open'`);
    const open = openCards.all() as { id: number }[];
    for (const { id } of open) endRequest(id, "Keys go in a card's key fields now: ask again for them by name.");
  });
}
// Agents read the answers to their own job's requests only.
// hq photos: a request's photos are for the agent who asked, or whose job asked (a team member asks under its own name).
// hq requests [id]: what's on the board's desk phone, every card whole (from requestRows, its Share part included). A
// customer card (customerCard: a tool wrote one customer's details in it) shows its text only to the job working on it
// (readsCard), which holds those details from then on (handedCustomerData). Anyone else gets its title, which is no
// secret, and why the text is left out.
// A card for later says until when (hidden_until, still ahead), a held one for what work (held).
export const openRequests = (me: Reader, id?: number) =>
  requestRows('open', true)
    .filter(r => !id || r.id === id)
    .map(r => {
      const shown = {
        id: r.id,
        agent: r.agent,
        kind: r.kind,
        urgency: r.urgency,
        title: r.title,
        keys: r.secrets,
        topic: r.topic,
        ...(later.isHidden(r.hidden_until) ? { hidden_until: r.hidden_until } : {}),
        ...(later.heldFor(r.id) ? { held: later.heldFor(r.id) } : {}),
      };
      const asked = r.questions ? { questions: r.questions } : {};
      if (!r.customers) return { ...shown, body: r.body, ...asked };
      if (!readsCard(r.id, me)) return { ...shown, body: null, left_out: CARD_REFUSED };
      readerHanded(me);
      return { ...shown, body: r.body, ...asked };
    });

export const askedBy = (id: number, agent: string) =>
  !!db
    .prepare(
      `select 1 from requests r left join jobs j on j.id = r.job
  where r.id = ? and (r.agent = ? or j.agent = ?)`,
    )
    .get(id, agent, agent);

// hq wait (a held card's answer is refused: later.ts waitProblem)
export function requestAnswer(id: number, job: number) {
  const r = db.prepare('select status, answer from requests where id = ? and job = ?').get(id, job) as
    { status: string; answer: string | null } | undefined;
  const held = r && later.waitProblem(id);
  if (held) return [409, held] as const;
  // a card about products: whose job brings each back (owed.ts).
  return r ? { status: r.status, answer: r.answer === null ? null : r.answer + owed.told(id) } : 404;
}
