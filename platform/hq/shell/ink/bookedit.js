// A change to what's on a page (its ink, pictures and typed words) as one step Undo takes back and Redo makes again:
// the eraser's rub, a shape, a selection moved, resized, cut, pasted, duplicated or deleted. Only this screen's own:
// what someone else's hand changes meanwhile (a call's agent's, another screen's, read in: booksave.js) is no step,
// and a step taken back or made again leaves it as it is. A step keeps what the change took off the page and what it
// put on (the same objects the page's lists hold: a change makes new ones rather than altering these, and a read
// keeps them, booksave.js fill), so Undo and Redo only take those off and put those back.
//
// book: bookpages.js's. view: the page's (bookpage.js). hooks: { lay(), changed(page), refresh(view) (its ink, pictures
// and words drawn again) }.
import { pageBox } from './bookrow.js';

const LISTS = ['ink', 'scraps', 'texts'];
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
// A page's things replaced by their new selves (a map from each to its new self), each in its place in its list, and
// kept as their replacements for the step (remade)
export function swapIn(page, swap) {
  for (const [old, now] of swap) remade(old, now);
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

// The book's steps: a list whose new step clears what Redo could make again (book.undone). Steps are { undo(), redo()
// } (redo: none when it can't be made again, a send that went). A step's list can be filtered in place only:
// keep(steps, test).
export function stepList(book) {
  const steps = [];
  steps.push = (...added) => {
    book.undone = [];
    return Array.prototype.push.apply(steps, added);
  };
  return steps;
}
export function keep(steps, test) {
  for (let i = steps.length - 1; i >= 0; i--) if (!test(steps[i])) steps.splice(i, 1);
}
// Undo: the last step taken back, and kept for Redo when it can be made again (else Redo has nothing before it)
export async function undo(book) {
  const step = book.steps.pop();
  if (!step) return false;
  await step.undo();
  if (step.redo) book.undone.push(step);
  else book.undone = [];
  return true;
}
// Redo: the last step undone made again, and back on the steps for Undo
export async function redo(book) {
  const step = book.undone.pop();
  if (!step) return false;
  await step.redo();
  Array.prototype.push.call(book.steps, step);
  return true;
}
