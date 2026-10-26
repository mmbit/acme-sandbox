// What the book keeps of a page: its ink and pictures saved to the store soon after each stroke, and the tear lines
// where it grew (this browser's storage: the store keeps a page's height, not where it grew).
import { store } from '../util.js';
import { createPage, loadPage, savePage } from './bookdata.js';
import { merged, mergedScraps } from './pagemerge.js';
import { SIDE, newPageSize } from './bookrow.js';

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

// A page as the book keeps it while it shows: its summary, its ink once read, and its tear lines (who: the book it's
// in, an invited person's or null for the board's own, as it was when read.)
export const recordOf = (s, who = null) => ({
  ...s,
  who,
  ink: null,
  scraps: [],
  tears: store.get('book.tears', {})[s.id] ?? [],
  error: '',
});
// The day's first free page, waiting blank at the end of today's row
export const blankPage = book => ({
  id: null,
  who: book.who,
  blank: true,
  day: book.today,
  kind: 'free',
  owner: null,
  label: '',
  ...newPageSize(book.size, book.facing),
  ink: [],
  scraps: [],
  tears: [],
  error: '',
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
// The page made in the store on its first stroke (never before: no empty pages there), then its whole ink saved.
// A refusal ("This page is full...") is said on the page. (In the book open, the board's or an invited person's:
// book.who.)
async function saveNow(book, page) {
  if (!page.id && !page.ink.length) return;
  try {
    if (!page.id) {
      const made = await createPage(book.dev, {
        kind: 'free',
        w: page.w,
        h: Math.min(page.h, SIDE.max),
        ...whose(page),
      });
      Object.assign(page, { id: made.id, day: made.day, updated: made.updated, base: { ink: [], scraps: [] } });
      keepTears(page);
    }
    await put(book, page);
    said(book, page, '');
  } catch (e) {
    said(book, page, e.message);
  }
}
const whose = page => (page.who ? { who: page.who } : {});
// What a page's save sends of its pictures
const placed = scraps => scraps.map(({ file, x, y, w, h, tilt }) => ({ file, x, y, w, h, tilt }));
// A page's ink and pictures saved since the page as this side last read or saved it (its base, at updated). One that
// changed since (someone else drawing in it: the person whose book it is, the board's other screen) is read again and
// merged, this side's strokes and theirs (pagemerge.js), drawn again and saved.
async function put(book, page, again = true) {
  const body = {
    id: page.id,
    ink: page.ink,
    scraps: placed(page.scraps),
    h: page.h,
    since: page.updated,
    ...whose(page),
  };
  const sent = body.ink.slice(); // (the page's ink goes on growing while the request is out: the base is what was sent)
  try {
    const saved = await savePage(book.dev, body);
    page.updated = saved.updated;
    page.base = { ink: sent, scraps: body.scraps };
  } catch (e) {
    if (e.status !== 409 || !again) throw e;
    const now = await loadPage(book.dev, page.id, page.who),
      base = page.base ?? { ink: [], scraps: [] };
    page.ink.splice(0, page.ink.length, ...merged(base.ink, page.ink, now.ink));
    page.scraps = mergedScraps(base.scraps, page.scraps, now.scraps);
    Object.assign(page, {
      h: Math.max(page.h, now.h),
      updated: now.updated,
      base: { ink: now.ink, scraps: now.scraps },
    });
    book.views.find(v => v.page === page)?.redraw();
    return put(book, page, false);
  }
}
// A page read whole: what its next save merges from (put).
export const readAt = (page, full) =>
  Object.assign(page, { updated: full.updated, base: { ink: full.ink.slice(), scraps: placed(full.scraps) } });
export function said(book, page, words) {
  page.error = words;
  book.views.find(v => v.page === page)?.refuse(words);
}
