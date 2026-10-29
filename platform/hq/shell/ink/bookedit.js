// A change to what's on a page (its ink, pictures and typed words) as one step Undo takes back and Redo makes again:
// the eraser's rub, a shape, a selection moved, resized, cut, pasted, duplicated or deleted, and what a call's agent
// changed (arrived). What the page held is
// kept as it was before and as it is after (lists of the same objects: a change makes new ones rather than altering
// these), so Undo and Redo only put a list back.
//
// book: bookpages.js's. view: the page's (bookpage.js). hooks: { lay(), changed(page), refresh(view) (its ink, pictures
// and words drawn again) }.
import { pageBox } from './bookrow.js';

// A page's contents now: its lists copied, the objects in them shared
const contents = page => ({
  ink: page.ink.slice(),
  scraps: page.scraps.slice(),
  texts: page.texts.slice(),
  ...sides(page),
});
// (the page's box, its top-left too.)
const sides = page => ({ x: pageBox(page).x0, y: pageBox(page).y0, w: page.w, h: page.h });
const same = (a, b) =>
  ['x', 'y', 'w', 'h'].every(k => a[k] === b[k]) &&
  ['ink', 'scraps', 'texts'].every(k => a[k].length === b[k].length && a[k].every((x, i) => x === b[k][i]));
// The page made to hold what it held then (its lists changed in place: the page's tiles and saves read them)
function put(page, held) {
  page.ink.splice(0, page.ink.length, ...held.ink);
  page.scraps.splice(0, page.scraps.length, ...held.scraps);
  page.texts.splice(0, page.texts.length, ...held.texts);
  Object.assign(page, sides(held));
}

// The start of a change on a view's page: { end(), cancel() }. end() makes it a step (none when nothing changed, or
// only the page grew) and saves the page; cancel() puts back what it held. Between the two, change the page's lists:
// page.ink, page.scraps and page.texts (replace an object rather than alter it: Undo puts the old one back).
export function begin(book, view, hooks) {
  const page = view.page,
    before = contents(page);
  const shown = held => {
    put(page, held);
    hooks.refresh(view);
    hooks.changed(page);
  };
  return {
    end() {
      const after = contents(page);
      if (same(before, after)) return false;
      page.blank = false;
      hooks.changed(page);
      book.steps.push({ page, undo: () => shown(before), redo: () => shown(after) });
      return true;
    },
    cancel: () => shown(before),
  };
}
// A change made at once: act() changes the page's lists, and it's one step
export function edit(book, view, hooks, act) {
  const change = begin(book, view, hooks);
  act(view.page);
  return change.end();
}

// A change that came from someone else's hand through the store (a call's agent's: booksave.js) as one step of this
// screen's, so Undo takes it back and Redo makes it again as the board's own are: read() puts the page's lists as the
// store has them now. Its groups the hand deleted are kept as this screen's deleted ones (page.gone), so Undo putting
// their elements back restores them, and a scrap's words it changed go back as typed. hooks: { changed(page),
// refresh(page) (drawn again), words(id, text) }
export function arrived(book, page, hooks, read) {
  const before = { ...contents(page), words: wordsOf(page) },
    had = page.groups;
  read();
  const after = { ...contents(page), words: wordsOf(page) };
  for (const [id, g] of had ?? []) if (!page.groups.has(id)) page.gone.set(id, g);
  // (read again, every element is a new object: compared by what they hold, an answer clipped on is no step)
  const held = h => JSON.stringify([h.ink, h.scraps, h.texts, [...h.words]]);
  if (held(before) === held(after)) return false;
  const shown = (to, was) => {
    put(page, to);
    for (const [id, w] of to.words) if (was.words.has(id) && was.words.get(id) !== w) hooks.words(id, w);
    hooks.refresh(page);
    hooks.changed(page);
  };
  book.steps.push({ page, undo: () => shown(before, after), redo: () => shown(after, before) });
  return true;
}
const wordsOf = page => new Map([...(page.groups ?? new Map()).values()].map(g => [g.id, g.words]));

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
