// A blank page isn't kept once it's left: as a page shows, the notebook's other sketch pages
// that had nothing on them when last read, and still have nothing once their saves are in, are let go by the store
// (notebooktidy.ts), which judges each; the pages are read again when any went. New page tapped twice leaves one, and a
// book shut on a blank page lets it go the next time another page shows.
import { scope } from './bookscope.js';
import { saved, shut } from './booksave.js';
import { tidyPages } from './notebookdata.js';

// book: the book's pages (bookpages.js); again(): the notebook's pages read again
export async function tidy(book, again) {
  const notebook = book.notebook,
    keep = book.views[book.cur].page;
  if (scope) return;
  const left = book.views.map(v => v.page).filter(p => p !== keep && blank(p));
  if (!left.length) return;
  try {
    await Promise.all(left.map(p => saved(book, p)));
    const { gone } = await tidyPages(book.dev, notebook, keep.id);
    if (gone && book.notebook === notebook) await again();
  } catch (e) {
    console.error('[hq] The notebook’s blank pages weren’t tidied:', e);
  }
}
// (as the book saw it: a sketch page, untitled and open, with nothing written on it here since)
const blank = p => p.blank && p.kind === 'free' && !p.label && !shut(p) && !p.groups?.size && !p.timer;
