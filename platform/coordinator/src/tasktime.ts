// Whole-task agent time, read from the run ledger and the recorded review relationships.
import { db } from './db.ts';
import { workBranch, type Named } from './jobs.ts';
import { REBUILT_RUN, INVALID_RUN } from './timing.ts';

export type Phase = 'work' | 'reviews' | 'fixes' | 'syncs' | 'previews';
type Member = Named & {
  id: number;
  kind: string;
  stage: string | null;
  round: number | null;
  branch: string;
  status: string;
  created: string;
  finished: string | null;
  fix: number;
  preview: number;
};
export type TaskTimingFlag =
  'missing_runs' | 'open_runs' | 'invalid_time' | 'rebuilt' | 'missing_merge_time' | 'unattributed_previews';
export type Allocation = 'equal_task_share' | 'followup';
export type TaskTime = {
  agent_minutes: number;
  split: Record<Phase, number>;
  complete: boolean;
  flags: TaskTimingFlag[];
  allocation: Allocation;
  tasks: number[];
  share: number;
};
type Contribution = { phase: Phase; attributed_ms: number; flags: TaskTimingFlag[] };
type PullRequest = { number: number; status: string; merged_at: string | null };
type Family = { members: Member[]; prs: PullRequest[] };
type WindowJob = Pick<Member, 'id' | 'created' | 'finished'>;
type Window = { from: number; until: number };
const phases = (): Record<Phase, number> => ({ work: 0, reviews: 0, fixes: 0, syncs: 0, previews: 0 });

export type TimedTask = { id: number; created: string; finished: string };
export function taskTimes(asOf = Infinity) {
  const families = new Map<string, Family>();
  const getFamily = (branch: string) => {
    if (!families.has(branch)) families.set(branch, readFamily(branch));
    return families.get(branch)!;
  };
  return (job: TimedTask) => measureTask(job, getFamily, asOf);
}

function measureTask(job: TimedTask, getFamily: (branch: string) => Family, asOf: number): TaskTime {
  const branch = db.prepare(`select ${workBranch('j')} branch from jobs j where id = ?`).get(job.id) as {
    branch: string;
  };
  const family = getFamily(branch.branch);
  const { last, from, until, landed } = boundaries(job, family.prs, asOf);
  const tasks = tasksInWindow(family.members, { from, until });
  const sharesRounds = tasks.some(member => member.id === job.id);
  const count = sharesRounds ? tasks.length : 1;
  const contributions = new Map<number, Contribution>();
  const window = { from: sharesRounds ? from : Math.max(from, Date.parse(job.created)), until };
  collect({
    job,
    branch: branch.branch,
    family,
    root: true,
    phase: 'work',
    share: 1 / count,
    window,
    getFamily,
    contributions,
    visited: new Set(),
  });
  const split = phases();
  for (const entry of contributions.values()) split[entry.phase] += entry.attributed_ms;
  const flags = [...new Set([...contributions.values()].flatMap(entry => entry.flags))];
  if (last?.status === 'merged' && !last.merged_at) flags.push('missing_merge_time');
  // Missing preview attribution is checked from this task's creation, not the shared round's earlier start.
  const previewWindow = { from: Math.max(window.from, Date.parse(job.created)), until };
  if (family.prs.length && unlinkedPreviews(previewWindow)) flags.push('unattributed_previews');
  const complete = (!last || landed) && !flags.length;
  return {
    agent_minutes: toMinutes(Object.values(split).reduce((sum, ms) => sum + ms, 0)),
    split: Object.fromEntries(Object.entries(split).map(([phase, ms]) => [phase, toMinutes(ms)])) as Record<
      Phase,
      number
    >,
    complete,
    flags,
    allocation: sharesRounds ? 'equal_task_share' : 'followup',
    tasks: tasks.map(task => task.id),
    share: 1 / count,
  };
}

function tasksInWindow(members: Member[], { from, until }: Window) {
  return members.filter(member => {
    const finished = finishedAt(member);
    return (
      isTask(member) && Date.parse(member.created) < until && finished !== null && finished > from && finished <= until
    );
  });
}

function boundaries(job: WindowJob, prs: PullRequest[], asOf = Infinity) {
  const finished = finishedAt(job) ?? Infinity;
  const landings = prs.filter(pr => pr.status === 'merged' && pr.merged_at && Date.parse(pr.merged_at) < asOf);
  const landing = landings.find(pr => Date.parse(pr.merged_at!) >= finished);
  const last = landing ?? prs.at(-1);
  const landed = landing !== undefined;
  const until = landing ? Date.parse(landing.merged_at!) : asOf;
  const before = landings.filter(pr => Date.parse(pr.merged_at!) < finished);
  const from = Math.max(...before.map(pr => Date.parse(pr.merged_at!)));
  return { last, from, until, landed };
}

type Context = {
  job: WindowJob;
  branch: string;
  family: Family;
  root: boolean;
  phase: Phase;
  share: number;
  window: Window;
  getFamily: (branch: string) => Family;
  contributions: Map<number, Contribution>;
  visited: Set<string>;
};
function collect(context: Context) {
  if (context.visited.has(context.branch)) return;
  context.visited.add(context.branch);
  for (const member of context.family.members) {
    const finished = finishedAt(member);
    if (Date.parse(member.created) >= context.window.until || (finished !== null && finished <= context.window.from))
      continue;
    const isRequestedJob = member.id === context.job.id;
    if (context.root && !isRequestedJob && isTask(member)) continue;
    const phase = memberPhase(member, isRequestedJob, context);
    if (member.fix && member.branch !== context.branch) {
      collectLinked(member, member.branch, context.share, phase, context);
      continue;
    }
    const share = context.root && isRequestedJob ? 1 : context.share;
    if (!context.contributions.has(member.id))
      context.contributions.set(member.id, measured(member, phase, share, context.window));
  }
  for (const preview of previews(context.family.prs)) {
    collectLinked(preview, preview.branch, context.share / preview.branches, 'previews', context);
  }
}

function collectLinked(job: WindowJob, branch: string, share: number, phase: Phase, parent: Context) {
  if (parent.visited.has(branch)) return;
  const family = parent.getFamily(branch);
  const bounds = boundaries(job, family.prs);
  const window = {
    from: Math.max(parent.window.from, bounds.from),
    until: Math.min(parent.window.until, bounds.until),
  };
  collect({ ...parent, job, branch, family, root: false, phase, share, window });
}

function memberPhase(member: Member, isRequestedJob: boolean, context: Context): Phase {
  if (context.root && isRequestedJob) return 'work';
  if (isReview(member)) return 'reviews';
  if (context.root) return phaseOf(member);
  return context.phase;
}

const finishedAt = (member: WindowJob): number | null =>
  member.finished === null ? null : Date.parse(member.finished);
const isReview = (member: Member) => member.kind === 'review' || member.kind === 'consolidate';

function readFamily(branch: string): Family {
  const prs = db
    .prepare('select number, status, merged_at from prs where branch = ? order by number')
    .all(branch) as PullRequest[];
  const members = db
    .prepare(
      `with candidates(id) as (
    select id from jobs j where j.kind = 'work' and ${workBranch('j')} = :branch
    union select id from jobs where branch = :branch
    union select j.id from prs p join jobs j on j.pr = p.number where p.branch = :branch
    union select f.job from prs p join review_fix_tasks f on f.pr = p.number where p.branch = :branch
  ) select j.id, j.agent, j.title, j.kind, j.stage, j.round, j.status, j.created, j.finished, ${workBranch('j')} branch,
    exists(select 1 from review_fix_tasks f where f.job = j.id) fix,
    exists(select 1 from card_jobs c where c.job = j.id) preview
    from candidates c join jobs j on j.id = c.id order by j.id`,
    )
    .all({ branch }) as Member[];
  return { members, prs };
}

export const isTask = (member: Pick<Member, 'kind' | 'status' | 'fix' | 'preview' | 'stage'>) =>
  member.kind === 'work' &&
  member.status !== 'cancelled' &&
  !member.fix &&
  !member.preview &&
  !['fix', 'feedback'].includes(member.stage ?? '');
function phaseOf(member: Member): Phase {
  if (isReview(member)) return 'reviews';
  if (member.fix || member.stage === 'feedback' || (member.stage === 'fix' && member.round !== null)) return 'fixes';
  if (member.stage === 'fix') return 'syncs';
  return 'work';
}

function measured(member: Member, phase: Phase, share: number, { from, until }: Window): Contribution {
  const runs = db
    .prepare(`select started, ended, ${REBUILT_RUN} rebuilt, ${INVALID_RUN} invalid_time from runs where job = ?`)
    .all(member.id) as {
    started: string;
    ended: string | null;
    rebuilt: number;
    invalid_time: number;
  }[];
  const flags: TaskTimingFlag[] = [];
  let agentMs = 0;
  if (!runs.length && member.status !== 'cancelled') flags.push('missing_runs');
  for (const run of runs) {
    if (Date.parse(run.started) >= until) continue;
    if (run.ended === null) {
      flags.push('open_runs');
      continue;
    }
    const start = Date.parse(run.started),
      end = Date.parse(run.ended);
    if (start >= until || end <= from) continue;
    if (run.invalid_time) {
      flags.push('invalid_time');
      continue;
    }
    agentMs += Math.max(0, Math.min(end, until) - Math.max(start, from));
    if (run.rebuilt) flags.push('rebuilt');
  }
  return {
    phase,
    attributed_ms: agentMs * share,
    flags: [...new Set(flags)],
  };
}

function previews(prs: PullRequest[]) {
  const numbers = JSON.stringify(prs.map(pr => pr.number));
  return db
    .prepare(
      `select distinct j.id, j.created, j.finished, ${workBranch('j')} branch,
    (select count(distinct p.branch) from card_merges held join prs p on p.number = held.pr where held.job = c.job) branches
    from card_merges m join card_jobs c on c.job = m.job join jobs j on j.id = c.job
    where m.pr in (select value from json_each(?))`,
    )
    .all(numbers) as (WindowJob & { branch: string; branches: number })[];
}

// Older cards can have lost their merge links. An overlapping run warns of missing attribution, without guessing it.
function unlinkedPreviews({ from, until }: Window) {
  const created = new Date(from).toISOString();
  return !!db
    .prepare(
      `select 1 from card_jobs c join runs r on r.job = c.job
    where not exists(select 1 from card_merges m where m.job = c.job)
    and julianday(r.ended) > julianday(?) and julianday(r.started) < julianday(?) limit 1`,
    )
    .get(created, Number.isFinite(until) ? new Date(until).toISOString() : '9999-12-31');
}
const toMinutes = (ms: number) => Math.round(ms / 600) / 100;
