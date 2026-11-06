// A change to what's on a page (its ink, pictures and typed words) as one step Undo takes back and Redo makes again:
// the eraser's rub, a shape, a selection moved, resized, cut, pasted, duplicated or deleted. Only this screen's own:
// what someone else's hand changes meanwhile (a call's agent's, another screen's, read in: booksave.js) is no step,
// and a step taken back or made again leaves it as it is. A step keeps what the change took off the page and what it
// put on (the same objects the page's lists hold: a change makes new ones rather than altering these, and a read
// keeps them, booksave.js fill), so Undo and Redo only take those off and put those back.
//
// Steps are each one page's (step.page): an opened scrap is a page of its own (bookscrapopen.js), so Undo and Redo take
// only the open scrap's steps, or on the grid the grid's, and leave every other page's where they are. A change Undo or
// Redo makes out of the opened scrap's sight is slid into it first.
//
// Every stroke and picture has an id of its own (newId), which the store keeps: a move or a resize keeps it, anything
// else a change puts on gets a new one (a piece the eraser cuts, a paste). A read-in finds the element a step holds by
// it wherever another screen moved it (booksave.js fill), so the step holds it there.
//
// book: bookpages.js's. view: the page's (bookpage.js). hooks: { lay(), changed(page), refresh(view) (its ink, pictures
// and words drawn again) }.
import { pageBox } from './bookrow.js';
import { boxOf } from './notebookstack.js';
import { slideTo } from './bookview.js';

const LISTS = ['ink', 'scraps', 'texts'];
// the room kept round a change slid into sight (screen px)
const SIGHT_PX = 48;

// A new element's id: 12 hex digits, as the store checks it (pagechecks.ts LINE_ID)
export const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
// A page's contents now: its lists copied, the objects in them shared
const contents = page => ({
  ink: page.ink.slice(),
  scraps: page.scraps.slice(),
  texts: page.texts.slice(),
  ...sides(page),
});
// (the page's box, its top-left too.)
const sides = page => ({ x: pageBox(page).x0, y: pageBox(page).y0, w: page.w, h: page.h });
const sameSides = (a, b) => ['x', 'y', 'w', 'h'].every(k => a[k] === b[k]);
const same = (a, b) =>
  sameSides(a, b) && LISTS.every(k => a[k].length === b[k].length && a[k].every((x, i) => x === b[k][i]));
// A list as it is now taken from what a step had (from) to what it has (to): what the step took off goes, what it put on
// comes back next to what it was beside, and everything else on it (someone else's since) stays where it is
export function toward(list, from, to) {
  const had = new Set(from),
    has = new Set(to),
    out = list.filter(x => has.has(x) || !had.has(x)),
    on = new Set(out);
  to.forEach((x, i) => {
    if (on.has(x) || had.has(x)) return;
    const before = to.slice(0, i).findLast(y => on.has(y));
    out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, x);
    on.add(x);
  });
  return out;
}
// What each element a tool made in place of another was made from (a stroke moved, resized or rubbed into pieces: its
// old self), so a step's replacement goes whole when someone else's change takes away either side of it (forget.
const originals = new WeakMap();
export const remade = (old, now) => originals.set(now, old);
// (the new selves that are the same element moved or resized: they keep its id)
const movedSelves = new WeakSet();
// A page's things replaced by their new selves (a map from each to its new self), each in its place in its list, and
// kept as their replacements for the step (remade)
export function swapIn(page, swap) {
  for (const [old, now] of swap) {
    remade(old, now);
    if (old.id !== undefined) now.id = old.id;
    movedSelves.add(now);
  }
  for (const k of ['ink', 'scraps', 'texts']) {
    const list = (page[k] ??= []);
    list.splice(0, list.length, ...list.map(x => swap.get(x) ?? x));
  }
}
// Every element x was made from, its original's original too, back to the first (a piece rubbed again in the same rub)
function ancestors(x) {
  const line = [];
  for (let y = originals.get(x); y; y = originals.get(y)) line.push(y);
  return line;
}
// The page taken from what a step had to what it has (its lists changed in place: the page's tiles and saves read
// them), and its box too unless someone else's change has moved it since
function put(page, from, to) {
  for (const k of LISTS) page[k].splice(0, page[k].length, ...toward(page[k], from[k], to[k]));
  if (sameSides(sides(page), from)) Object.assign(page, sides(to));
}

// The start of a change on a view's page: { end(), cancel() }. end() makes it a step (none when nothing changed, or
// only the page grew) and saves the page; cancel() puts back what it held. Between the two, change the page's lists:
// page.ink, page.scraps and page.texts (replace an object rather than alter it: Undo puts the old one back).
export function begin(book, view, hooks) {
  const page = view.page,
    before = contents(page);
  const shown = (from, to) => {
    put(page, from, to);
    hooks.refresh(view);
    hooks.changed(page);
  };
  return {
    end() {
      const after = contents(page);
      if (same(before, after)) return false;
      named(before, after);
      page.blank = false;
      hooks.changed(page);
      const held = { before, after };
      book.steps.push({
        page,
        held,
        undo: () => shown(held.after, held.before),
        redo: () => shown(held.before, held.after),
      });
      return true;
    },
    cancel: () => shown(contents(page), before),
  };
}
// What a change put on given its ids: a moved or resized self keeps its element's, and so does one that came with an id
// no other element on the page holds (a picture carried in from elsewhere); the rest get new ones (an eraser's pieces,
// a paste, a copy, a shape)
function named(before, after) {
  const had = new Set(LISTS.flatMap(k => before[k]).map(x => x.id)),
    seen = new Set();
  for (const k of ['ink', 'scraps']) {
    const was = new Set(before[k]);
    for (const x of after[k]) {
      if (was.has(x)) continue;
      const keeps = x.id !== undefined && !seen.has(x.id) && (movedSelves.has(x) || !had.has(x.id));
      if (!keeps) x.id = newId();
      seen.add(x.id);
    }
  }
}
// A change made at once: act() changes the page's lists, and it's one step
export function edit(book, view, hooks, act) {
  const change = begin(book, view, hooks);
  act(view.page);
  return change.end();
}

// Someone else's change read in (booksave.js fill), which took elements this screen holds off a page (moved, rubbed or
// deleted on another screen): the page's steps let go of each, and of what a step made it from or into, so neither
// Undo nor Redo puts back what it replaced or a copy of what replaced it. Undo's steps and Redo's are each walked from
// the one nearest now outward, so a farther step lets go of what a nearer one let go of too. A step left changing
// nothing goes, and so does the pen's drawing of a stroke that's lost (bookwrite.js dried).
export function forget(book, page, gone) {
  for (const steps of [book.steps, book.undone]) {
    const lost = new Set(gone),
      lostStrokes = new Set();
    for (const step of steps.toReversed()) {
      if (step.page !== page) continue;
      if (step.held) letGo(step.held, lost);
      else if (lost.has(step.stroke)) lostStrokes.add(step);
    }
    keep(steps, step => !lostStrokes.has(step) && (!step.held || !same(step.held.before, step.held.after)));
  }
}
// A step's lists without what's lost: an element it took off or put on goes with the other side of its replacement,
// which is lost from then on too
function letGo(held, lost) {
  const changed = LISTS.flatMap(k => {
      const a = new Set(held.before[k]),
        b = new Set(held.after[k]);
      return [...a.difference(b), ...b.difference(a)];
    }),
    linked = (x, y) => ancestors(x).includes(y) || ancestors(y).includes(x);
  let more = true;
  while (more) {
    more = false;
    for (const x of changed)
      if (!lost.has(x) && changed.some(y => lost.has(y) && linked(x, y))) {
        lost.add(x);
        more = true;
      }
  }
  for (const k of LISTS) {
    held.before[k] = held.before[k].filter(x => !lost.has(x));
    held.after[k] = held.after[k].filter(x => !lost.has(x));
  }
}

// The book's steps: a list whose new step clears what Redo could make again on its page (book.undone). Steps are {
// page, undo(), redo() } (redo: none when it can't be made again, a send that went). A step's list can be filtered in
// place only: keep(steps, test).
export function stepList(book) {
  const steps = [];
  steps.push = (...added) => {
    keep(book.undone, s => !added.some(a => samePage(a, s.page)));
    return Array.prototype.push.apply(steps, added);
  };
  return steps;
}
export function keep(steps, test) {
  for (let i = steps.length - 1; i >= 0; i--) if (!test(steps[i])) steps.splice(i, 1);
}
// The page Undo and Redo work on: the one shown, an opened scrap's own while one is open (bookview.js viewOf). A step
// with no page, or a book showing none, goes with any.
const shownPage = book => book.views?.[book.cur]?.page ?? null;
const samePage = (step, page) => !page || !step.page || step.page === page;
// The last of a list's steps on the page shown, taken off it
function lastOn(book, list) {
  const page = shownPage(book),
    i = list.findLastIndex(s => samePage(s, page));
  return i < 0 ? null : list.splice(i, 1)[0];
}
// Undo: the last step on the page shown taken back, and kept for Redo when it can be made again (else Redo has nothing
// on that page before it)
export async function undo(book) {
  const step = lastOn(book, book.steps);
  if (!step) return false;
  await inSight(book, step);
  await step.undo();
  if (step.redo) book.undone.push(step);
  else keep(book.undone, s => !samePage(step, s.page));
  return true;
}
// Redo: the last step undone on the page shown made again, and back on the steps for Undo
export async function redo(book) {
  const step = lastOn(book, book.undone);
  if (!step) return false;
  await inSight(book, step);
  await step.redo();
  Array.prototype.push.call(book.steps, step);
  return true;
}

// ---- in sight

// A step on the opened scrap whose change lies out of what its view shows: the view slid there (zoomed out if it
// must be) before it's made, so it's seen happening
async function inSight(book, step) {
  if (!step.page?.focus || shownPage(book) !== step.page || !book.size?.w) return;
  const box = changeOf(step),
    to = box && sightOf(box, book);
  if (to) await new Promise(done => slideTo(book, to, done, done));
}
// The box round what a step takes off or puts on (page px, { x, y, w, h }), or null when it doesn't say
export function changeOf(step) {
  if (step.stroke) return boxOf({ ink: [step.stroke] });
  if (!step.held) return null;
  const { before, after } = step.held,
    [ink, pictures, texts] = LISTS.map(k => [...new Set(before[k]).symmetricDifference(new Set(after[k]))]);
  return boxOf({ ink, pictures, texts });
}
// The view ({ pan, scale }) that shows a box whole on an opened scrap's paper (below the blur, left of the tools' island
// there: book.size) with room round it, centred and zoomed out as far as it must be, never in; null when the view
// shows it already
export function sightOf(box, { pan, scale, size }) {
  const w = size.w - size.right,
    h = size.h - size.top,
    at = { x: pan.x, y: pan.y + size.top / scale };
  if (box.x >= at.x && box.y >= at.y && box.x + box.w <= at.x + w / scale && box.y + box.h <= at.y + h / scale)
    return null;
  const room = (side, of) => Math.max(side / 2, side - 2 * SIGHT_PX) / (of || 1),
    s = Math.min(scale, room(w, box.w), room(h, box.h));
  const x = box.x + box.w / 2 - w / 2 / s,
    y = box.y + box.h / 2 - h / 2 / s;
  return { pan: { x, y: y - size.top / s }, scale: s };
}
