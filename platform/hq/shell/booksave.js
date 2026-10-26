// What the book keeps of a page: its ink and pictures saved to the store soon after each stroke, and the tear lines
// where it grew (this browser's storage: the store keeps a page's height, not where it grew).
import { store } from '../util.js';
import { createPage, savePage } from './bookdata.js';
import { SIDE } from './bookrow.js';

// a page is saved this long after its last stroke, so a burst of writing is one save
const SAVE_MS = 600;

// A page's tear lines kept by its id (a blank page's once the store has made it)
export const keepTears = page => {
  if (!page.id) return;
  const all = store.get('book.tears', {});
  if (page.tears.length) all[page.id] = page.tears;
  else delete all[page.id];
  store.set('book.tears', all);
};

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
// The page made in the store on its first stroke (never before: no empty pages there), then its whole ink saved.
// A refusal ("This page is full...") is said on the page.
async function saveNow(book, page) {
  if (!page.id && !page.ink.length) return;
  try {
    if (!page.id) {
      const made = await createPage(book.dev, { kind: 'free', w: page.w, h: Math.min(page.h, SIDE.max) });
      Object.assign(page, { id: made.id, day: made.day });
      keepTears(page);
    }
    const scraps = page.scraps.map(({ file, x, y, w, h, tilt }) => ({ file, x, y, w, h, tilt }));
    await savePage(book.dev, { id: page.id, ink: page.ink, scraps, h: page.h });
    said(book, page, '');
  } catch (e) {
    said(book, page, e.message);
  }
}
export function said(book, page, words) {
  page.error = words;
  book.views.find(v => v.page === page)?.refuse(words);
}
