// hq projects and hq thread <id>: each thread's live estimate from HQ's forecast (the coordinator's forecast.ts and
// outlooks.ts), in a few lines: its ETA, the agent time its open work has left, what it waits on, its planned finish
// against its window and the slack that leaves, and its jobs. Agents and the CEO read these instead of the status report.
import { when } from './when.ts';
import * as api from './api.ts';
import { lateLines, missWords } from './deadlines.ts';
import { at, duration, waitWords, type Wait } from './estimate.ts';
import { print, stop, text } from './output.ts';
import { liftWords, type Lift } from './pauses.ts';
// A job's code after its number, none for one without
const codeOf = (code: unknown) => (typeof code === 'string' && code ? ` ${code}` : '');

type ThreadWait = Wait & { thread?: string | null };
type Link = { job: number; agent: string; thread: string | null; status: string; causes: Wait[] };
type Outlook = {
  eta: number | null;
  finish: number | null;
  deadline: number | null;
  aim: number | null;
  slack: number | null;
  standing: 'misses' | 'gives' | 'holds' | null;
  held: number | null;
  left_ms: number;
  waits: ThreadWait[];
  chain: Link[];
  stall: string | null;
};
type Job = {
  id: number;
  code: string | null;
  agent: string;
  title: string;
  status: string;
  pr: number | null;
  size_ms: number | null;
  left_ms: number;
  start: number | null;
  merged: number | null;
  waits: Wait[];
};
// (ready: its work is in with nothing open, for its owner to judge: the coordinator's threadjudge.ts)
type Ready = { since: number | null; judge: number | null };
type Line = {
  id: string;
  name: string;
  owner: string;
  outlook: Outlook | null;
  next: Job | null;
  ready?: Ready | null;
};
type Detail = Line & {
  goal: string;
  status: string;
  jobs: Job[];
  pause?: (Lift & { target: string; why: string }) | null;
};

export const projectsHelp = `
   hq projects                                       every open thread in a line: its ETA, the agent time its open work
                                                     has left, what it waits on, its planned finish against its window
                                                     and the slack that leaves, and the job that goes on next (HQ's live
                                                     estimate, played on the queue as it is)
   hq projects [words] --extra-seat 5x|20x            the whole live plan before and after an added Claude Max seat,
                                                     all windows included, with capacity assumptions and confidence
   hq projects <words>                               the same for the threads a project's or thread's name or a few words
                                                     find ("The checkout"), by project, everything in names: what
                                                     the board hears on a call (its eta tool)`;
export const nowHelp = `
   hq now                                            what's going on right now: everyone HQ counts at work, each on its
                                                     run with its seat, thread and window and, while a hold is on, why
                                                     it runs; then each open desk phone card with the work that waits on
                                                     it (the call's eta tool with no query)`;
export const help = `
   hq thread <project>/<slug>                        one thread: its estimate and window, the chain of jobs that sets its
                                                     ETA, and each open job with its size, time left, start, merge and
                                                     waits`;

export async function projects(args: string[]) {
  if (args.includes('--extra-seat')) {
    const i = args.indexOf('--extra-seat');
    if (i !== args.length - 2) stop('usage: hq projects [words] --extra-seat 5x|20x');
    return when.run(args.slice(i));
  }
  if (args.length) return printOutlooks(args.join(' '));
  const threads: Line[] = JSON.parse(await api.orStop(api.get('projects'), "Couldn't read the threads."));
  if (!threads.length) return print('No open threads.');
  print(
    ...threads.map(projectLine),
    ...missLines(threads.filter(t => t.outlook?.standing === 'misses').map(t => t.id)),
  );
}

// What to do about threads that miss their deadlines (deadlines.ts lateLines: on a call only).
const missLines = (missing: string[]) => lateLines(missWords(missing.map(text)));

export async function now(args: string[]) {
  if (args.length) stop('usage: hq now');
  const { text: going } = JSON.parse(await api.orStop(api.get('now'), "Couldn't read what's going on.")) as {
    text: string;
  };
  print(going);
}

// The thread's id and name, then its estimate in one line, then the job that goes on next.
function projectLine(t: Line) {
  const next = t.next
    ? `; next ${jobWords(t.next.id, t.next.code)} ${text(t.next.agent)} (${t.next.status}): ${text(t.next.title)}`
    : '';
  return `${text(t.id)}  ${text(t.name)} (${text(t.owner)}): ${t.ready ? readyWords(t, t.ready) : estimateWords(t.outlook, t.id)}${next}`;
}

const readyWords = (t: Line, ready: Ready) => {
  const since = ready.since === null ? '' : ` since ${at(ready.since)}`;
  const judge = ready.judge === null ? '' : ` (#${ready.judge})`;
  return `ready to judge${since}, nothing in it open: ${text(t.owner)} closes it (hq plan done ${text(t.id)}) or draws its next task${judge}`;
};

function estimateWords(o: Outlook | null, thread: string, said = threadWait) {
  if (!o) return 'no open work';
  const eta = o.eta === null ? `no ETA (${o.stall ?? 'nothing merges it in the play'})` : `ETA ${at(o.eta)}`;
  const waits = o.waits.filter(w => w.on !== 'horizon' && w.on !== 'stalled');
  const on = waits.length ? `; waits on ${waits.map(w => said(w, thread)).join(', ')}` : '';
  return `${eta}, ${duration(o.left_ms / 60_000)} of agent time left${on}; ${windowWords(o)}`;
}

// Its planned finish against its window: by how much it misses the deadline, or what it gives of its aim and the slack
// left to its deadline.
function windowWords(o: Outlook) {
  if (o.standing === null) return 'no window';
  const deadline = `deadline ${at(o.deadline!)}`;
  if (o.finish === null) return `MISSES its ${deadline}: no finish in sight`;
  const finish = `planned finish ${at(o.finish)}`;
  const minutes = (ms: number) => duration(ms / 60_000);
  if (o.standing === 'misses') return `${finish}; MISSES its ${deadline} by ${minutes(-o.slack!)}`;
  const aim = o.aim !== null && o.aim !== o.deadline ? `aim ${at(o.aim)}, ` : '';
  const gives = o.standing === 'gives' ? `gives ${minutes(o.finish - o.aim!)}, ` : '';
  return `${finish}; window ${aim}${deadline}: ${gives}${minutes(o.slack!)} of slack`;
}

const threadWait = (w: ThreadWait, own: string): string =>
  w.on === 'job' && w.thread && w.thread !== own ? `job #${w.job} (in ${w.thread})` : waitWords(w);

export async function thread(id: string) {
  const answer = await api.call(`thread?id=${api.uri(id)}`);
  if (answer.status === 404) stop(`There's no thread ${id} (hq thread list).`);
  const t = api.parseOrNull(answer.body) as Detail | null;
  if (!api.isSuccess(answer.status) || !t) stop(`Couldn't read ${id}: ${api.errorIn(answer.body, 'no answer')}`);
  const o = t.outlook;
  print(`${text(t.id)}  ${text(t.name)} (${text(t.owner)}, ${text(t.status)}), done when ${text(t.goal)}`);
  print(t.ready ? readyWords(t, t.ready) : estimateWords(o, t.id));
  print(...missLines(o?.standing === 'misses' ? [t.id] : []));
  if (t.pause)
    print(
      `Paused${t.pause.target === t.id ? '' : ` with ${text(t.pause.target)}`} (${text(t.pause.why)}) until ${liftWords(t.pause)}.`,
    );
  if (!o) return;
  if (o.held && o.eta !== null && o.held > o.eta) print(`by ${at(o.held)} four times in five`);
  if (o.chain.length)
    print(
      `What sets its ETA: ${o.chain
        .map(l => {
          const causes = l.causes.filter(w => w.on !== 'horizon').map(waitWords);
          const where = l.thread && l.thread !== t.id ? `, in ${l.thread}` : '';
          return `${jobWords(l.job)} (${l.agent}${where}, ${statusWord(l.status)}${causes.length ? `: ${causes.join(', ')}` : ''})`;
        })
        .join(' after ')}`,
    );
  print('', 'Its open jobs:');
  for (const j of t.jobs) {
    const size = j.size_ms === null ? '' : `sized ${duration(j.size_ms / 60_000)}, `;
    const start = j.status === 'queued' && j.start !== null ? `starts about ${at(j.start)}, ` : '';
    const merged = j.merged === null ? 'no merge in sight' : `merged about ${at(j.merged)}`;
    const waits = j.waits.filter(w => w.on !== 'horizon').map(waitWords);
    print(
      `  ${jobWords(j.id, j.code)} ${text(j.agent)} (${statusWord(j.status)}${j.pr ? `, PR #${j.pr}` : ''}): ${text(j.title)}`,
      `    ${size}${duration(j.left_ms / 60_000)} left; ${start}${merged}${waits.length ? `. Waits on ${waits.join('; ')}` : ''}`,
    );
  }
}

// A job by its number (and code), or a thread with no task drawn yet, which the play runs as one placeholder numbered
// below zero (threadorder.ts placeholders).
const jobWords = (id: number, code: string | null = null) =>
  id < 0 ? 'a task still to draw' : `#${id}${codeOf(code)}`;

const statusWord = (status: string) =>
  status === 'done' ? 'in review' : status === 'blocked' ? 'waiting for the board' : status;

// hq projects <words>: the threads found (the coordinator's outlooks.ts findOutlooks), by project, each in its line as hq
// projects has it, but in names: work by its title and whose it is, a card by its title, a thread by its name. The board's
// call reads this (voice hq_tools.py eta).
type NamedJob = { title?: string | null; agent?: string; status?: string; thread_name?: string | null };
type NamedWait = ThreadWait & NamedJob;
type OutlookMatches = {
  projects: {
    name: string;
    owner: string;
    threads: { id: string; name: string; owner: string; outlook: Outlook | null; next: NamedJob | null }[];
  }[];
  known: string[];
};

async function printOutlooks(words: string) {
  const answer = await api.call(`outlooks?q=${api.uri(words)}`);
  const f = api.parseOrNull(answer.body) as OutlookMatches | null;
  if (!api.isSuccess(answer.status) || !f) stop(`Couldn't read the plan: ${api.errorIn(answer.body, 'no answer')}`);
  if (!f.projects.length)
    return print(`No open thread is called that. The open projects: ${f.known.map(text).join(', ') || 'none'}.`);
  for (const p of f.projects) {
    print(`${text(p.name)} (${text(p.owner)}'s project):`);
    for (const t of p.threads) {
      const next = t.next ? `; next ${namedWork(t.next, t.name)} (${statusWord(t.next.status!)})` : '';
      print(`- ${text(t.name)}: ${estimateWords(t.outlook, t.name, namedWaitWords)}${next}`);
    }
  }
  const threads = f.projects.flatMap(p => p.threads);
  print(...missLines(threads.filter(t => t.outlook?.standing === 'misses').map(t => t.name)));
}

function namedWaitWords(w: NamedWait, own: string) {
  if (w.on === 'job') return namedWork(w, own);
  if (w.on === 'board' && !w.paused && w.request)
    return `the board: "${text(w.title)}"${w.at ? ` (its answer expected about ${at(w.at)})` : ''}`;
  return waitWords(w);
}

// Work by its title and whose it is (a thread's task still to draw has no title), and its thread's name when given
const namedWork = (n: NamedJob, own?: string) => {
  const what = n.title === null ? 'a task still to draw' : `"${text(n.title)}"`;
  const where = n.thread_name && n.thread_name !== own ? ` in ${text(n.thread_name)}` : '';
  return `${what} (${text(n.agent)}'s${where})`;
};
