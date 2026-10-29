// The projects view's keys, one kind of tile at every level, each level showing more of each: a business's picture,
// a project's with its deliverables up next, a thread's with its tasks under way, and a thread's tasks as a list with the
// board's own card first where one waits on it; Recurring (the routines' projects) and the work outside the projects
// beside the businesses. Each level's head says where the board is and keeps its
// keys in reach above the tiles. Lit in the one accent wherever something waits on the board (threads.js forBoard), the
// same at every level, and work under way shows as moving bars. (A thread's tile is threadtile.js's, with the pieces
// it shares from here.)
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
  projectNow,
  size,
  threadEta,
  projectLit,
  queuedWords,
  planned,
} from './threads.js';
import { dayTime, fromNow } from '../world/clock.js';

// The keys after the businesses: Recurring, the routines' projects (projects.ts gives each its schedule), and the work
// outside the projects, each its name and a line icon (or the cover projects.yaml's groups name for it). A company's own
// name for one wins (named). The coordinator always names unsorted, the CEO's desk, so it is a standing tile.
export const GROUPS = {
  recurring: {
    name: 'Recurring',
    icon: icon('group-recurring', 'pj-icon'),
  },
  // Work with no project, the CEO's desk: call follow-ups, the CEO's own runs and open jobs for the CEO to place, and
  // recent finished runs. The coordinator names it for the company's CEO ("Juno's desk": wherework.ts deskName).
  unsorted: {
    name: 'The CEO’s desk',
    icon: icon('group-unsorted', 'pj-icon'),
  },
  // The meetings, a tile each with everyone at it, there while there are some (projects.ts meetingSeats).
  meetings: {
    name: 'Meetings',
    icon: icon('app-people', 'pj-icon'),
  },
};
// A group as the view shows it, with the company's name (projects.yaml groups) where it gives one
export const named = (key, set) => ({
  ...GROUPS[key],
  name: set?.name ?? GROUPS[key].name,
  standing: key === 'recurring' || (key === 'unsorted' && Boolean(set?.name)),
});

// ---------------------------------------------------------------- the tiles
// Each tile names whose it is (data-owner: a business's, project's or thread's owner, a job's agent), so a mark the
// Pencil makes on it goes on their sheet (shared/review/marks.js).
// A business: its cover with what waits on the board or is paused marked on it, the bars of the work running in it
// over its corner and its owner crowned in the other, and its name.
export function businessTile(b, projects) {
  const state = businessState(projects),
    threads = projects.flatMap(p => p.threads);
  const owner = b.owner ? [person(b.owner, true, atWork(threads).includes(b.owner))] : [];
  return `<button class="pj-tile pj-business${state.lit ? ' lit' : ''}" data-business="${esc(b.id)}" data-owner="${esc(b.owner ?? '')}">
    ${art(b, b.name, owner, state, running(threads))}<span class="pj-tile-body"><b>${esc(b.name)}</b></span></button>`;
}
// A project: a business's tile with whoever else is at work on it beside its owner, and its deliverables up next (a
// routine's interval and next run first). The board sorts these by dragging
// (data-sort, sorting.js).
export function projectTile(p) {
  const state = projectState(p),
    on = atWork(p.threads),
    people = [p.owner, ...on.filter(a => a !== p.owner)].map((a, i) => person(a, i === 0, on.includes(a)));
  return `<button class="pj-tile pj-project${state.lit ? ' lit' : ''}" data-project="${esc(p.id)}" data-sort="${esc(p.id)}" data-owner="${esc(p.owner ?? '')}">
    ${art(p, nameText(p, 'name'), people, state, running(p.threads))}<b>${nameHtml(p, 'name')}</b>${deliverables(p)}</button>`;
}
// A done thread, quieter: its owner, its name and how many of its jobs were done (projects.ts tally), or while it's
// being opened, how that goes (opening: projects.js's, for one of the project's done threads). One closed with no
// jobs in it says so.
export function doneThreadTile(t, opening) {
  const words =
    opening?.id === t.id
      ? opening.words
      : t.jobs
        ? `Done · ${t.done} of ${t.jobs} ${t.jobs === 1 ? 'job' : 'jobs'}`
        : 'Closed with no jobs';
  return tile({
    attrs: `data-thread="${esc(t.id)}" data-owner="${esc(t.owner ?? '')}"`,
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
  const what = s === 'you' ? '' : (j.asks ?? asksOf([j])).length ? 'After your answer' : null;
  // (a wait in words in the label, with its hourglass on the tile: waitOf.)
  const where = [
    what ?? waitOf(j.lead ?? j),
    j.review ? doingOf(j) : kind !== 'work' ? kind : '',
    steps && kind === 'work' && s !== 'you' ? `${steps === 1 ? 'a review' : `${steps} reviews`} open` : '',
  ].filter(Boolean);
  // (and when it lands, the play's finish a thread gives too: a line of its own.)
  const lands = planned(j.lead ?? j).done;
  return tile({
    attrs: `data-job="${Number(j.id)}" data-owner="${esc(j.agent ?? '')}"`,
    label: [nameText(j), ...where.map(x => x.text ?? x), lands].filter(Boolean).join(', '),
    state: { lit: s === 'you', words: 'Waits for you' },
    top: whoTop(j.agent),
    name: nameHtml(j),
    rows:
      (where.length
        ? `<span class="pj-state">${s === 'working' ? pulse(1) : ''}<span>${where.map(x => x.html ?? withJobLinks(x)).join(' · ')}</span></span>` // (one line of text, its links in it)
        : '') + (lands ? `<span class="pj-state">${esc(cap(lands))}</span>` : ''),
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
    ${art(set, group.name, [], {}, on, group.icon)}<span class="pj-tile-body"><b>${esc(group.name)}</b></span></button>`;
}
// Where a job is in a word, or for one waiting on others what it waits on: the code of each task it follows (its
// --after, then the others it waits on), one without a code by its agent, and each card it waits on that isn't on the
// desk phone yet (held), quoted; so two that start together and a chain read apart at a glance. As words (text) and as
// HTML with an hourglass for the waits (html).
export function waitOf(j, held = []) {
  const jobs = [j.after_state && { code: j.after_code, agent: j.after_agent }, ...(j.waits ?? [])].filter(Boolean);
  const on = [...new Set([...jobs.map(w => w.code ?? who(w.agent)), ...held.map(c => `“${c.title}”`)])].join(', ');
  return on
    ? { text: `Waits on ${on}`, html: `<span class="pj-wait">${icon('hourglass', '', 'Waits on')}${esc(on)}</span>` }
    : { text: queuedWords(j), html: esc(queuedWords(j)) };
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
    <div class="pj-flow"><div class="pj-where">${over ? `<small>${esc(over)}</small>` : ''}<h1>${esc(title)}</h1></div>
    ${marks ? `<div class="pj-marks">${marks}</div>` : ''}${keys ? `<div class="pj-keys">${keys}</div>` : ''}</div>
    <button class="pj-key pj-close" data-leave aria-label="Close the projects">${icon('close')}</button></header>`;
}
// What waits on the board here, the tiles' lit mark beside the name (words: what it says to a screen reader and on
// hover)
export const litMark = words =>
  words ? `<span class="pj-mark you" title="${esc(words)}">${icon('phone', '', esc(words))}</span>` : '';
// A project's marks: its owner, crowned, a routine's interval and next run, then what waits on the board and its pause
// (a goal the CEO marked)
export const projectMarks = p =>
  person(p.owner, true) +
  (p.goal ? `<span class="pj-note">${icon('finish')}<span>Goal</span></span>` : '') +
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
  // (a booked start, with the start's mark)
  return `<details class="pj-eta" data-eta="${esc(t.id)}"><summary class="pj-key">${icon(e.booked ? 'tour' : 'finish')}<span>${esc(e.time)}</span></summary><p>${esc(e.sums)}</p></details>`;
}
// A pause, as a mark: that it's paused and when it's judged (why is the CEO's brief, never the board's to read; a decision
// of the board's is lit instead)
const pausedMark = pause =>
  pause && !pause.decision
    ? `<span class="pj-note pj-paused">${icon('pause')}<span>${esc(pausedWords(pause))}</span></span>`
    : '';
// A pause in words, with what wakes its owner to judge it: its time (with its date), the work it waits for still to end
// (by title: no numbers for the board), or, once that's met, that it's its owner's to decide. Nothing lifts it by
// itself.
export function pausedWords(pause) {
  if (pause.woken) return 'Paused until its owner decides what’s next';
  const until = (pause.until ?? []).filter(u => !u.ended);
  const work = until.length === 1 ? `“${until[0].title}” ends` : until.length ? `${until.length} tasks end` : '';
  const when = [pause.untilTime && `it's ${dayTime(Date.parse(pause.untilTime))}`, work].filter(Boolean);
  return when.length ? `Paused, to be judged once ${when.join(' and ')}` : 'Paused';
}
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
// Faces in a row, those of the agents in on at work marked so
export const faces = (ids, on = []) =>
  ids.length ? `<span class="pj-faces">${ids.map(a => face(a, on.includes(a) ? 'on' : '')).join('')}</span>` : '';
// One person's face and name, a group's job's
const whoTop = id => `${face(id)}<span class="pj-who-line">${esc(who(id))}</span>`;
// ----
// A tile's picture: its cover (pictured: the business, project or group that names it) with its people over one corner,
// the bars of the n jobs running there over another, and its mark (state) over a third
const art = (pictured, name, people, state, n, fallback) =>
  `<span class="pj-art">${cover(pictured, name, fallback)}${people.length ? `<span class="pj-corner">${people.join('')}</span>` : ''}${mark(state)}${pulse(n)}</span>`;
// What a tile's state means to the board, as a mark: its desk phone when something there waits on it, a pause sign when
// it's paused, an hourglass when it waits on other work with no time yet,
// nothing otherwise
export const mark = state =>
  state.lit
    ? litMark(state.words)
    : state.words === 'Paused'
      ? `<span class="pj-mark" title="Paused">${icon('pause', '', 'Paused')}</span>`
      : state.waits
        ? `<span class="pj-mark" title="${esc(state.words)}">${icon('hourglass', '', esc(state.words))}</span>`
        : '';
// Someone's face with their name on hover, an owner with a crown, one at work marked so
const person = (id, owner = false, on = false) =>
  `<span class="pj-person${owner ? ' pj-owner' : ''}" data-name="${esc(who(id))}${owner ? ', owner' : ''}">${owner ? icon('crown', 'pj-crown') : ''}${face(id, on ? 'on' : '')}</span>`;
// A project's deliverables, after a routine's interval and next run: those with work running (their bars first), then
// those up next, each in its page's order (inEtaOrder), with when (the planner's), at least three; or its two latest
// done ones, the last finished first (projects.ts tally's finished), each with a tick.
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
        // (done as the icon set's tick, named for a reader.)
        .map(
          t =>
            `<li class="pj-was"><span>${nameHtml(t, 'name')}</span><small>${icon('tick', 'pj-done', 'Done')}</small></li>`,
        );
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
export const lines = l =>
  l
    ? `<span class="pj-lines" aria-label="${l.added} lines added, ${l.removed} removed">+${l.added} −${l.removed}</span>`
    : '';
export const code = j => (j.code ? `<span class="pj-code">${esc(j.code)}</span>` : ''); // (none for a job without one)
// The live sign of work under way: each job running a voice of three bars, each bar on an uneven run of its own like a
// level meter's, each voice at its own point in the run, so where more runs, more moves.
// The beat is set from the clock, so the view's repaints every 20 s carry on its rhythm instead of starting it over.
// BEAT_MS is the looks' .pj-live animation's length.
const BEAT_MS = 2400;
export function pulse(n) {
  if (!n) return '';
  const now = Date.now(),
    voices = Array.from({ length: n }, (_, i) => {
      const at = (now + i * BEAT_MS * 0.38) % BEAT_MS;
      return `<span class="pj-voice" style="--at:-${Math.round(at)}ms"><i class="pj-live"></i><i class="pj-live"></i><i class="pj-live"></i></span>`;
    });
  return `<span class="pj-pulse" role="img" aria-label="${n} ${n === 1 ? 'job' : 'jobs'} running">${voices.join('')}</span>`;
}
// A cover: the picture projects.yaml names (under theme/hq) in the style it gives (data-style, a pixel one shown at whole
// pixels), decoded before it's shown so a repaint never flashes the ground; where
// it names none, the quiet ground with the fallback (the name's initial) on it
function cover(pictured, name, fallback = `<i class="pj-initial">${esc(String(name)[0] ?? '')}</i>`) {
  const src = pictured?.cover,
    style = pictured?.style ? ` data-style="${esc(pictured.style)}"` : '';
  return `<span class="pj-cover${src ? '' : ' pj-bare'}"${style}>${src ? `<img src="${esc(src)}" alt="" draggable="false" decoding="sync">` : fallback}</span>`;
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
// ---------------------------------------------------------------- meetings
// The meetings group's tiles: a meeting each (its seats, projects.ts meetingSeats), the ended ones only when shown
// (done), the latest first.
export function meetingTiles(seats, done) {
  const tiles = meetingsOf(seats)
    .filter(m => done || !m.ended)
    .map(meetingTile);
  return tiles.join('') || '<p class="pj-none">No meetings right now.</p>';
}
// How many meetings ended, for the group's Done key
export const endedMeetings = seats => meetingsOf(seats).filter(m => m.ended).length;
const meetingsOf = seats => {
  const by = new Map();
  for (const j of seats) by.set(j.meeting.id, [...(by.get(j.meeting.id) ?? []), j]);
  return [...by.values()]
    .map(all => ({ ...all[0].meeting, seats: all.sort((a, b) => a.id - b.id), ended: all.every(finished) }))
    .sort((a, b) => b.id - a.id);
};
// A meeting: everyone at it, its topic as the board reads it, where it is (in session, when it starts, or ended), and
// its code. It opens its first seat's job, the caller's.
function meetingTile(m) {
  const live = m.seats.some(j => stateOf(j) === 'working'),
    first = m.seats[0],
    starts = m.seats.map(j => j.until ?? j.estimate?.start).find(Boolean);
  const where = live ? 'In session' : m.ended ? 'Ended' : starts ? `Starts ${fromNow(starts)}` : cap(word(first));
  return tile({
    attrs: `data-job="${Number(first.id)}"`,
    top: faces(m.seats.map(j => j.agent)),
    name: nameHtml(m, 'topic'),
    rows: `<span class="pj-state">${live ? pulse(1) : ''}${esc(where)}</span>`,
    foot: code(first),
  });
}
