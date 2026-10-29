// The book's pages' overview mounted on them (bookzoom.js, its screens bookshelf.js): the notebook the book shows, the
// page it shows, what's drawn saved before the grid reads the store, and a page tapped in the grid opened.
import { mountZoom } from './bookzoom.js';
import { turn, zoom } from './bookflip.js';
import { saved } from './booksave.js';
import { viewOf } from './bookview.js';

// book: bookpages.js's. goTo(book, place), openNotebook(book, id, place): bookpages.js's, a page of the notebook shown,
// a notebook opened at a page.
export const mountFar = (book, paper, { goTo, openNotebook }) =>
  mountZoom(paper.querySelector('.bk-pages'), {
    desk: book.desk,
    dev: book.dev,
    scope: book.scope,
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
    zoom: (coming, midway, dir) => zoom(paper, { coming, midway, dir }),
    changed: level => farAt(paper, level, book),
  });

// The overview opened, stepped or closed: the book marked with its level (data-far: 'pages' or 'shelf', none on a
// page) for what puts itself away there (bookui.css), and told as book:far (Search's words, booksearch.js).
function farAt(paper, level, book) {
  const far = level === 'page' ? null : level,
    host = paper.closest('#book');
  if (far) host.dataset.far = far;
  else delete host.dataset.far;
  book.controls?.update();
  document.dispatchEvent(new CustomEvent('book:far', { detail: { level } }));
}
