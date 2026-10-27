// What the book keeps of a page: its ink, pictures and typed words saved to the store soon after each change. (The tear
// lines where it grew went with the endless page.)
import { createPage, loadPage, savePage } from './bookdata.js';
import { merged, mergedScraps } from './pagemerge.js';
import { SIDE, spanOf } from './bookrow.js';

// a page is saved this long after its last stroke, so a burst of writing is one save
const SAVE_MS = 600;

// A blank page as the store makes it, within a new page's sides (it grows to its size at the save after)
export const newSides = page => ({
  kind: 'free',
  w: Math.min(page.w, SIDE.max),
  h: Math.min(page.h, SIDE.max),
  ...whose(page),
});

export function changed(book, page) {
  clearTimeout(page.timer);
  page.timer = setTimeout(() => save(book, page), SAVE_MS);
}
// Saves in the order they were asked for, so an older one never lands over a newer one
function save(book, page) {
  clearTimeout(page.timer);
  page.timer = 0;
  page.saving = (page.saving ?? Promise.resolve()).then(() => saveNow(book, page));
}
export const saveAll = book => book.views.forEach(v => v.page.timer && save(book, v.page));
// The page made in the store on its first stroke or words (never before: no empty pages there), then its whole ink,
// pictures and typed words saved, and its size. A refusal ("This page is full...") is said on the page.
// (In the book open, the board's or an invited person's: book.who.)
async function saveNow(book, page) {
  if (!page.id && !page.ink.length && !page.texts.length) return;
  try {
    if (!page.id) {
      const made = await createPage(book.dev, newSides(page));
      Object.assign(page, {
        id: made.id,
        day: made.day,
        updated: made.updated,
        base: { ink: [], scraps: [], texts: [] },
      });
    }
    await put(book, page);
    said(book, page, '');
  } catch (e) {
    said(book, page, e.message);
  }
}
const whose = page => (page.who ? { who: page.who } : {});
// What a page's save sends of its pictures and its typed words
const placed = scraps => scraps.map(({ file, x, y, w, h, tilt }) => ({ file, x, y, w, h, tilt }));
const typed = texts => texts.map(({ x, y, w, text, color }) => ({ x, y, w, text, color }));
const typedKey = t => JSON.stringify([t.x, t.y, t.w, t.text, t.color]);
// A page's ink, pictures and words saved since the page as this side last read or saved it (its base, at updated).
// One that changed since (someone else drawing in it: the person whose book it is, the board's other screen) is read
// again and merged, this side's strokes and theirs (pagemerge.js), drawn again and saved. (texts and w: job #19218)
async function put(book, page, again = true) {
  const body = {
    id: page.id,
    ink: page.ink,
    scraps: placed(page.scraps),
    texts: typed(page.texts),
    // (the page's box: its top-left too.)
    x: page.x,
    y: page.y,
    w: page.w,
    h: page.h,
    since: page.updated,
    ...whose(page),
  };
  const sent = body.ink.slice(); // (the page's ink goes on growing while the request is out: the base is what was sent)
  try {
    const saved = await savePage(book.dev, body);
    page.updated = saved.updated;
    page.base = { ink: sent, scraps: body.scraps, texts: body.texts };
  } catch (e) {
    if (e.status !== 409 || !again) throw e;
    mergeIn(book, page, await loadPage(book.dev, page.id, page.who));
    return put(book, page, false);
  }
}
// The page as the store has it now (now) merged into this side's, drawn again with its typed words (the boxes made
// again unless one is being typed in: its save merges again). (company: mergeIn and its boxes job #19916, not upstream
// yet)
function mergeIn(book, page, now) {
  const base = page.base ?? { ink: [], scraps: [], texts: [] };
  page.ink.splice(0, page.ink.length, ...merged(base.ink, page.ink, now.ink));
  page.scraps = mergedScraps(base.scraps, page.scraps, now.scraps);
  page.texts.splice(0, page.texts.length, ...merged(base.texts, page.texts, now.texts, typedKey));
  Object.assign(page, {
    ...spanOf(page, now),
    updated: now.updated,
    base: { ink: now.ink, scraps: now.scraps, texts: typed(now.texts) },
  });
  const view = book.views.find(v => v.page === page);
  view?.redraw();
  if (view && !book.tools?.editing()) book.tools?.added(view);
}
// A page the store wrote to while it's open (an agent's answer typed under the board's question: the coordinator's
// booktyped.ts), read again once any save under way is done and merged in as a refused save is; settled once it is.
export function readAgain(book, page) {
  return (page.saving = (page.saving ?? Promise.resolve())
    .then(async () => {
      const now = await loadPage(book.dev, page.id, page.who);
      if (now.updated !== page.updated) mergeIn(book, page, now);
    })
    .catch(e => said(book, page, e.message)));
}
// A page read whole: what its next save merges from (put).
export const readAt = (page, full) =>
  Object.assign(page, {
    updated: full.updated,
    base: { ink: full.ink.slice(), scraps: placed(full.scraps), texts: typed(full.texts) },
  });
export function said(book, page, words) {
  page.error = words;
  book.views.find(v => v.page === page)?.refuse(words);
}
