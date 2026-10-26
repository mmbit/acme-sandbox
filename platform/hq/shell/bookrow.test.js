// node --test platform/hq/shell/bookrow.test.js   (the book's table as plain numbers; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GAP,
  GROWN_MAX,
  TILE_PX,
  clampPan,
  grownHeight,
  newPageSize,
  pageAt,
  panTo,
  placeIn,
  rowOf,
  settleX,
  showsBox,
  shownAt,
  tilesIn,
} from './bookrow.js';

const view = { w: 455, h: 700 };
const row = rowOf([
  { w: 455, h: 700 },
  { w: 455, h: 1050 },
  { w: 600, h: 700 },
]);

test("a day's pages lie side by side, the table showing between them", () => {
  assert.deepEqual(
    row.map(r => r.x),
    [0, 455 + GAP, 2 * (455 + GAP)],
  );
  assert.equal(pageAt(row, 455 + GAP / 2, 10), -1);
  assert.equal(pageAt(row, 455 + GAP + 1, 1000), 1);
  assert.equal(pageAt(row, 10, 800), -1);
});

test('the table pans past every edge, but never so far the row is lost', () => {
  const far = clampPan({ x: -5000, y: 99_999 }, row, view);
  assert.ok(far.x < 0 && far.x > -view.w, 'past the first page, some of it still on the paper');
  assert.ok(far.y > 700 && far.y < 1050, 'down past the longest page, its foot still on the paper');
  assert.deepEqual(clampPan({ x: 483, y: 120 }, row, view), { x: 483, y: 120 });
});

test('a page panned close to square comes to rest square, and one panned freely stays where it is', () => {
  assert.equal(settleX(455 + GAP + 25, row, view), 455 + GAP);
  assert.equal(settleX(200, row, view), 200);
});

test('the page shown is the one filling most of the paper', () => {
  assert.equal(shownAt(row, { x: 300, y: 0 }, view), 1);
  assert.equal(shownAt(row, { x: 100, y: 0 }, view), 0);
  assert.equal(shownAt(row, { x: -1000, y: 0 }, view), -1);
});

test('a box written on a page shows while any of it is on the paper', () => {
  const box = { x0: 100, x1: 200, y0: 900, y1: 1000 };
  assert.equal(showsBox(row[1], box, { x: row[1].x, y: 0 }, view), false, 'below the paper');
  assert.equal(showsBox(row[1], box, { x: row[1].x, y: 350 }, view), true);
  assert.equal(showsBox(row[1], box, { x: row[1].x + 150, y: 350 }, view), true, 'half of it off the left edge');
});

test('a page grows by half the paper when written near its foot, and not elsewhere', () => {
  assert.equal(grownHeight(700, 600, 700), 1050);
  assert.equal(grownHeight(700, 300, 700), 700);
  assert.equal(grownHeight(GROWN_MAX - 10, GROWN_MAX - 20, 700), GROWN_MAX);
});

test("a new page is the paper's size in whole px the store takes", () => {
  assert.deepEqual(newPageSize({ w: 455.4, h: 699.6 }), { w: 455, h: 700 });
  assert.deepEqual(newPageSize({ w: 20, h: 9000 }), { w: 100, h: 4000 });
});

test('only the strips of a long page near the paper are drawn', () => {
  assert.deepEqual(tilesIn(3000, 600, 1300), [1, 2]);
  assert.deepEqual(tilesIn(3000, -900, 100), [0]);
  assert.deepEqual(tilesIn(2 * TILE_PX + 10, 0, 99_999), [0, 1, 2]);
});

test('in the spread, the page shown faces the next across the middle, and open again it fills the book', () => {
  const pages = [
      { w: 455, h: 700 },
      { w: 455, h: 700 },
      { w: 532, h: 700 },
    ],
    spread = { w: 1064, h: 700 },
    facing = rowOf(pages, true);
  const x = panTo(facing, 0, spread, true);
  assert.equal(facing[0].x + facing[0].w - x, spread.w / 2, "the first page's right edge at the paper's middle");
  assert.equal(facing[1].x - x, spread.w / 2, 'the next page starting there');
  assert.equal(facing[2].x - panTo(facing, 2, spread, true, { right: true }), spread.w / 2, 'New page on the right');
  assert.equal(settleX(x + 30, facing, spread, true), x, 'a spread panned near facing comes to rest facing');
  const open = rowOf(pages);
  assert.equal(panTo(open, 1, view, false), open[1].x);
  assert.deepEqual(newPageSize(spread, true), { w: 532, h: 700 });
  // a page wider than half the paper: its left edge at the paper's, its head
  // and notes in view
  const narrow = { w: 332, h: 844 },
    wide = rowOf(
      [
        { w: 390, h: 844 },
        { w: 166, h: 844 },
      ],
      true,
    );
  assert.equal(panTo(wide, 0, narrow, true), wide[0].x);
  assert.equal(panTo(wide, 1, narrow, true), wide[1].x + wide[1].w - narrow.w / 2, 'a page that fits still faces');
});

test('a remembered page opens where it was left, and a page gone or none remembered opens the last', () => {
  const place = { page: 4, x: 0, y: 300 };
  assert.deepEqual(placeIn([2, 4, 'new'], place), { i: 1, at: place });
  assert.deepEqual(placeIn([2, 3], place), { i: 1, at: null });
  assert.deepEqual(placeIn([2, 3, 'new'], null), { i: 2, at: null });
});
