// Assigning: one of the board's scraps handed to a person (the store's side: bookassign.ts). With the Pencil, Select's
// or the Pen's, one stroke circles a scrap and carries on out of the circle: once it has left, the short list pops up at the line's
// end (bookassignlist.js), the line drawn onto a name lights it, and lifted there the scrap goes to them; lifted
// anywhere else, the line fades and nothing goes. With a mouse or a finger, Select's bar has Assign while one whole
// scrap is picked, opening the same list beside it. A pick sends a copy of the scrap flying to the name (a copy that
// takes no press, as bookpaper.js's do), the list and the line tidy away, and the scrap stays where it is, wearing the
// person's tag. More… opens everyone, to scroll or search, and a pick there goes the same way. Its look: bookassign.css.
//
// bookselect.js mounts it, hands it each move of a loop being drawn (drew: true when it drew it) and its lift (lifted:
// true when it took it), and has it fit Assign into the bar beside what's picked. bookwrite.js tells it of each Pen
// stroke (book.assign).
import { esc, stylesheet } from '../../util.js';
import { foley, sfx } from '../audio.js';
import { toast } from '../toast.js';
import { button, lineIcon } from './bookui.js';
import { scope, word } from './bookscope.js';
import { shut } from './booksave.js';
import { assignGroup, loadPeople } from './notebookdata.js';
import { membersOf, picked } from './bookselectmath.js';
import { boxOfText, letGo, pageOf } from './bookselect.js';
import { followPress } from './bookpress.js';
import { leftRing, ringAt } from './bookassignmath.js';
import { everyoneSheet, freshTag, light, placeAt, placeBeside, rowAt, shortList } from './bookassignlist.js';
import { flight, lineOver, tidy } from './bookassignfly.js';

// a ring closes where the stroke comes back this near (screen px) to a point at least ROUND_PX before it along the
// stroke; the line out of it has left once it's LEAVE_PX clear of the ring
const CLOSE_PX = 28,
  ROUND_PX = 180,
  LEAVE_PX = 40;
// the tag pops in this long (ms) after the copy sets off: as it lands and the list has tidied away
const TAG_MS = 1600;
// the rows' pops, a note each, as they come in one by one (bookassign.css's 100 ms apart)
const NOTES = ['A5', 'C6', 'D6', 'E6', 'G6'];
const PERSON = lineIcon('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>');

// sel: bookselect.js's
export function mountAssign(sel) {
  stylesheet('shell/ink/bookassign.css');
  // (shown: the list or sheet open, { card, people, close() }; people: the store's, as last asked)
  // (claim: whether the Pen's stroke just lifted was the gesture's, ending on the list)
  const as = { sel, shown: null, people: null, claim: false };
  // (the Pen tool's strokes too: bookwrite.js tells of one starting, and asks as it dries whether it was the gesture's)
  sel.book.assign = { inking: down => inking(as, down), claim: () => claimed(as) };
  return {
    drew: (loop, m) => drew(as, loop, m),
    lifted: (loop, u) => lifted(as, loop, u),
    fit: bar => fit(as, bar),
  };
}

// ---- by the Pencil

// A move of a loop being drawn with the Pencil: a ring round one whole scrap first, then a line out of it far enough
// to be one; from then on the line is drawn here, over the list, lighting the row it's on
function drew(as, loop, m) {
  if (scope || loop.down.pointerType !== 'pen' || loop.kind !== 'lasso') return false;
  const a = (loop.assign ??= { checked: 1, ring: null, line: null, list: null, lit: null, done: false });
  const scale = as.sel.book.scale;
  if (!a.line && !a.ring) a.ring = ringed(as, loop, a);
  else if (!a.line && leftRing(a.ring.poly, loop.path.at(-1), LEAVE_PX / scale)) leave(as, loop, a, m);
  if (!a.line) return false;
  a.line.draw(loop.path);
  const row = a.list && rowAt(a.list.card, m.clientX, m.clientY);
  if (row !== a.lit) {
    light(a.list.card, row);
    if (row) sfx.tick();
    a.lit = row;
  }
  return true;
}
// The ring the stroke has closed since last looked, if it holds one whole scrap on an open page (asking the store who
// it can go to meanwhile): { poly, to (where it closed on the stroke), ...its scrap }, or null
function ringed(as, loop, a) {
  const { path, view } = loop,
    scale = as.sel.book.scale;
  for (; a.checked < path.length; a.checked++) {
    const ring = ringAt(path, a.checked, CLOSE_PX / scale, ROUND_PX / scale);
    if (!ring) continue;
    const poly = path.slice(ring.from, ring.to + 1),
      scrap = wholeGroup(
        view,
        picked(poly, view.page, t => boxOfText(as.sel, t)),
      );
    if (!scrap) continue;
    asked(as);
    return { poly, to: ring.to, ...scrap };
  }
  return null;
}
// The line has left the ring: drawn in ink over everything from now, the loop's dashes gone, and the short list
// popping up at its end
function leave(as, loop, a, m) {
  loop.svg?.remove();
  a.line = lineOver(as.sel.book);
  const end = [m.clientX, m.clientY];
  as.people.then(
    people => !a.done && (a.list = opened(as, a.ring, people, shortList(people.recent, people.everyone.length), end)),
    e => toast(esc(e.message)),
  );
}
// The Pencil lifted after its line left the ring: on a name, the scrap goes to them; on More…, everyone; anywhere
// else, nothing, the line fading
function lifted(as, loop, u) {
  const a = loop.assign;
  if (!a?.line) return false;
  a.done = true;
  const row = u.type === 'pointercancel' || !a.list ? null : rowAt(a.list.card, u.clientX, u.clientY);
  a.row = row;
  if (row?.dataset.to) give(as, a.ring, a.list, row, a.line);
  else {
    tidy([a.line.el]);
    if (row) everyone(as, a.ring, a.list);
    else if (a.list) close(as);
  }
  return true;
}

// A Pen stroke starting: followed as Select's loop is, the same ring and line out of it making the same list. Lifted on
// the list, the stroke was the gesture's and leaves no ink (claimed); lifted anywhere else, it's ink as ever.
function inking(as, down) {
  as.claim = false;
  const { book } = as.sel,
    at = book.at(down.clientX, down.clientY);
  // (the Pen's alone: a highlighter's stroke is always ink)
  if (scope || down.pointerType !== 'pen' || !at || (book.tools?.mode() ?? 'pen') !== 'pen') return;
  const loop = { view: at.view, path: [pageOf(book, down)], kind: 'lasso', down, svg: null };
  followPress(down, {
    move: m => {
      const all = m.getCoalescedEvents?.() ?? [];
      for (const c of all.length ? all : [m]) loop.path.push(pageOf(book, c));
      drew(as, loop, m);
    },
    // (before the pen's own lift: its stroke dries after, asking claimed())
    up: u => (as.claim = lifted(as, loop, u) && !!loop.assign.row),
  });
}
function claimed(as) {
  const was = as.claim;
  as.claim = false;
  return was;
}

// ---- by the mouse or a finger

// Assign in Select's bar (first, with a person) while one whole scrap of an open page is picked
function fit(as, bar) {
  if (scope) return;
  let b = bar.querySelector('.bk-assign-btn');
  if (!b) {
    b = button({ icon: PERSON, text: word('Assign'), onClick: () => fromBar(as) });
    b.classList.add('bk-assign-btn');
    bar.prepend(b);
  }
  b.hidden = !wholeGroup(as.sel.view, as.sel);
}
// The short list beside the scrap picked (its frame and its bar)
async function fromBar(as) {
  const { sel } = as,
    scrap = wholeGroup(sel.view, sel);
  if (!scrap) return;
  let people;
  try {
    people = await asked(as);
  } catch (e) {
    return toast(esc(e.message));
  }
  const card = shortList(people.recent, people.everyone.length);
  const frame = sel.frame.el.getBoundingClientRect(),
    bar = sel.frame.bar.getBoundingClientRect();
  opened(as, scrap, people, card, null, union(frame, bar));
}

// ---- the list and the sheet

// A card of people shown (at a line's end, else beside a box), the one shown before it closed; a click on a name gives
// the scrap to them, More… opens everyone. → { card, people, close() }
function opened(as, scrap, people, card, end, beside = null) {
  close(as);
  const room = as.sel.book.desk.getBoundingClientRect();
  if (end) placeAt(card, end, room);
  else placeBeside(card, beside, room);
  const away = e => !card.contains(e.target) && close(as);
  const keys = e => e.key === 'Escape' && close(as);
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', keys);
  const list = {
    card,
    people,
    close: () => {
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', keys);
      tidy([card]);
    },
  };
  card.addEventListener('click', e => {
    const row = e.target.closest('.bk-person');
    if (row?.dataset.to) give(as, scrap, list, row);
    else if (row) everyone(as, scrap, list);
    else if (e.target.closest('.bk-assign-done')) close(as);
  });
  as.shown = list;
  if (card.matches('.bk-assign-short'))
    card
      .querySelectorAll('.bk-person')
      .forEach((_, i) => foley('bubble', { note: NOTES[i % NOTES.length] }, { vol: 0.3, at: 0.05 + i * 0.1 }));
  return list;
}
// More…: everyone, where the short list was
function everyone(as, scrap, from) {
  const box = from.card.getBoundingClientRect(),
    sheet = opened(as, scrap, from.people, everyoneSheet(from.people.everyone), [box.left + 14, box.top + 20]);
  if (matchMedia('(pointer: fine)').matches) sheet.card.querySelector('input').focus({ preventScroll: true });
}
function close(as) {
  as.shown?.close();
  as.shown = null;
}

// ---- given

// The scrap given to the person of a row: a copy flies to their name (along the line drawn, when there is one), the
// list and line tidy away, and the scrap wears their tag once the store has it
async function give(as, scrap, list, row, line = null) {
  const { book } = as.sel,
    person = [...list.people.recent, ...list.people.everyone].find(p => p.to === row.dataset.to);
  if (as.sel.view === scrap.view) letGo(as.sel);
  as.shown = null;
  light(list.card, row);
  list.card.inert = true;
  const at = performance.now() + TAG_MS;
  freshTag(scrap.id, person.to, at);
  // (tidied away however the flight ends)
  flight(as.sel, scrap, row, line && line.screen(line.path.slice(scrap.to))).finally(() => {
    list.close();
    if (line) tidy([line.el]);
  });
  try {
    const answer = await assignGroup(book.dev, scrap.id, person.to);
    const had = scrap.page.groups.get(scrap.id);
    if (had) had.assigned = answer.group.assigned;
    book.groups.drawn(scrap.page);
    foley('bubble', { note: 'G5' }, { vol: 0.25, at: Math.max(0, at - performance.now()) / 1000 });
  } catch (e) {
    toast(esc(e.message));
  }
  as.people = null;
}

// ---- shared

// The box round two boxes on the screen (the frame and its bar: the list goes beside both)
const union = (a, b) =>
  DOMRect.fromRect({
    x: Math.min(a.left, b.left),
    y: Math.min(a.top, b.top),
    width: Math.max(a.right, b.right) - Math.min(a.left, b.left),
    height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
  });

// The store's people, asked again (its short list changes as people are picked)
const asked = as => (as.people = loadPeople(as.sel.book.dev));
// Things on a view's page ({ ink, scraps, texts }) when they're one whole group of an open page: { view, page, id,
// things }, else null
function wholeGroup(view, { ink = [], scraps = [], texts = [] }) {
  const page = view?.page,
    els = [...ink, ...scraps, ...texts],
    id = els[0]?.g;
  if (!page?.groups || shut(page) || !page.groups.has(id) || els.some(el => el.g !== id)) return null;
  const things = membersOf(page, id);
  return things.ink.length + things.scraps.length + things.texts.length === els.length
    ? { view, page, id, things }
    : null;
}
