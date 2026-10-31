// The book opens on what the board just pinned: a note from review mode (an annotation on an artifact, a ring on HQ)
// lands on My journal's current page, and the book opened next, however it opens and whichever notebook it shows,
// slides to the newest one it hasn't shown yet. Review mode's Open the Notebook asks for the current page and its
// newest note whether shown or not. A place asked for (a card's Open in the book, a landed note's tap) wins.
import { lastShown, showGroup } from './bookgroupshow.js';
import { newestOf } from './bookpages.js';
import { loadGroups, loadPages, loadShelf } from './notebookdata.js';

let aim = null; // what the opening under way shows ('newest': the current page and its newest note; 'place': its own)
let on = null; // { pages, open }: mountNewest's
let mode = 'folded'; // (the book's, as last laid out)

// The opening asked for: before the book is opened (book.js), until it has laid out
export const aimAt = next => (aim = next);

// pages: bookpages.js's answer; open: book.js's openBook
export function mountNewest(pages, open) {
  on = { pages, open };
  mode = document.documentElement.dataset.book ?? 'folded';
  // (HQ starting with the book open is an opening too)
  if (mode !== 'folded') showNewest(pages);
  document.addEventListener('book:layout', e => {
    const opened = mode === 'folded' && e.detail.mode !== 'folded',
      asked = aim;
    mode = e.detail.mode;
    aim = null;
    if (opened && asked !== 'place') showNewest(pages, asked === 'newest');
  });
}

// Open the book at its current page, slid to the newest note pinned there (review mode's Open the Notebook): opened if
// it's shut, there at once if it's open already
export function openNewest() {
  if (mode !== 'folded') return showNewest(on.pages, true);
  aim = 'newest';
  on.open();
}
// My journal's current page's newest note from review mode (one with an anchor), slid into view when the book hasn't
// shown it yet, My journal opened at that page when the book shows another. always: shown whatever it has shown, and
// with no note there the current page at its top. A read refused leaves the book where it is, the refusal logged (a
// first opening's own refusal shows: bookpages.js openNotebook).
export async function showNewest(pages, always = false) {
  let read;
  try {
    read = await mine(pages);
  } catch (e) {
    return console.error('[hq] My Notebook’s newest note can’t be read:', e);
  }
  const { notebook, page, groups } = read;
  const pinned = groups.filter(g => g.anchor).map(g => g.id),
    id = pinned.length ? Math.max(...pinned) : null;
  if (!always && !(id > lastShown())) return;
  return id ? showGroup(pages, { page, id }) : pages.find({ page, notebook });
}
// My journal's current page and its groups as the store has them, whichever notebook the book shows: the shelf's first,
// where review mode's notes land (notebook.ts mine()). There's always one: reading a notebook's pages makes it when none
// is open (notebook.ts listPages)
async function mine(pages) {
  await pages.opened;
  const notebook = (await loadShelf(pages.dev)).shelf[0].id,
    page = newestOf((await loadPages(pages.dev, notebook)).pages);
  return { notebook, page, groups: (await loadGroups(pages.dev, page)).groups };
}
