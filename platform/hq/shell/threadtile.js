// A thread on its project's page, more than the project's tile said of it, never less, and the line over its tasks on
// its own page that says the same.
import { esc } from '../util.js';
import { icon } from './icons.js';
import { names } from './brand.js';
import { nameHtml, nameText } from './jobs.js';
import { covered, withJobLinks } from './prose.js';
import { faces, mark, lines, pausedWords, pulse, waitOf } from './projectkeys.js';
import {
  atWork,
  boardPart,
  cardsOf,
  cardsOnce,
  finished,
  inTimeOrder,
  planned,
  rowState,
  taskHtml,
  threadEta,
  threadLine,
  threadNow,
} from './threads.js';
import { fromNow } from '../world/clock.js';

// A thread, a deliverable, as its project's page shows it: more than the project's tile said of it, never less. Who's on
// it, its name and what it's for (its done-when), its tasks running (each with its bars and when it's done) and the one
// up next (when it starts, or what it waits on), what the thread itself waits on (the board's part, a pause, the
// threads it needs, or why it has no time), its tasks as a strip, one mark each in its state, and its time: when it's
// done, the agent time its open work has left and how that sits in its window. What waits on the board or is paused is
// also a mark in its corner. threadOf: an open thread by its id, anywhere on the board (a need's name).
export function threadTile(t, p, threadOf = () => null) {
  const state = threadLine(t, p),
    on = atWork([t]),
    people = [
      ...new Set([
        ...on,
        ...cardsOf(t)
          .filter(j => !finished(j))
          .map(j => j.agent),
      ]),
    ],
    { running: now, next } = threadNow(t),
    eta = threadEta(t);
  const rows = [
    ...now.map(j => task(pulse(1), j, t, planned(j).done)),
    next && task('<small class="pj-tag">Next</small>', next, t, planned(next).start ?? waitOf(next.lead ?? next).html),
  ].filter(Boolean);
  return covered(
    `pj-tile pj-thread pj-rich${state.lit ? ' lit' : ''}`,
    `data-thread="${esc(t.id)}"`,
    [nameText(t, 'name'), state.words].join(', '),
    `<span class="pj-tile-top">${faces(people, on)}${mark(state)}</span><b>${nameHtml(t, 'name')}</b>
    <span class="pj-goal">${t.goal ? esc(nameText(t, 'goal')) : ''}</span>
    <span class="pj-tile-rows">${rows.length ? `<ul class="pj-next pj-now">${rows.join('')}</ul>` : ''}</span>
    <span class="pj-tile-rows">${threadWaits(t, p, threadOf)}</span>
    <span class="pj-tile-rows">${strip(t)}</span>
    <span class="pj-foot pj-eta-foot">${eta ? `<span class="pj-when">${esc(eta.time)}</span>${lines(t.lines)}<small>${esc(eta.sums)}</small>` : `<span class="pj-state">Nothing open</span>${lines(t.lines)}`}</span>`,
  );
}
// A task on a thread's tile: its sign (bars, or Next), its title and when (words or HTML)
const task = (sign, j, t, when) =>
  `<li>${sign}<span>${taskHtml(j, t)}</span>${when ? `<small>${when}</small>` : ''}</li>`;
// What a thread waits on, a line each: the board's decision and cards first (lit), the cards it waits on that aren't on
// the desk phone yet, its pause, and the open threads it needs (each with when it's done)
function threadWaits(t, p, threadOf) {
  const items = waitsOf(t, p, threadOf).map(
    w =>
      `<li${w.lit ? ' class="pj-you"' : ''}>${icon(w.glyph, 'pj-wait-icon')}<span>${withJobLinks(w.words)}</span></li>`,
  );
  return items.length ? `<ul class="pj-next pj-waits">${items.join('')}</ul>` : '';
}
// the same, each its glyph and words (the running threads' list says the first: threadlist.js)
export function waitsOf(t, p, threadOf) {
  const { decision, cards, held } = boardPart(t, p),
    pause = t.pause ?? p.pause,
    needs = (t.needs ?? []).map(threadOf).filter(Boolean);
  return [
    decision && wait('phone', `Your decision: ${decision.name}`, true),
    ...cards.map(c => wait('phone', `On your ${names.phone}: ${c.title}`, true)),
    ...held.map(c => wait('phone', `Not on your ${names.phone} yet: ${c.title}`)),
    pause && !pause.decision && wait('pause', pausedWords(pause)),
    ...needs.map(n => {
      const line = threadLine(n, null);
      return wait('hourglass', `After ${nameText(n, 'name')}${line.finish ? `, done ${fromNow(line.finish)}` : ''}`);
    }),
  ].filter(Boolean);
}
const wait = (glyph, words, lit = false) => ({ glyph, words, lit });
// A thread's tasks as a strip, in the order its list runs them, a mark each in its row's state (tasks.js), and how
// many are done; a pull request's step its tasks share marks one of them (threads.js cardsOnce)
function strip(t) {
  const all = inTimeOrder(cardsOnce(t));
  if (!all.length) return '';
  const done = all.filter(finished).length;
  return `<span class="pj-strip" aria-label="${done} of ${all.length} tasks done">${all.map(j => `<i class="${rowState(j.lead ?? j)}"></i>`).join('')}</span><small class="pj-strip-words">${done} of ${all.length} done</small>`;
}
// A thread's page, over its tasks: what it's for (its done-when) and its time's sums (threadEta), so the page says all its
// tile did.
export function threadBrief(t) {
  const e = threadEta(t),
    parts = [t.goal && esc(nameText(t, 'goal')), e && esc(e.sums)].filter(Boolean);
  return parts.length ? `<p class="pj-brief">${parts.map(x => `<span>${x}</span>`).join('')}</p>` : '';
}
