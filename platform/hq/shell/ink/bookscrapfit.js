// A scrap drawn to fit the paper on this screen. The store keeps a scrap at a readable width (notebookstack.js STACK.w),
// left of the controls on the papers the board reads on, the narrower ones aside (a phone's, the book at its least).
// Where a scrap runs under the controls at the paper's right edge here (the stack and the tool strip beside it, as
// answers keep left of them: bookui.js clearOf), HQ draws it scaled down about its top-left to end left of them, as
// Select's corner would (bookselectmath.js): its picture, the ink on it and its words alike, never narrower than LEAST.
// The fit is only drawn. The page's lists hold the fitted copies, each with the element it was drawn from as its hidden
// `fit`, and page.fits holds each fitted group's change. What's saved is at the store's scale (storedOf: one drawn,
// moved or resized here is scaled back), so no screen's paper shrinks a scrap for another. A page's scraps fit again as
// it's read, as the paper sizes and as the controls' width settles.
import { movedScrap, movedStroke } from './bookselectmath.js';
import { keyOf } from './bookgroupmath.js';
import { clearOf } from './bookui.js';
import { boxOf, slipsUnder, wordsWidth } from './notebookstack.js';

// a scrap is drawn no narrower than this to fit (an answer's least: coordinator's ink/answerspot.ts ANSWER.least)
const LEAST = 120;
// the page's lists, and the store's names for them
const LISTS = { ink: 'ink', texts: 'texts', pictures: 'scraps' };

// Scraps fitted again on each page read as the book's paper sizes and as the controls' width settles (bookui.js), each
// page drawn again where that changed them. book: bookpages.js's; el: #book.
export function mountFit(book, el) {
  const again = () => {
    for (const v of book.views)
      if (v.page.groups && fitScraps(book, v.page)) {
        v.redraw();
        book.groups.drawn(v.page);
      }
  };
  book.world.addEventListener('bk:paper', again);
  el.addEventListener('bk:controls-width', again);
}
// Whether anything hangs under a scrap (bookgroups.js .bk-under, as wide as its words): its words, saved or being typed
// (page.typed, as bookgroups.js wordsHtml shows them), its slips or an agent's asks; a scrap with none fits by its own
// width
const hangs = (page, g) =>
  !!(g.words || page.typed?.has(g.id) || slipsUnder(g.children ?? []).length || g.asks?.length);
// A page's scraps drawn to fit the paper as this screen shows it at 100%, its groups as last read or saved
// (page.groups); true when what's drawn changed. Before the paper has a size, as the store has them.
export function fitScraps(book, page) {
  const had = page.fits?.size > 0,
    back = Object.values(LISTS).map(list =>
      page[list].map(el => (page.fits?.has(el.g) ? { ...storedOf(page, el), g: el.g } : el)),
    );
  Object.values(LISTS).forEach((list, i) => page[list].splice(0, page[list].length, ...back[i]));
  page.fits = new Map();
  if (!book.size.w) return had;
  const edge = clearOf(book.desk, book.size.w);
  for (const g of page.groups.values()) {
    // (typed boxes keep their size when scaled, so a scrap with one on it can't be fitted)
    if (g.kind !== 'scrap' || g.texts.length || !g.box || !asStored(page, g)) continue;
    const wide = hangs(page, g) ? Math.max(g.box.w, wordsWidth(g.box.w)) : g.box.w,
      k = (edge - g.box.x) / wide;
    if (k >= 1 || k * wide < LEAST) continue;
    const tr = { k, ax: g.box.x, ay: g.box.y, dx: 0, dy: 0 };
    page.fits.set(g.id, tr);
    for (const list of Object.values(LISTS))
      page[list].forEach((el, i) => {
        if (el.g !== g.id) return;
        const fitted = moved(list, el, tr);
        // (not enumerable: never sent, and any copy made of it, moved or resized, is scaled back as drawn)
        Object.defineProperty(fitted, 'fit', { value: el, configurable: true });
        page[list][i] = fitted;
      });
  }
  return had || page.fits.size > 0;
}
// How much a group's scrap is scaled to fit this screen (1: as the store has it)
export const fitOf = (page, id) => page.fits?.get(id)?.k ?? 1;
// An element of the page as the store keeps it: of a fitted group nothing changed in, the one it was drawn from; of one
// changed here (moved, resized, drawn on), scaled back about the group's top-left as drawn now, so a move keeps its
// distance on the screen and the refit after the save draws it where it was left
export function storedOf(page, el) {
  const tr = page.fits?.get(el.g);
  if (!tr) return el;
  const drawn = Object.fromEntries(Object.entries(LISTS).map(([kind, l]) => [kind, page[l].filter(e => e.g === el.g)]));
  if (Object.values(drawn).every(els => els.every(e => e.fit))) return el.fit;
  const { x, y } = boxOf(drawn),
    list = Object.entries(LISTS).find(([, l]) => page[l].includes(el))[1];
  return moved(list, el, { k: 1 / tr.k, ax: x, ay: y, dx: 0, dy: 0 });
}
// An element of a list moved and scaled (words keep their size: only their place moves)
function moved(list, el, tr) {
  if (list === 'ink') return movedStroke(el, tr);
  if (list === 'scraps') return movedScrap(el, tr);
  return { ...el, x: tr.ax + (el.x - tr.ax) * tr.k, y: tr.ay + (el.y - tr.ay) * tr.k };
}
// Whether a group's elements on the page are the store's, nothing changed on this screen yet
function asStored(page, g) {
  return Object.entries(LISTS).every(([kind, list]) => {
    const keys = page[list].filter(el => el.g === g.id).map(keyOf);
    return keys.length === g.base[kind].length && keys.every((key, i) => key === g.base[kind][i]);
  });
}
