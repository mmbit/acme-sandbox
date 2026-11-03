// The book's pages' overview mounted on them (bookzoom.js, its screens bookshelf.js): the notebook the book shows, the
// page it shows, what's drawn saved before the grid reads the store, and a page tapped in the grid opened.
import { mountZoom } from './bookzoom.js';
import { turn } from './bookflip.js';
import { saved } from './booksave.js';
import { viewOf } from './bookview.js';

// book: bookpages.js's. goTo(book, place), openNotebook(book, id, place), pagesAgain(book): bookpages.js's, a page of
// the notebook shown, a notebook opened at a page, its pages read again.
export const mountFar = (book, paper, { goTo, openNotebook, pagesAgain }) =>
  mountZoom(paper.querySelector('.bk-pages'), {
    dev: book.dev,
    notebook: () => book.notebook,
    page: () => viewOf(book)?.page.id ?? null,
    // (what's drawn and not yet saved, saved first: the grid reads the store)
    saved: () => Promise.all(book.views.map(v => saved(book, v.page))),
    // (a page tapped in the grid: of the notebook shown, or another's opened at it.)
    open: (page, id) =>
      id === book.notebook && book.views.some(v => v.page.id === page.id)
        ? goTo(book, { page: page.id })
        : openNotebook(book, id, { page: page.id }),
    // (a page archived or brought back)
    archived: () => pagesAgain(book),
    // (the Shelf, in its own window: book.js's)
    shelf: book.shelf,
    turn: (dir, midway) => turn(paper, { dir, midway }),
    changed: level => farAt(paper, level, book),
  });

// The overview opened, stepped or closed: the book marked with its level (data-far: 'pages', none on a page) for
// what puts itself away there (bookui.css).
function farAt(paper, level, book) {
  const far = level === 'page' ? null : level,
    host = paper.closest('#book');
  if (far) host.dataset.far = far;
  else delete host.dataset.far;
  book.controls?.update();
}
