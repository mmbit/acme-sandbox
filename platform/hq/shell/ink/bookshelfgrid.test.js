// node --test platform/hq/shell/ink/bookshelfgrid.test.js   (the Shelf's and the page grid's maths; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridOf, moved, shelfOrder, slotAt } from './bookshelfgrid.js';

test('as many columns as fit at their least width, sharing the width out', () => {
  // a phone's book, an iPad mini's, a desktop's, a wide one
  assert.deepEqual(gridOf(250, { least: 104, gap: 14 }), { cols: 2, w: 118 });
  assert.equal(gridOf(380, { least: 104, gap: 14 }).cols, 3);
  assert.equal(gridOf(1200, { least: 104, gap: 14 }).cols, 10);
  assert.equal(gridOf(1200, { least: 104, gap: 14, most: 6 }).cols, 6);
  const { cols, w } = gridOf(380, { least: 104, gap: 14 });
  assert.equal(cols * w + (cols - 1) * 14, 380, 'the columns fill the width');
});

test('never no column: a width under the least is one column that wide', () => {
  assert.deepEqual(gridOf(60, { least: 104, gap: 14 }), { cols: 1, w: 60 });
});

test('the cell under a point: by column and row, the gap shared between neighbours', () => {
  const grid = { cols: 3, w: 100, h: 150, gap: 20 };
  assert.equal(slotAt(10, 10, grid, 7), 0);
  assert.equal(slotAt(109, 10, grid, 7), 0, 'the first half of the gap is the left cell');
  assert.equal(slotAt(111, 10, grid, 7), 1, 'the second half the right one');
  assert.equal(slotAt(250, 10, grid, 7), 2);
  assert.equal(slotAt(10, 180, grid, 7), 3, 'the second row');
  assert.equal(slotAt(-40, -40, grid, 7), 0, 'above and left of the grid: the first');
  assert.equal(slotAt(999, 10, grid, 7), 2, 'right of the grid: its row’s last column');
  assert.equal(slotAt(250, 999, grid, 7), 6, 'under the last cell: the last');
  assert.equal(slotAt(0, 0, grid, 0), -1, 'no cells: none');
  assert.equal(slotAt(10, 158, { ...grid, rowGap: 40 }, 7), 0, 'rows further apart: still the first row');
});

test('a page moved forward and back in the list', () => {
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 0, 9), ['b', 'c', 'a'], 'past the end: last');
  assert.deepEqual(moved(['a', 'b'], 5, 0), ['a', 'b'], 'nothing there: unchanged');
});

test('the Shelf: My Notebook first, then the newest first', () => {
  const shelf = shelfOrder([
    { id: 2, name: 'Round', kind: 'round', updated: '2026-10-26T09:00:00Z' },
    { id: 3, name: 'Call notes', kind: 'call', updated: '2026-10-27T09:00:00Z' },
    { id: 1, name: 'My Notebook', kind: 'mine', updated: '2026-10-01T09:00:00Z' },
    { id: 4, name: 'Anna', kind: 'invited', updated: '2026-10-26T09:00:00Z' },
  ]);
  assert.deepEqual(
    shelf.map(n => n.id),
    [1, 3, 4, 2],
  );
});
