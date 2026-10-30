// node --test platform/hq/shell/ink/notebookchapters.test.js: a page's chapter, its bookmark, and the book's order by
// chapter (notebookchapters.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapterOf, chaptersOf, inChapters } from './notebookchapters.js';

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
