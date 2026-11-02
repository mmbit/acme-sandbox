// node --test platform/hq/shell/ink/notebookchapters.test.js: a page's chapter, its bookmark, and the book's order by
// chapter (notebookchapters.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapterOf, chaptersOf, inChapters, indexesIn, shownAfter } from './notebookchapters.js';

test("every page's chapter, by its kind and its book's", () => {
  for (const book of ['mine', 'project', 'invited']) {
    assert.deepEqual(chaptersOf(book), ['sketch', 'asks', 'calls']);
    assert.deepEqual(
      ['free', 'sheet', 'asks', 'call', 'advice'].map(kind => chapterOf(kind, book)),
      ['sketch', 'sketch', 'asks', 'calls', 'sketch'],
    );
  }
  assert.deepEqual(chaptersOf('round'), ['guests', 'asks', 'advice']);
  assert.deepEqual(
    ['free', 'guest', 'asks', 'advice', 'call'].map(kind => chapterOf(kind, 'round')),
    ['guests', 'guests', 'asks', 'advice', 'guests'],
  );
});

test("a book's pages in their chapters' order, each chapter's in the book's own", () => {
  const pages = [
    { id: 1, kind: 'call', pos: 0 },
    { id: 2, kind: 'free', pos: 4 },
    { id: 3, kind: 'asks', pos: 2 },
    { id: 4, kind: 'free', pos: 3 },
    { id: 5, kind: 'call', pos: 1 },
  ];
  assert.deepEqual(
    inChapters('mine', pages).map(p => p.id),
    [4, 2, 3, 1, 5],
  );
  assert.deepEqual(
    pages.map(p => p.id),
    [1, 2, 3, 4, 5],
    'the list given stays as it was',
  );
});

test("a chapter's pages by their index, and the page a book goes to when the one shown goes", () => {
  const page = (id, chapter) => ({ id, chapter });
  const book = [page(1, 'sketch'), page(2, 'sketch'), page(3, 'asks'), page(4, 'calls'), page(5, 'calls')];
  assert.deepEqual(indexesIn(book, 'calls'), [3, 4]);
  // (the id of the page shown once page id has gone)
  const after = id => {
    const pages = book.filter(p => p.id !== id);
    return pages[shownAfter(book, book[id - 1], pages)].id;
  };
  // (the next in its chapter; at the chapter's end the one before it there, never into the next tab)
  assert.equal(after(1), 2, "Sketch's first: the next sketch");
  assert.equal(after(2), 1, "Sketch's last: the sketch before, not Asks");
  assert.equal(after(5), 4, "Calls' last: the call before");
  // (a chapter left empty: the page now at its place)
  assert.equal(after(3), 4, 'Asks emptied: the page at its place');
  assert.equal(shownAfter(book, book[4], []), 0);
});
