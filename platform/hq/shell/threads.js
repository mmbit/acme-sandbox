// The projects view's read model: each job's state in a word, the cards a thread's jobs make (a review or fix folds
// under its job), and one rule for what waits on the board, the same at every level (business, project, thread, job),
// which lights it in the accent.
import { state as jobState, CHIP, whereNow } from './jobs.js';
import { who, ago } from './desk.js';
import { clockWhen, fromNow } from '../world/clock.js';
import { glance } from '../../../shared/signs/signs.js';
import { cap } from '../util.js';
import { withJobLinks } from './prose.js';

// A job as the board reads it here: for you, working, next, waits (paused and later too, as jobs.js words them), done
export const STATE = {
  blocked: 'you',
  running: 'working',
  next: 'next',
  waits: 'waits',
  later: 'waits',
  paused: 'waits',
  done: 'done',
  failed: 'ended',
  cancelled: 'ended',
};
// A card is in the state of its lead (cardsOf). A job blocked on a card that isn't on the desk phone yet waits.
export function stateOf(j) {
  const lead = j.lead ?? j,
    s = jobState(lead);
  return s === 'blocked' && lead.request_shown === false ? 'waits' : (STATE[s] ?? 'ended');
}
const ORDER = { you: 0, working: 1, next: 2, waits: 3, ended: 4, done: 5 };
export const word = j => CHIP[jobState(j)] ?? j.status;
// A task's state in words where nothing it waits on names it: a queued one's the seat it starts at, when it goes on or
// the event it waits for (jobs.js whereNow), never a bare "Next" or "Paused".
export const queuedWords = j => cap(j.status === 'queued' ? whereNow(j, { who, ago }) : word(j));
export const kindOf = j => (j.check ? 'check' : j.review ? 'review' : 'work');
// A review loop job's step, apart from the work's title it carries (the coordinator's jobs.step and jobs.round)
export const stepName = j => (j.step ? `${j.step}${j.round ? `, round ${j.round}` : ''}` : '');
// What a review loop job does, in plain words and never its kind alone: a fix round what it fixes (the coordinator's
// reviewrows.ts fixes: its own name, else its first findings; or the edits the review made, which it checks),
// any other its step, or for one with none its stage's or kind's words.
const STAGE = {
  triage: 'Choosing the reviewers',
  review: 'Reviewing',
  ruling: 'Weighing the reviews',
  merge: 'Checking the merge',
  fix: 'Fixing what the review found',
  feedback: 'Taking in your notes',
};
const KIND = { review: 'Reviewing', consolidate: 'Weighing the reviews' };
const SHOWN = 2;
export function doingOf(j) {
  const f = j.fixes;
  if (!f) return stepName(j) || STAGE[j.stage] || KIND[j.kind] || j.title;
  const listed = f.findings.slice(0, SHOWN).join('; '),
    more = f.findings.length - SHOWN;
  if (f.touchups) return `Checking the edits made in round ${f.round}'s review${f.title ? `: ${f.title}` : ''}`;
  return `Fixing what round ${f.round} found: ${f.title ?? (more > 0 ? `${listed}; and ${more} more` : listed)}`;
}
// A finished review's findings in a few words: a ruling's verdict, a reviewer's blocking findings and notes, or clear
// (the coordinator's reviewrows.ts).
const VERDICT = {
  merge: 'Merge',
  changes: 'Another round',
  close: 'Close',
  board: 'Yours to decide',
  panel: 'To the whole panel',
};
export function foundWords(j) {
  const f = j.findings;
  if (!f) return '';
  if (f.verdict) return VERDICT[f.verdict];
  const parts = [f.blocking && `${f.blocking} blocking`, f.notes && `${f.notes} ${f.notes > 1 ? 'notes' : 'note'}`];
  return parts.filter(Boolean).join(' · ') || 'Clear';
}
// What became of a finding, in words (none while its ruling hasn't been acted on)
const FATE = {
  kept: 'Kept as it is, on purpose',
  dropped: 'Dropped',
  'follow-up': 'Moved to a follow-up task',
  later: 'For a follow-up task',
  open: 'Still open',
};
export const fateWords = f =>
  f.fate === 'fixed' ? (f.round ? `Fixed in round ${f.round}` : 'Fixed') : (FATE[f.fate] ?? '');
const branchOf = j => j.branch ?? `job/${j.id}`;
// A thread's jobs: a review or fix of a job in the thread folds under that job (its branch), the rest as cards. A
// card's lead is the job it's in the state of: its own, or its most pressing review or fix still open (a finished job's
// review under way, or a decision it waits for, keeps the card in play). asks: the board's cards its jobs wait on
// (asksOf); held: those they wait on that aren't on the desk phone yet (heldOf).
export function cardsOf(t) {
  const work = new Set(t.jobs.filter(j => !j.review).map(branchOf));
  return t.jobs
    .filter(j => !(j.review && work.has(j.branch)))
    .map(j => {
      const open = [j, ...stepsOf(j, t).filter(x => !finished(x))];
      return {
        ...j,
        lead: open
          .slice()
          .sort((a, b) => ORDER[stateOf(a)] - ORDER[stateOf(b)] || rankOf(a) - rankOf(b) || a.id - b.id)[0],
        asks: asksOf(open),
        held: heldOf(open),
      };
    });
}
export const stepsOf = (j, t) =>
  j.review || !t ? [] : t.jobs.filter(x => x.review && x.branch === branchOf(j)).sort((a, b) => a.id - b.id);
export const finished = j => ['done', 'ended'].includes(stateOf(j));
// How many of a thread's tasks are finished: what its Done key brings in (an open task's steps show however they stand).
export const doneCount = t => cardsOf(t).filter(finished).length;
// (queued work in the claim's order: its rank, coordinator jobs.ts jobRows; a card by its lead's.)
const rankOf = j => (j.lead ?? j).rank ?? Infinity;
export const sorted = jobs =>
  jobs
    .slice()
    .sort(
      (a, b) =>
        forBoard(b) - forBoard(a) || ORDER[stateOf(a)] - ORDER[stateOf(b)] || rankOf(a) - rankOf(b) || a.id - b.id,
    );
// A thread's tasks in time order, for its list: those whose own work ended as they ended (in review or not), those at
// work, then the rest by when the play starts them (those it has no start for last), in sorted's order where that's
// level; so work that waits on other work lists below it.
export const inTimeOrder = jobs =>
  sorted(jobs)
    .map(j => [timePlace(j), j])
    .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1])
    .map(([, j]) => j);
function timePlace(j) {
  const s = rowState(j);
  if (s === 'done' || s === 'ended') return [0, Date.parse(j.finished) || 0];
  return s === 'working' ? [1, 0] : [2, j.estimate?.start ?? Number.MAX_SAFE_INTEGER];
}
export const count = (jobs, s) => jobs.filter(j => stateOf(j) === s).length;

// ---------------------------------------------------------------- a task as its row shows it
// A task's own state, never its steps': done, working, board (it waits on the board: blocked on its card, or queued
// for the answer to one on the desk phone), planned (queued: next, later or paused), after (queued behind other work,
// or a card not on the desk phone yet), ended (failed or cancelled)
export function rowState(j) {
  const s = jobState(j);
  if (s === 'done') return 'done';
  if (s === 'running') return 'working';
  if (s === 'failed' || s === 'cancelled') return 'ended';
  if ((s === 'blocked' && j.request_shown !== false) || asksOf([j]).length) return 'board';
  return s === 'waits' || s === 'blocked' ? 'after' : 'planned';
}
// Where a task's played times stand (the coordinator's outlooks.ts estimate): when it starts and when it's done, each
// in words where the play has one. Done is its finish, its work live: the time a thread's "Done about" gives for its
// last task. A job the play has no start for may be booked past the play's horizon (hq job --when); its start then says
// when it's booked for.
export const planned = j => ({
  start: j.estimate?.start
    ? `starts ${clock(j.estimate.start)}`
    : j.estimate?.booked
      ? `booked for ${fromNow(j.estimate.booked)}`
      : null,
  done: j.estimate?.finish ? `done about ${clock(j.estimate.finish)}` : null,
});
// A task's title under its thread, without the thread's name in front: "The shop's checkout: gift wrap" under
// "The shop's own checkout" reads "Gift wrap". The name counts with or without a leading "The", an "own" after a
// possessive, and what follows its own colon.
// Its job numbers are linked.
export const taskHtml = (j, t) => withJobLinks(taskTitle(j.title, t));
function taskTitle(title, t) {
  const names = nameForms(t.name);
  for (let at = title.indexOf(': '); at > 0; at = title.indexOf(': ', at + 1)) {
    const rest = title.slice(at + 2).trim();
    if (rest && nameForms(title.slice(0, at)).some(n => names.includes(n))) return cap(rest);
  }
  return title;
}
function nameForms(name) {
  const plain = name
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/'s own /g, "'s ");
  const lead = plain.split(': ')[0];
  return lead === plain ? [plain] : [plain, lead];
}
// What's going on in a thread one level down: its running tasks, and the next one (the first by sorted that isn't
// running), for its tile
export function threadNow(t) {
  const open = sorted(cardsOf(t).filter(j => !finished(j)));
  return {
    running: open.filter(j => stateOf(j) === 'working'),
    next: open.find(j => stateOf(j) !== 'working') ?? null,
  };
}
// A project's threads with a task running, for its tile
export const projectNow = p => p.threads.filter(t => threadNow(t).running.length);

// ---------------------------------------------------------------- what waits on the board, at every level
// A job waits on the board when it's blocked on its card, or queued for the answer to one (hq job --after
// request:<id>); a card of the thread's when any of its open jobs does
export const forBoard = j => stateOf(j) === 'you' || !!(j.asks ?? asksOf([j])).length;
// The cards on the desk phone some jobs wait on, each once with the first job waiting on it: the one a job is blocked
// on, then every one it's queued after. A card held off the desk phone (until work it waits for is live, or a day:
// the coordinator's shown.ts) isn't the board's to answer yet, so it lights nothing: heldOf has those.
export const asksOf = jobs => cardsWaitedOn(jobs).filter(c => c.shown);
export const heldOf = jobs => cardsWaitedOn(jobs).filter(c => !c.shown);
function cardsWaitedOn(jobs) {
  const cards = new Map();
  for (const x of jobs) {
    const own =
      x.status === 'blocked' && x.request
        ? [{ id: x.request, title: x.request_title, shown: x.request_shown !== false, holds: x.request_holds }]
        : [];
    // (holds: the work a held one waits to go live, coordinator jobs.ts holdsJson.)
    for (const c of [...own, ...(x.cards ?? [])])
      if (!cards.has(c.id))
        cards.set(c.id, { id: c.id, title: c.title, shown: c.shown !== false, holds: c.holds ?? [], job: x });
  }
  return [...cards.values()];
}
// The board's part in a thread, first in it: a decision it holds the thread (or its project) for, and every card on
// the desk phone its jobs wait on, each once, those of the jobs blocked on theirs first; held: the cards they wait on
// that aren't on the desk phone yet
export function boardPart(t, p) {
  const decision = (t.pause ?? p?.pause)?.decision ?? null,
    open = sorted(cardsOf(t).filter(x => !finished(x))),
    once = cards => cards.filter((c, i) => c.id !== decision?.card && cards.findIndex(x => x.id === c.id) === i);
  return { decision, cards: once(open.flatMap(j => j.asks)), held: once(open.flatMap(j => j.held)) };
}
export const threadLit = (t, p) =>
  !!(t.pause ?? p?.pause)?.decision || cardsOf(t).some(j => !finished(j) && forBoard(j));
export const projectLit = p => !!p.pause?.decision || p.threads.some(t => threadLit(t, p));

// ---------------------------------------------------------------- each level's state, in a word or two
export function threadState(t) {
  const cards = cardsOf(t);
  for (const s of ['you', 'working', 'next', 'waits']) if (cards.some(j => stateOf(j) === s)) return s;
  return cards.some(j => stateOf(j) === 'ended') ? 'ended' : 'done';
}
// A thread's line: the board's part first (never a time while it waits on the board), a pause with its reason, else
// when it's done in the play, and by how much that misses its deadline.
// (waits: it waits on something besides the board, paused or with no time while it waits on other work; finish: the
// time it shows, the one its tiles show and the page sorts it by.)
export function threadLine(t, p) {
  const pause = t.pause ?? p?.pause;
  if (pause?.decision) return { lit: true, words: 'Waits for your decision' };
  if (threadLit(t, p)) return { lit: true, words: 'Waits for you' };
  if (pause) return { words: 'Paused', why: pause.why, waits: true };
  const o = t.outlook,
    why = o?.standing === 'misses' ? missed(o) : undefined;
  if (o?.finish) return { words: `Done about ${clock(o.finish)}`, why, finish: o.finish };
  const s = threadState(t);
  return {
    words: { working: 'At work', next: 'Starts next', waits: 'Waits on other work' }[s] ?? 'Nothing open',
    why,
    waits: s === 'waits',
  };
}
// A project's open threads in the order its page lists them (and its tile its deliverables): those waiting on the
// board (a decision or a card), then those waiting on something else, then by the time their lines show, soonest
// first, and those with no time last; in the order they came where they're level.
export const inEtaOrder = (p, threads = p.threads) =>
  threads
    .map(t => [etaPlace(t, p), t])
    .sort(([a], [b]) => a[0] - b[0] || a[1] - b[1])
    .map(([, t]) => t);
const etaPlace = (t, p) => {
  const line = threadLine(t, p);
  return line.lit ? [0, 0] : line.waits ? [1, 0] : line.finish ? [2, line.finish] : [3, 0];
};
// A thread's live estimate in words (the forecast's outlook), for its head: when it's done, or that it has no time yet;
// and its sums, the agent time its open work has left and how that sits in its window (the slack before its deadline,
// what it gives of its aim, or by how much it misses), or why it has no time: for work booked to start past the
// play's horizon (outlooks.ts booked), when it's booked for, with booked set.
// Never in alarm colours: a later time is news. null while it has no open work.
export function threadEta(t) {
  const o = t.outlook;
  if (!o) return null;
  if (o.finish === null && o.booked)
    return {
      booked: true,
      time: `Booked for ${fromNow(o.booked)}`,
      sums: `${glance(o.left_ms)} of agent time left, from then.`,
    };
  if (o.finish === null)
    return { time: 'No time yet', sums: `${cap(o.stall ?? 'nothing in the queue lets it merge')}.` };
  return { time: `Done about ${clock(o.finish)}`, sums: `${glance(o.left_ms)} of agent time left.${windowWords(o)}` };
}
// standing (forecast.ts): 'misses' | 'gives' | 'holds', or null without a window
function windowWords(o) {
  if (o.standing === null) return '';
  if (o.standing === 'misses') return ` ${missed(o)}.`;
  const spare = `${glance(o.slack)} to spare before its deadline ${clock(o.deadline)}`;
  return o.standing === 'gives'
    ? ` ${glance(o.finish - o.aim)} past its aim of ${clock(o.aim)}, ${spare}.`
    : ` ${cap(spare)}.`;
}
// A thread's outlook that misses its deadline (forecast.ts standing), in words: by how much, or that nothing finishes it
export const missed = o =>
  o.finish === null
    ? `Misses its deadline ${clock(o.deadline)}`
    : `${glance(o.finish - o.deadline)} past its deadline ${clock(o.deadline)}`;
export function projectState(p) {
  if (p.pause?.decision) return { lit: true, words: 'Waits for your decision' };
  const lit = p.threads.filter(t => threadLit(t, p)).length;
  if (lit) return { lit: true, words: 'Waits for you' };
  if (p.pause) return { words: 'Paused', why: p.pause.why };
  const jobs = p.threads.flatMap(cardsOf);
  if (count(jobs, 'working')) return { words: 'At work' };
  return { words: jobs.some(j => !finished(j)) ? 'Planned' : 'Nothing open' };
}
export function businessState(projects) {
  if (projects.some(projectLit)) return { lit: true, words: 'Waits for you' };
  const jobs = projects.flatMap(p => p.threads.flatMap(cardsOf));
  if (count(jobs, 'working')) return { words: 'At work' };
  if (projects.length && projects.every(p => p.pause)) return { words: 'Paused' };
  return { words: jobs.some(j => !finished(j)) ? 'Planned' : 'Nothing open' };
}
// who's at work in a set of threads, each once
export const atWork = threads => [
  ...new Set(threads.flatMap(t => t.jobs.filter(j => stateOf(j) === 'working').map(j => j.agent))),
];
// how many jobs are running in a set of threads, reviews and checks too: how much work is under way there
export const running = threads => threads.reduce((n, t) => n + count(t.jobs, 'working'), 0);

// ---------------------------------------------------------------- words
// a job's size, as the sizer has it: its agent time, rounded the way a glance reads it
export const size = j => (j.estimate?.size_ms ? glance(j.estimate.size_ms) : '');
// what the play has left of a job at work, the same way
export const left = j => (j.estimate?.left_ms ? glance(j.estimate.left_ms) : '');
// A job's size as a share of a long one, for a bar: on a log scale, so 5 minutes still shows, and full from eight hours
// of agent time.
const SIZE_FULL_MIN = 8 * 60;
export const sizeShare = j => Math.min(1, Math.log1p(j.estimate.size_ms / 60000 / 5) / Math.log1p(SIZE_FULL_MIN / 5));
export const clock = clockWhen;
