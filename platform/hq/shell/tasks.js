// A thread's tasks as the board reads them: the board's own cards first, then each task in the order it runs, in its
// own state's look, with its reviews, fixes and checks under it (once, after them all, for tasks sharing a pull request).
import { esc, cap } from '../util.js';
import { who } from './desk.js';
import { names } from './brand.js';
import { icon } from './icons.js';
import { face, pulse, code, waitOf } from './projectkeys.js';
import { nameText } from './jobs.js';
import { withJobLinks, covered } from './prose.js';
import {
  word,
  boardKind,
  kindOf,
  doingOf,
  cardsOf,
  stepsOf,
  sharersOf,
  sameBranch,
  finished,
  rowState,
  planned,
  inTimeOrder,
  heldOf,
  boardPart,
  taskHtml,
  size,
  sizeShare,
  foundWords,
  queuedWords,
} from './threads.js';

// A thread's tasks, the list where the estimate lives: the board's cards first, then each task in the order it runs
// (threads.js sorted), each with every review, fix and check of it under it, however they stand; finished tasks when
// shown. Tasks that share a pull request (done on a deliverable's branch, threads.js sharersOf) have its rounds once,
// under a line of their own after the last of them listed, never under each; a task still at work or ended on that
// branch has none of them. A job blocked on its card on the desk phone is that card's row.
// The tasks in time order (threads.js inTimeOrder), and a card not on the desk phone yet under the last task listed it
// waits on to go live, so it shows where it comes in; one waiting on no task listed stays first.
export function taskRows(t, p, view) {
  const open = cardsOf(t).filter(j => !(j.status === 'blocked' && rowState(j) === 'board'));
  const listed = inTimeOrder(open.filter(j => !finished(j) || view.showDone)),
    { held } = boardPart(t, p),
    under = new Map(),
    first = [];
  for (const c of held) {
    const last = listed.findLast(j => c.holds.some(h => h.id === j.id));
    if (last) under.set(last.id, [...(under.get(last.id) ?? []), c]);
    else first.push(c);
  }
  const tasks = listed.flatMap(j => {
    const sharers = sharersOf(j, t).length,
      steps = stepsOf(j, t).map(x => taskRow(x, t, true)),
      held = (under.get(j.id) ?? []).map(c => heldRow(c, t));
    if (sharers && rowState(j) !== 'done') return [taskRow(j, t), ...held];
    if (sharers < 2) return [taskRow(j, t), ...steps, ...held];
    const lastDone = listed.findLast(x => sameBranch(x, j) && rowState(x) === 'done') === j;
    return [taskRow(j, t), ...held, ...(lastDone && steps.length ? [sharedRow(j, t), ...steps] : [])];
  });
  return boardRows(t, p, first) + tasks.join('') || `<li class="pj-none">Nothing open in this ${boardKind(t)}.</li>`;
}
// A task's row in its own state (rowState), each its own look: its agent's face with the state's mark, its title (a
// step's name under its task), who and where it is, with the planner's times until it runs, and its size as a bar and
// in words, and its code. step: a review, fix or check under its task. Its title's job numbers are links beside its tap
// target (prose.js covered).
function taskRow(j, t, step = false) {
  const s = rowState(j),
    kind = kindOf(j);
  // (a fix round says what it fixes wherever it shows.)
  const title = step ? withJobLinks(doingOf(j)) : taskHtml(j, t);
  // (a wait in words in its name, with its hourglass on the row: projectkeys.js waitOf.)
  const parts = [who(j.agent), ...rowWords(j, s, t), !step && kind !== 'work' ? kind : ''].filter(Boolean);
  const words = parts.map(x => x.text ?? x).join(' · ');
  const name = `${step || j.fixes ? doingOf(j) : nameText(j)}, ${words}`;
  return `<li${step ? ' class="pj-step"' : ''}>${covered(
    `pj-task ${s} ${kind}${s === 'board' ? ' lit' : ''}`,
    `data-job="${Number(j.id)}"`,
    name,
    `
    <span class="pj-task-who">${face(j.agent)}${ROW_MARKS[s] ?? ''}</span>
    <span class="pj-task-text"><b>${title}</b><small>${s === 'working' ? pulse(1) : ''}${parts.map(x => x.html ?? esc(x)).join(' · ')}</small></span>
    <span class="pj-task-side">${found(j)}${sizeBar(j)}${code(j)}</span>`,
  )}</li>`;
}
// Where a task is, in a few words: finished (and its review under way), at work and when it's done, or what it waits
// for (waitOf: the tasks by their codes, a card to come by its title) and when the planner starts it and has it done
function rowWords(j, s, t) {
  if (s === 'done') return [stepsOf(j, t).some(x => !finished(x)) ? `Done, in review${withOthers(j, t)}` : 'Done'];
  if (s === 'ended') return [cap(word(j))];
  const { start, done } = planned(j);
  if (s === 'working') return ['At work', done];
  const why =
    s === 'board' ? (j.status === 'blocked' ? 'Waits for you' : 'After your answer') : s === 'after' ? null : '';
  const times = [start, done].filter(Boolean);
  return [why ?? waitOf(j, heldOf([j])), ...(times.length ? times : why !== '' ? [] : [queuedWords(j)])];
}
// A task's review with the others sharing its pull request, in words: " with the other three"
const withOthers = (j, t) => {
  const n = sharersOf(j, t).length - 1;
  return n < 1 ? '' : n === 1 ? ' with the other task' : ` with the other ${numberWord(n)}`;
};
// The line over a shared pull request's rounds: they're all its tasks' at once
const sharedRow = (j, t) => {
  const n = sharersOf(j, t).length;
  return `<li class="pj-shared">${n === 2 ? 'Both' : `All ${numberWord(n)}`} tasks' review, together</li>`;
};
// A number up to ten in words, a larger one in digits
const NUMBER_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = n => NUMBER_WORDS[n] ?? String(n);
// Each row state's mark over its face's corner: done a tick, the board's its desk phone, after other work an hourglass;
// planned has its hollow look and working its bars instead
export const ROW_MARKS = {
  done: `<span class="pj-row-mark">${icon('tick', '', 'Done')}</span>`,
  board: `<span class="pj-row-mark">${icon('phone', '', 'Waits for you')}</span>`,
  after: `<span class="pj-row-mark">${icon('hourglass', '', 'Waits on other work')}</span>`,
};
// A finished review's sign, in ink when it found something blocking.
const found = j =>
  foundWords(j) ? `<span class="pj-found${j.findings.blocking ? ' blocking' : ''}">${esc(foundWords(j))}</span>` : '';
// A task's size: a bar as long as its agent time (threads.js sizeShare) and the words
const sizeBar = j =>
  size(j)
    ? `<span class="pj-size"><i class="pj-size-bar" style="--share:${sizeShare(j).toFixed(2)}"></i>${esc(size(j))}</span>`
    : '';
// The board's part in a thread, first in its tasks and lit: a decision it holds the thread for, and each card on the
// desk phone its jobs wait on (a job blocked on its own card is that card's row); then each card they wait on that
// isn't on the desk phone yet and comes in after no task listed (held, heldRow). Each names the phone by the company's
// own word for it (brand.js names.phone).
function boardRows(t, p, held) {
  const { decision, cards } = boardPart(t, p);
  const forJob = c => `For ${esc(who(c.job.agent))}: ${taskHtml(c.job, t)}`;
  return (
    [
      decision &&
        row(
          decision.card,
          'Your decision',
          decision.name,
          decision.card ? `On your ${names.phone}` : 'Everything here waits for it',
        ),
      ...cards.map(c => row(c.id, `On your ${names.phone}`, c.title, forJob(c))),
    ]
      .filter(Boolean)
      .join('') + held.map(c => heldRow(c, t)).join('')
  );
}
// A card row of the board's part. card: its number, which it opens; none, quiet and opening nothing (a decision with
// no card yet, a card not on the desk phone yet). Its words' job numbers are links, beside the tap target of one that
// opens (prose.js covered).
const row = (card, overline, title, sub) => {
  const words = `<span class="pj-phone">${icon('phone')}</span>
    <span class="pj-task-text"><b>${withJobLinks(title)}</b><small>${overline} · ${sub}</small></span>`;
  return `<li>${card ? covered('pj-task pj-board-task lit', `data-card="${Number(card)}"`, `${title}, ${overline}`, words) : `<div class="pj-task pj-board-task pj-flat">${words}</div>`}</li>`;
};
// A card not on the desk phone yet, quiet: the work it waits to go live, by its codes, and the task waiting on it.
function heldRow(c, t) {
  const live = [...new Set(c.holds.map(h => h.code ?? who(h.agent)))];
  return row(
    null,
    `Not on your ${names.phone} yet`,
    c.title,
    [
      live.length ? esc(`Once ${live.join(' and ')} ${live.length === 1 ? 'is' : 'are'} live`) : '',
      `For ${esc(who(c.job.agent))}: ${taskHtml(c.job, t)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );
}
