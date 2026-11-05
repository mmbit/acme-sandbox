// Assigning: a scrap of the board's handed to someone invited (never an agent: the store's side, bookassign.ts). With
// the Pencil it's the grid's circle and line (bookgridgesture.js, mounted here); with a mouse or a finger, Select's bar
// has Assign while one whole scrap is picked, and an opened scrap's ⋯ has Geef aan… (bookscrapkeys.js, giveFrom), each
// opening the short list beside it (bookassignlist.js). A pick sends a copy of the scrap flying to the name (a copy
// that takes no press, as bookpaper.js's do), the list tidies away, and the scrap stays where it is, wearing the
// person's face. More… opens everyone, to scroll or search, and a pick there goes the same way. Its look:
// bookassign.css.
//
// bookselect.js mounts it, and has it fit Assign into the bar beside what's picked. A loop drawn inside an opened
// scrap is ink or Select's, never a gesture: circling and arrows there are the board's notes.
import { esc, stylesheet } from '../../util.js';
import { foley } from '../audio.js';
import { toast } from '../toast.js';
import { button } from './bookui.js';
import { icon } from '../icons.js';
import { scope, word } from './bookscope.js';
import { shut } from './booksave.js';
import { assignGroup, loadPeople } from './notebookdata.js';
import { membersOf } from './bookselectmath.js';
import { letGo } from './bookselect.js';
import { everyoneSheet, freshTag, shortList } from './bookassignlist.js';
import { light, placeBeside } from './bookcard.js';
import { cardCopy, flight, fly, tidy } from './bookassignfly.js';
import { mountGridGesture } from './bookgridgesture.js';
import { mountScrapKeys } from './bookscrapkeys.js';

// the tag pops in this long (ms) after the copy sets off: as it lands and the list has tidied away
const TAG_MS = 1600;
// the rows' pops, a note each, as they come in one by one (bookcard.css's 100 ms apart)
const NOTES = ['A5', 'C6', 'D6', 'E6', 'G6'];

// sel: bookselect.js's
export function mountAssign(sel) {
  stylesheet('shell/ink/bookassign.css');
  // (shown: the list or sheet open, { card, people, close() }; people: the store's, as last asked)
  const as = { sel, shown: null, people: null };
  mountGridGesture(sel);
  // (a scrap given from a menu: bookscrapkeys.js)
  sel.book.assign = { give: (view, gid, beside, card) => giveFrom(as, view, gid, beside, card) };
  // (the opened scrap's keys: Beantwoord, and ⋯ with Geef aan… and Scrap weggooien)
  mountScrapKeys(sel.book);
  return { fit: bar => fit(as, bar) };
}

// ---- by the mouse or a finger

// Assign in Select's bar (first, a person's icon) while one whole scrap of an open page is picked
function fit(as, bar) {
  if (scope) return;
  let b = bar.querySelector('.bk-assign-btn');
  if (!b) {
    // (an icon, as the rest of the bar)
    b = button({ icon: icon('person'), label: word('assign'), onClick: () => fromBar(as) });
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
  const frame = sel.frame.el.getBoundingClientRect(),
    bar = sel.frame.bar.getBoundingClientRect();
  listed(as, scrap, union(frame, bar));
}
// A scrap's group (gid) on a view's page given from a menu, its list beside a box on the screen; card: its card on the
// grid, the copy that flies
function giveFrom(as, view, gid, beside, card) {
  const page = view?.page;
  if (scope || !page?.groups?.has(gid) || shut(page)) return;
  listed(as, { view, page, id: gid, things: membersOf(page, gid), card }, beside);
}
// The short list beside a box
async function listed(as, scrap, beside) {
  let people;
  try {
    people = await asked(as, scrap.page);
  } catch (e) {
    return toast(esc(e.message));
  }
  opened(as, scrap, people, shortList(people.recent, people.everyone.length), beside);
}

// ---- the list and the sheet

// A card of people shown beside a box (at a point: [x, y]), the one shown before it closed; a click on a name gives
// the scrap to them, More… opens everyone. → { card, people, close() }
function opened(as, scrap, people, card, beside) {
  close(as);
  const room = as.sel.book.desk.getBoundingClientRect();
  placeBeside(card, Array.isArray(beside) ? new DOMRect(beside[0], beside[1], 0, 0) : beside, room);
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
    sheet = opened(as, scrap, from.people, everyoneSheet(from.people.everyone), [box.left - 16, box.top]);
  if (matchMedia('(pointer: fine)').matches) sheet.card.querySelector('input').focus({ preventScroll: true });
}
function close(as) {
  as.shown?.close();
  as.shown = null;
}

// ---- given

// The scrap given to the person of a row: a copy flies to their name, the list tidies away, and the scrap wears their
// tag once the store has it
async function give(as, scrap, list, row) {
  const { book } = as.sel,
    person = [...list.people.recent, ...list.people.everyone].find(p => p.to === row.dataset.to);
  if (as.sel.view === scrap.view) letGo(as.sel);
  as.shown = null;
  light(list.card, row);
  list.card.inert = true;
  const at = performance.now() + TAG_MS;
  freshTag(scrap.id, person.to, at);
  // (tidied away however the flight ends)
  const flown = scrap.card
    ? fly(cardCopy(scrap.card, scrap.view), scrap.card.getBoundingClientRect(), row, null)
    : flight(as.sel, scrap, row, null);
  flown.finally(() => list.close());
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

// The store's people for a page, asked again (its short list changes as people are picked)
const asked = (as, page) => (as.people = loadPeople(as.sel.book.dev, page.id));
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
