// The projects view's keys, one kind of tile at every level, each level showing more of each: a business's picture,
// a project's with its deliverables up next, a thread's with its tasks under way, and a thread's tasks as a list with the
// board's own card first where one waits on it; Recurring (the routines' projects) and the work outside the projects
// beside the businesses. Each level's head says where the board is and keeps its
// keys in reach above the tiles. Lit in the one accent wherever something waits on the board (threads.js forBoard), the
// same at every level, and work under way shows as moving bars.
import { esc, cap } from '../util.js';
import * as world from '../world/world.js';
import { scene, look } from './stage.js';
import { who } from './desk.js';
import { icon } from './icons.js';
import { nameHtml, nameText } from './jobs.js';
import { covered, withJobLinks } from './prose.js';
import {
  stateOf,
  word,
  kindOf,
  doingOf,
  cardsOf,
  stepsOf,
  finished,
  doneCount,
  asksOf,
  threadLit,
  threadLine,
  inEtaOrder,
  projectState,
  businessState,
  atWork,
  running,
  threadNow,
  projectNow,
  taskHtml,
  size,
  threadEta,
  projectLit,
  fromNow,
} from './threads.js';

// The keys after the businesses: Recurring, the routines' projects (projects.ts gives each its schedule), and the work
// outside the projects, each its name and a line icon (or the cover projects.yaml's groups name for it). A company's own
// name for one wins (named), and a named unsorted is a standing tile.
export const GROUPS = {
  recurring: {
    name: 'Recurring',
    icon: icon('group-recurring', 'pj-icon'),
  },
  // Work with no project: call follow-ups, the CEO's own runs and open jobs for the CEO to place, and recent finished
  // runs.
  unsorted: {
    name: 'Outside projects',
    icon: icon('group-unsorted', 'pj-icon'),
  },
};
// A group as the view shows it, with the company's name (projects.yaml groups) where it gives one
export const named = (key, set) => ({
  ...GROUPS[key],
  name: set?.name ?? GROUPS[key].name,
  standing: key !== 'unsorted' || Boolean(set?.name),
});

// ---------------------------------------------------------------- the tiles
// A business: its cover with what waits on the board or is paused marked on it, the bars of the work running in it
// over its corner and its owner crowned in the other, and its name.
export function businessTile(b, projects) {
  const state = businessState(projects),
    threads = projects.flatMap(p => p.threads);
  const owner = b.owner ? [person(b.owner, true)] : [];
  return `<button class="pj-tile pj-business${state.lit ? ' lit' : ''}" data-business="${esc(b.id)}">
    ${art(b.cover, b.name, owner, state, running(threads))}<span class="pj-tile-body"><b>${esc(b.name)}</b></span></button>`;
}
// A project: a business's tile with whoever else is at work on it beside its owner, and its deliverables up next (a
// routine's interval and next run first). The board sorts these by dragging
// (data-sort, sorting.js).
export function projectTile(p) {
  const state = projectState(p),
    people = [p.owner, ...atWork(p.threads).filter(a => a !== p.owner)].map((a, i) => person(a, i === 0));
  return `<button class="pj-tile pj-project${state.lit ? ' lit' : ''}" data-project="${esc(p.id)}" data-sort="${esc(p.id)}">
    ${art(p.cover, nameText(p, 'name'), people, state, running(p.threads))}<b>${nameHtml(p, 'name')}</b>${deliverables(p)}</button>`;
}
// A thread, a deliverable: who's on it, its name, its tasks running (each with its bars) or else the one up next, how
// much it changed so far and when it's done. What waits on the board or is paused is a mark in its corner.
export function threadTile(t, p) {
  const state = threadLine(t, p),
    on = atWork([t]),
    people = [...new Set([...on, ...openCards(t).map(j => j.agent)])],
    { running: now, next } = threadNow(t);
  const rows = (now.length ? now : [next].filter(Boolean)).map(
    j => `<li>${now.length ? pulse(1) : ''}<span>${taskHtml(j, t)}</span></li>`,
  );
  return tile({
    attrs: `data-thread="${esc(t.id)}"`,
    label: nameText(t, 'name'),
    state,
    top: faces(people),
    name: nameHtml(t, 'name'),
    rows: rows.length ? `<ul class="pj-next pj-now">${rows.join('')}</ul>` : '',
    foot: lines(t.lines) + (state.finish ? `<span class="pj-when">${esc(fromNow(state.finish))}</span>` : ''),
  });
}
// A done thread, quieter: its owner, its name and how many of its jobs were done (projects.ts tally), or while it's
// being opened, how that goes (opening: projects.js's, for one of the project's done threads)
export function doneThreadTile(t, opening) {
  const words = opening?.id === t.id ? opening.words : `Done · ${t.done} of ${t.jobs} ${t.jobs === 1 ? 'job' : 'jobs'}`;
  return tile({
    attrs: `data-thread="${esc(t.id)}"`,
    label: `${nameText(t, 'name')}, ${words}`,
    top: faces([t.owner]),
    name: nameHtml(t, 'name'),
    foot: `<span class="pj-state">${esc(words)}</span>${lines(t.lines)}`,
    live: opening?.id === t.id,
  });
}
// The work outside the projects out big, each the tile a thread has: its jobs, each opens.
export function groupTiles(groupRows) {
  return groupRows.map(r => jobTile(r, null)).join('') || '<p class="pj-none">Nothing here right now.</p>';
}
// A group's job: who, its title, its state (with its step, for one of the review loop's) and its open reviews and fixes
// as a quiet line, its size and code
function jobTile(j, t) {
  const s = stateOf(j),
    kind = kindOf(j),
    steps = stepsOf(j, t).filter(x => !finished(x)).length;
  const what = s === 'you' ? '' : (j.asks ?? asksOf([j])).length ? 'After your answer' : waitWord(j.lead ?? j);
  const where = [
    what,
    j.review ? doingOf(j) : kind !== 'work' ? kind : '',
    steps && kind === 'work' && s !== 'you' ? `${steps === 1 ? 'a review' : `${steps} reviews`} open` : '',
  ].filter(Boolean);
  return tile({
    attrs: `data-job="${Number(j.id)}"`,
    label: [nameText(j), ...where].join(', '),
    state: { lit: s === 'you', words: 'Waits for you' },
    top: whoTop(j.agent),
    name: nameHtml(j),
    rows: where.length
      ? `<span class="pj-state">${s === 'working' ? pulse(1) : ''}${withJobLinks(where.join(' · '))}</span>`
      : '',
    foot: (size(j) ? `<span class="pj-size">${esc(size(j))}</span>` : '') + code(j),
  });
}
// Recurring and work being placed beside the businesses, a business's tile: its cover (or its icon on the ground), the
// bars of its runs under way, and its name. rows: the routines' projects, or its open runs; done: how many of its runs
// finished lately; set: projects.yaml's for it; on: how many jobs run there.
export function groupTile(key, rows, done, set, on) {
  const group = named(key, set);
  if (!rows.length && !done && !group.standing) return '';
  return `<button class="pj-tile pj-business" data-group="${key}">
    ${art(set?.cover, group.name, [], {}, on, group.icon)}<span class="pj-tile-body"><b>${esc(group.name)}</b></span></button>`;
}
// Where a job is in a word, or for one waiting on others whom it waits on first, so two that start together and a
// chain read apart at a glance
export function waitWord(j) {
  const first = j.after_state ? j.after_agent : stateOf(j) === 'waits' ? j.waits?.[0]?.agent : null;
  return first ? `Waiting on ${who(first)}` : cap(word(j));
}
// ---------------------------------------------------------------- the heads
// Where the board is, one strip at the top of the view at every level: a key back up (at home the view's own mark in
// its place, so every level's name starts at the same edge), the level above in a line over the level's name, what
// stands out about it as marks (litMark, projectMarks, threadMarks), its keys, and the view's close. back: the label of
// the level above, none at home.
export function head({ back = '', over = '', title, marks = '', keys = '' }) {
  const start = back
    ? `<button class="pj-key pj-back-key" data-up aria-label="Back to ${esc(back)}">${icon('back')}</button>`
    : `<span class="pj-slot">${icon('app-projects')}</span>`;
  return `<header class="pj-head">${start}
    <div class="pj-where">${over ? `<small>${esc(over)}</small>` : ''}<h1>${esc(title)}</h1></div>
    ${marks ? `<div class="pj-marks">${marks}</div>` : ''}${keys ? `<div class="pj-keys">${keys}</div>` : ''}
    <button class="pj-key pj-close" data-leave aria-label="Close the projects">${icon('close')}</button></header>`;
}
// What waits on the board here, the tiles' lit mark beside the name (words: what it says to a screen reader and on
// hover)
export const litMark = words =>
  words ? `<span class="pj-mark you" title="${esc(words)}">${icon('phone', '', esc(words))}</span>` : '';
// A project's marks: its owner, crowned, a routine's interval and next run, then what waits on the board and its pause
export const projectMarks = p =>
  person(p.owner, true) +
  (p.schedule
    ? `<span class="pj-note pj-schedule">${icon('group-recurring')}<span>${esc(scheduled(p.schedule))}</span></span>`
    : '') +
  (projectLit(p) ? litMark(projectState(p).words) : '') +
  pausedMark(p.pause);
// a routine's interval and next run: "daily 07:00 · next tomorrow 07:00"
const scheduled = s => [s.when, s.next && `next ${s.next}`].filter(Boolean).join(' · ');
// A thread's: its owner, what waits on the board and its pause, and its time, always
export const threadMarks = (t, p) =>
  face(t.owner) + (threadLit(t, p) ? litMark(threadLine(t, p).words) : '') + pausedMark(t.pause ?? p.pause) + eta(t);
// A thread's live estimate (threads.js threadEta): when it's done, a key that shows on a tap the agent time its open
// work has left and how that sits in its window, or why it has no time yet; a quiet mark while it has no open work.
// Never in alarm colours: a later time is news.
function eta(t) {
  const e = threadEta(t);
  if (!e) return `<span class="pj-note">${icon('finish')}<span>No time yet</span></span>`;
  return `<details class="pj-eta" data-eta="${esc(t.id)}"><summary class="pj-key">${icon('finish')}<span>${esc(e.time)}</span></summary><p>${esc(e.sums)}</p></details>`;
}
// A pause, as a mark: only that it's paused (why is the CEO's brief, never the board's to read; a decision of the
// board's is lit instead)
const pausedMark = pause =>
  pause && !pause.decision ? `<span class="pj-note">${icon('pause')}<span>Paused</span></span>` : '';
// A head's key for the board's decision a project or thread waits on (the CEO names it): its card, which alone ends it.
export const decisionKey = pause =>
  pause?.decision?.card
    ? `<button class="pj-key on" data-card="${Number(pause.decision.card)}">${icon('phone')}<span>Open its card</span></button>`
    : '';
// A thread's key for its finished tasks, there while it has some.
export const foldKeys = (t, view) => doneKey(doneCount(t), view.showDone);
// A project's switch between its ongoing threads and its completed ones (n of them), there while it has some.
export const sideKeys = (n, on) =>
  n
    ? `<button class="pj-key" data-done="ongoing" aria-pressed="${!on}">Ongoing</button><button class="pj-key" data-done="completed" aria-pressed="${on}">Completed</button>`
    : '';
// A level's key for what's done in it (n of them), shown on a tap: a thread's jobs, a group's runs
export const doneKey = (n, on) =>
  n ? `<button class="pj-key" data-done aria-pressed="${on}">Done · ${n}</button>` : '';
// ---------------------------------------------------------------- pieces
// The tile a thread and a group's job share: who's on it, with its mark (state) in the corner, its name (HTML; label:
// in words), a few rows and a foot (live: its words change as it's read). The job numbers in its tasks' titles are
// links beside its tap target (prose.js covered).
const tile = ({ attrs = '', label, state = {}, top, name, rows = '', foot = '', live = false }) =>
  covered(
    `pj-tile pj-thread${state.lit ? ' lit' : ''}`,
    attrs,
    label,
    `<span class="pj-tile-top">${top}${mark(state)}</span><b>${name}</b><span class="pj-tile-rows">${rows}</span><span class="pj-foot"${live ? ' aria-live="polite"' : ''}>${foot}</span>`,
  );
// Faces in a row
const faces = ids => (ids.length ? `<span class="pj-faces">${ids.map(a => face(a)).join('')}</span>` : '');
// One person's face and name, a group's job's
const whoTop = id => `${face(id)}<span class="pj-who-line">${esc(who(id))}</span>`;
// ----
// A tile's picture: its cover with its people over one corner, the bars of the n jobs running there over another, and
// its mark (state) over a third
const art = (src, name, people, state, n, fallback) =>
  `<span class="pj-art">${cover(src, name, fallback)}${people.length ? `<span class="pj-corner">${people.join('')}</span>` : ''}${mark(state)}${pulse(n)}</span>`;
// What a tile's state means to the board, as a mark: its desk phone when something there waits on it, a pause sign when
// it's paused, an hourglass when it waits on other work with no time yet,
// nothing otherwise
const mark = state =>
  state.lit
    ? litMark(state.words)
    : state.words === 'Paused'
      ? `<span class="pj-mark" title="Paused">${icon('pause', '', 'Paused')}</span>`
      : state.waits
        ? `<span class="pj-mark" title="${esc(state.words)}">${icon('hourglass', '', esc(state.words))}</span>`
        : '';
// Someone's face with their name on hover, an owner with a crown
const person = (id, owner = false) =>
  `<span class="pj-person${owner ? ' pj-owner' : ''}" data-name="${esc(who(id))}${owner ? ', owner' : ''}">${owner ? icon('crown', 'pj-crown') : ''}${face(id)}</span>`;
// A project's deliverables, after a routine's interval and next run: those with work running (their bars first), then
// those up next, each in its page's order (inEtaOrder), with when (the planner's), at least three; or its two latest
// done ones, the last finished first (projects.ts tally's finished).
function deliverables(p) {
  const on = projectNow(p),
    rest = p.threads.filter(t => !on.includes(t));
  const next = [...inEtaOrder(p, on), ...inEtaOrder(p, rest)].slice(0, Math.max(3, on.length));
  const routine = p.schedule ? [`<li class="pj-schedule"><span>${esc(scheduled(p.schedule))}</span></li>`] : [];
  const items = next.length
    ? next.map(t => `<li>${pulse(running([t]))}<span>${nameHtml(t, 'name')}</span>${when(t, p)}</li>`)
    : p.done
        .slice()
        .sort((a, b) => b.finished.localeCompare(a.finished))
        .slice(0, 2)
        .map(t => `<li class="pj-was"><span>${nameHtml(t, 'name')}</span><small>done</small></li>`);
  return `<ul class="pj-next pj-deliverables">${[...routine, ...items].join('')}</ul>`;
}
// When a deliverable's done, by the planner (its line's finish, threadLine's, from now), or that it waits on the board,
// or a pause sign
function when(t, p) {
  const line = threadLine(t, p);
  if (line.lit) return '<small class="pj-you">For you</small>';
  if (t.pause ?? p.pause) return `<small>${icon('pause', 'pj-paused-icon', 'Paused')}</small>`;
  return line.finish ? `<small>${esc(fromNow(line.finish))}</small>` : '';
}
// How much a thread changed so far: its pull requests' lines (projects.ts lines)
const lines = l =>
  l
    ? `<span class="pj-lines" aria-label="${l.added} lines added, ${l.removed} removed">+${l.added} −${l.removed}</span>`
    : '';
const openCards = t => cardsOf(t).filter(j => !finished(j));
export const code = j => (j.code ? `<span class="pj-code">${esc(j.code)}</span>` : ''); // (none for a job without one)
// The live sign of work under way: each job running a voice of three bars moving as one, each voice on a beat of its
// own, so where more runs, more moves.
// The beat is set from the clock, so the view's repaints every 20 s carry on its rhythm instead of starting it over.
// BEAT_MS is the looks' .pj-live animation's length.
const BEAT_MS = 1200;
export function pulse(n) {
  if (!n) return '';
  const now = Date.now(),
    voices = Array.from({ length: n }, (_, i) => {
      const at = (now + i * BEAT_MS * 0.38) % BEAT_MS;
      return `<span class="pj-voice" style="--at:-${Math.round(at)}ms"><i class="pj-live"></i><i class="pj-live"></i><i class="pj-live"></i></span>`;
    });
  return `<span class="pj-pulse" role="img" aria-label="${n} ${n === 1 ? 'job' : 'jobs'} running">${voices.join('')}</span>`;
}
// A cover: the picture projects.yaml names (under theme/hq), a pixel image shown at whole pixels, decoded before it's
// shown so a repaint never flashes the ground; where it names none, the quiet ground with the fallback (the name's
// initial) on it
function cover(src, name, fallback = `<i class="pj-initial">${esc(String(name)[0] ?? '')}</i>`) {
  return `<span class="pj-cover${src ? '' : ' pj-bare'}">${src ? `<img src="${esc(src)}" alt="" draggable="false" decoding="sync">` : fallback}</span>`;
}

// An agent's face: the look's own portrait of them (the scene draws it), or their initial. cls: 'big', or 'on' while
// they're at work
const portraits = new Map();
export function face(id, cls = '') {
  const key = `${look}:${id}`;
  if (!portraits.has(key)) {
    let p = null;
    try {
      p = world.agents.has(id) ? scene.portrait?.({ kind: 'agent', id }) : null;
    } catch {
      /* a newcomer the scene hasn't placed yet: the initial, this once */
    }
    if (p) portraits.set(key, p.img.toDataURL());
  }
  const url = portraits.get(key) ?? '';
  return `<i class="pj-face ${cls}" title="${esc(who(id))}${cls === 'on' ? ', at work' : ''}"${url ? ` style="background-image:url(${url})"` : ''}>${url ? '' : esc(who(id)[0])}</i>`;
}
