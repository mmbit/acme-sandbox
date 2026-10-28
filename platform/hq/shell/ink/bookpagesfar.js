// The book's pages' overview mounted on them (bookzoom.js, its screens bookshelf.js): the notebook the book shows, the
// page it shows, what's drawn saved before the grid reads the store, and a page tapped in the grid opened.
import { mountZoom } from './bookzoom.js';
import { turn } from './bookflip.js';
import { saved } from './booksave.js';
import { viewOf } from './bookview.js';

// book: bookpages.js's. goTo(book, place), openNotebook(book, id, place): bookpages.js's, a page of the notebook shown,
// a notebook opened at a page.
export const mountFar = (book, paper, { goTo, openNotebook }) =>
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
    turn: (dir, midway) => turn(paper, { dir, midway }),
    changed: () => book.controls?.update(),
  });
