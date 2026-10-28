// Each thread's outlook from the forecast (forecast.ts) as the projects view, hq projects and hq thread read it: its ETA
// and planned finish against its window (windows.ts) with the slack it has, the agent time its open work has left, what
// it waits on and the chain of jobs that sets its finish.
// (its messages say deliverable, the board's word for a thread)
import { db } from './db.ts';
import { findThread, ownerOf, type Thread } from './projects.ts';
import { findAgent, findJob, isOpenJob, nameOf } from './jobs.ts';
import { codeOf } from './jobcodes.ts';
import { standing, undrawnWords, type Forecast, type ThreadOutlook } from './forecast.ts';
import type { QueuedJob, Wait } from './eta.ts';
import { DAY_MS, HORIZON_DAYS } from './simulation.ts';
import { companyTime } from './company.ts';
import { alike, scores, wordsOf } from './matching.ts';
import { readyOf } from './threadjudge.ts';

// A thread's outlook: its two numbers, its planned finish against its window and the slack that leaves, where it stands
// (forecast.ts standing), what it waits on, the chain that sets its finish, and why it has none (stall), with the time
// its work is booked to start when that's past the play's horizon (booked). None while it has no open work.
export function outlookOf(id: string, f: Forecast) {
  const o = f.threads.get(id);
  if (!o) return null;
  const booked = o.eta === null ? bookedOf(o, f) : null;
  return {
    ...{ eta: o.eta, finish: o.finish, deadline: o.deadline, aim: o.aim, slack: o.slack, standing: standing(o) },
    ...{ held: o.held, left_ms: o.left_ms, waits: o.waits, cards: o.cards, chain: o.chain, next: o.next, jobs: o.jobs },
    stall: o.eta === null ? stallOf(o, booked) : null,
    booked,
  };
}

// The time a thread without an ETA has work booked to start past the play's horizon (bookedStart): the latest such
// start among its own jobs and the chain that sets its finish, which the play can't reach, so it's what holds the
// thread. Null when none is, or something else (a stall, a missing task) holds it.
function bookedOf(o: ThreadOutlook, f: Forecast) {
  if (o.undrawn.length || o.chain.some(l => l.causes.some(w => w.on === 'stalled'))) return null;
  const ids = new Set([...o.jobs, ...o.chain.map(l => l.job)]);
  const starts = f.snapshot.jobs.flatMap(j => (ids.has(j.id) ? (bookedStart(j, f) ?? []) : []));
  return starts.length ? Math.max(...starts) : null;
}

// When a job is booked to start (hq job --when a time: its time wakes, or its not_before where that's later), when
// that's past the play's horizon; null otherwise. A not_before alone (a retry's or a usage limit's wait) is no booking.
function bookedStart(j: QueuedJob, f: Forecast) {
  const at = j.wakes.flatMap(w => ('at' in w && !w.deploy ? [w.at] : []));
  if (!at.length) return null;
  const start = Math.max(j.notBefore, ...at);
  return start > f.snapshot.now + HORIZON_DAYS * DAY_MS ? start : null;
}

// What stops a thread without an ETA: no task drawn while a window is at stake, a
// stall the play sees, work booked to start past its horizon, or nothing merging within it.
function stallOf(o: ThreadOutlook, booked: number | null) {
  const undrawn = undrawnWords(o);
  if (undrawn) return undrawn;
  const stalled = o.chain.flatMap(l => l.causes).find(w => w.on === 'stalled') as
    Extract<Wait, { on: 'stalled' }> | undefined;
  if (stalled) return stalled.why;
  const days = (o.waits.find(w => w.on === 'horizon') as Extract<Wait, { on: 'horizon' }> | undefined)?.days;
  if (booked !== null)
    return `booked to start ${companyTime(booked)}, past the ${days ?? HORIZON_DAYS} days the queue's play looks ahead`;
  return `nothing in the queue's play lets it merge within ${days ?? HORIZON_DAYS} days`;
}

// GET /api/projects with each thread's outlook (projects.ts listProjectBoard gives the rest).
// Each open job of a thread carries its estimate: its agent time as sized and what the play has left of it, and when it
// starts, is done and merges in the play, and its finish: its work live, as a thread's finish is its last job's (each
// null where the play has none, as for a review run), and for one the play has no start for, when it's booked to start
// past the play's horizon (bookedStart).
// (start and done; left_ms and finish)
type BoardJob = { id: number; status: string };
export function withOutlooks<B extends { projects: { threads: { id: string; jobs: BoardJob[] }[] }[] }>(
  board: B,
  f: Forecast,
) {
  const estimated = (job: BoardJob) => (isOpenJob(job) ? { ...job, estimate: estimateOf(job.id, f) } : job);
  return {
    ...board,
    projects: board.projects.map(p => ({
      ...p,
      threads: p.threads.map(t => ({
        ...t,
        jobs: t.jobs.map(estimated),
        outlook: outlookOf(t.id, f),
      })),
    })),
  };
}

const estimateOf = (job: number, f: Forecast) => {
  const played = f.usual.get(job),
    row = f.snapshot.jobs.find(j => j.id === job);
  return {
    size_ms: f.sizes.usual.get(job)?.agent_ms ?? null,
    left_ms: played?.left_ms ?? null,
    start: played?.start ?? null,
    done: played?.done ?? null,
    merged: played?.merged ?? null,
    finish: played?.merged == null ? null : played.merged + f.snapshot.deployLagMs,
    booked: played?.start == null && row ? bookedStart(row, f) : null,
  };
};

// hq projects: every open thread, by project, with its owner (its project's), its
// outlook, the job that goes on next, and whether it's ready to judge (threadjudge.ts).
export function lines(f: Forecast) {
  const threads = db
    .prepare(
      "select id, project, name, goal, status, judge from threads where status = 'open' order by project, created",
    )
    .all() as Pick<Thread, 'id' | 'project' | 'name' | 'goal' | 'status' | 'judge'>[];
  return threads.map(t => {
    const outlook = outlookOf(t.id, f);
    const next = outlook?.next == null ? null : jobLine(outlook.next, f);
    return { ...t, owner: ownerOf(t), outlook, next, ready: readyOf(t) };
  });
}

// hq thread <id>: the thread, its outlook, and each of its open work jobs by its name (nameOf) with its size, what it has
// left, when it starts and merges in the play, and what it waits on.
export function detail(id: string, f: Forecast) {
  const t = findThread(id);
  if (!t) return undefined;
  // (a moved thread found by its old id: its new one)
  const outlook = outlookOf(t.id, f);
  const jobs = (outlook?.jobs ?? []).map(job => jobLine(job, f));
  return { ...t, owner: ownerOf(t), outlook, jobs, ready: readyOf(t) };
}

function jobLine(id: number, f: Forecast) {
  const job = f.snapshot.jobs.find(j => j.id === id)!;
  const o = f.usual.get(id)!;
  // (a thread's placeholder has no row, so no code: threadorder.ts placeholders)
  const code = job.placeholder ? null : codeOf(id);
  return {
    ...{ id, code, agent: job.agent, title: nameOf(job), status: job.status, pr: job.review?.pr ?? job.pr },
    ...{ size_ms: f.sizes.usual.get(id)?.agent_ms ?? null, left_ms: o.left_ms, start: o.start, merged: o.merged },
    waits: o.waits,
  };
}

// The call's eta tool and hq projects <words>: the open threads a project's or a thread's name or a few words find, each
// with its outlook as hq thread reads it and what it waits on by name: work by its title, agent and thread, a card by its
// title. A question that says a project's or thread's whole name or id, word for word, finds that thread, or that
// project with all its open threads; its other words find the threads sharing the most of them, a rare word weighing
// more than a common one, and each thread that alone has one of them (pickedOut). Words are matching.ts's (wordsOf,
// alike), less one-letter fragments such as the 's' of "What's" (a digit stays: it tells Milestone 2 from Milestone 3).
// Fast enough for a live call: the forecast as last played, nothing played for the asking.
type MatchedThread = { id: string; project: string; name: string; project_name: string };
const wordsIn = (text: string) => wordsOf(text).filter(w => w.length > 1 || /\p{N}/u.test(w));
export function findOutlooks(words: string, f: Forecast) {
  const asked = wordsIn(words);
  if (!asked.length) return [400, 'say which project or deliverable: its name or a few words'] as const;
  const threads = db
    .prepare(
      `select t.id, t.project, t.name, p.name as project_name from threads t left join projects p on p.id = t.project
      where t.status = 'open' order by t.project, t.created`,
    )
    .all() as MatchedThread[];
  // The positions in asked of a name said in full, word for word, each time it's said (none where it isn't said)
  const saidAt = (name: string) => {
    const own = wordsIn(name);
    if (!own.length) return [];
    return asked.flatMap((_, i) => (own.every((w, k) => asked[i + k] === w) ? own.map((_, k) => i + k) : []));
  };
  const saidPositions = threads.map(t => [t.project, t.project_name, t.id, t.name].flatMap(saidAt));
  const taken = new Set(saidPositions.flat());
  const picked = new Set(pickedOut(threads, [...new Set(asked.filter((_, i) => !taken.has(i)))]));
  const found = threads.filter((t, i) => picked.has(t) || saidPositions[i].length > 0);
  const projectsOf = new Map<string, { id: string; name: string; owner: string; threads: unknown[] }>();
  for (const t of found) {
    const name = t.project_name;
    const project = projectsOf.get(t.project) ?? { id: t.project, name, owner: agentName(ownerOf(t)), threads: [] };
    projectsOf.set(t.project, project);
    const outlook = outlookOf(t.id, f);
    const next = outlook?.next == null ? null : namedJob(outlook.next, f);
    const waits = (outlook?.waits ?? []).map(w => namedWait(w, f));
    project.threads.push({
      id: t.id,
      name: t.name,
      owner: project.owner,
      outlook: outlook && { ...outlook, waits },
      next,
    });
  }
  // (none found: the open projects by name, for another try)
  const known = [...new Set(threads.map(t => t.project_name))];
  return { projects: [...projectsOf.values()], known: projectsOf.size ? [] : known };
}

// The threads the words pick out, by their project's id and name and their own: those sharing the most of the words, as
// matching.ts scores past jobs' titles, and beside them each thread that alone has one of the words, so a word that
// finds one thing isn't lost to a thread sharing more (none sharing any)
function pickedOut(threads: MatchedThread[], words: string[]) {
  const owns = threads.map(t => wordsIn(`${t.project} ${t.project_name} ${t.id} ${t.name}`));
  const threadScores = scores(owns, words);
  const best = Math.max(0, ...threadScores);
  const holders = words.map(w => owns.flatMap((own, i) => (own.some(o => alike(o, w)) ? [i] : [])));
  const alone = new Set(holders.filter(threadIndexes => threadIndexes.length === 1).flat());
  return threads.filter((_, i) => (best > 0 && threadScores[i] === best) || alone.has(i));
}

function namedWait(w: Wait & { thread?: string | null }, f: Forecast) {
  if (w.on === 'job') return { ...w, ...namedJob(w.job, f) };
  if (w.on !== 'board' || !w.request) return w;
  const card = db.prepare('select title from requests where id = ?').get(w.request) as { title: string } | undefined;
  return { ...w, title: card!.title };
}

// A job by its title (none for a thread's placeholder: its thread's first task, still to draw), its agent's name, its
// status and its thread's name: from the play, or its row for one the play no longer holds (done, failed)
type NamedJob = { agent: string; title: string; step?: string | null; round?: number | null; status: string };
function namedJob(id: number, f: Forecast) {
  const job = (f.snapshot.jobs.find(j => j.id === id) ?? findJob(id)!) as NamedJob & {
    placeholder?: boolean;
    thread?: string | null;
  };
  const title = job.placeholder ? null : nameOf(job);
  return {
    title,
    agent: agentName(job.agent),
    status: job.status,
    thread_name: job.thread ? findThread(job.thread)!.name : null,
  };
}

const agentName = (id: string) => String(findAgent(id)!.name);
