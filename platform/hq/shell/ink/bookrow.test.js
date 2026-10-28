// node --test platform/hq/shell/ink/bookrow.test.js   (the book's page as plain numbers; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROWN_MAX,
  ROOM_PX,
  TILE_PX,
  ZOOM_MAX,
  around,
  clampPan,
  clampScale,
  drawScale,
  leastScale,
  grownTo,
  newPageSize,
  pageAt,
  placeIn,
  showsBox,
  shownBox,
  spanOf,
  tileSide,
  tilesIn,
  zoomAt,
} from './bookrow.js';

const view = { w: 455, h: 700 };
const page = { w: 455, h: 1050 };

// (the page grows every way)
test('every way, the page reaches half a paper past what it holds, so the paper never shows an end', () => {
  const near = clampPan({ x: -99_999, y: -99_999 }, page, view, 1);
  assert.deepEqual(near, { x: -view.w / 2, y: -view.h / 2 }, 'up and left of its heading too');
  assert.deepEqual(clampPan({ x: 120, y: 300 }, page, view, 1), { x: 120, y: 300 });
  const far = clampPan({ x: 99_999, y: 99_999 }, page, view, 1);
  assert.equal(far.x, page.w + view.w / 2 - view.w);
  assert.equal(far.y, page.h + view.h / 2 - view.h);
  // zoomed in, the paper shows less of the page, so it pans further
  const close = clampPan({ x: 99_999, y: 99_999 }, page, view, 2);
  assert.equal(close.x, page.w + view.w / 4 - view.w / 2);
  // a page grown up and left reaches as far past its own top-left
  const grown = clampPan({ x: -99_999, y: -99_999 }, { x: -800, y: -300, w: 1255, h: 1350 }, view, 1);
  assert.deepEqual(grown, { x: -800 - view.w / 2, y: -300 - view.h / 2 });
});

test('the zoom goes out to the whole page, and half size at least, and in to the most', () => {
  assert.equal(leastScale(page, view), 0.5);
  assert.equal(leastScale({ w: 1820, h: 700 }, view), 0.25);
  assert.equal(leastScale({ x: -2000, y: 0, w: 2455, h: 700 }, view), view.w / 2455);
  assert.equal(clampScale(0.1, { w: 910, h: 700 }, view), 0.5);
  assert.equal(clampScale(9, page, view), ZOOM_MAX);
});

test('a zoom about a point keeps the page under it where it is', () => {
  const pan = { x: 100, y: 200 },
    at = { x: 150, y: 300 },
    before = pageAt(pan, 1, at),
    after = pageAt(zoomAt(pan, 1, 2.5, at), 2.5, at);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
});

test("a point on the paper is the page's px with the pan and zoom undone", () => {
  assert.deepEqual(pageAt({ x: 40, y: 60 }, 2, { x: 100, y: 10 }), { x: 90, y: 65 });
  assert.deepEqual(shownBox({ x: 40, y: 60 }, 2, view), { x0: 40, y0: 60, x1: 40 + 227.5, y1: 60 + 350 });
});

test('a box written on the page shows while any of it is on the paper', () => {
  const box = { x0: 100, x1: 200, y0: 900, y1: 1000 };
  assert.equal(showsBox(box, { x: 0, y: 0 }, 1, view), false, 'below the paper');
  assert.equal(showsBox(box, { x: 0, y: 350 }, 1, view), true);
  assert.equal(showsBox(box, { x: 150, y: 350 }, 1, view), true, 'half of it off the left edge');
  assert.equal(showsBox(box, { x: 0, y: 0 }, 0.5, { w: 455, h: 460 }), true, 'zoomed out, the paper shows more');
});

test('a page grows to hold what goes on it, every way, with room to spare, and never shrinks', () => {
  const box = { x: 0, y: 0, ...page };
  assert.deepEqual(grownTo(page, { x0: 100, y0: 100, x1: 200, y1: 300 }), box);
  assert.deepEqual(grownTo(page, { x0: 400, y0: 1000, x1: 600, y1: 1100 }), {
    ...box,
    w: 600 + ROOM_PX,
    h: 1100 + ROOM_PX,
  });
  // (up and left: the page's top-left moves, what it held stays where it is)
  assert.deepEqual(grownTo(page, { x0: -300, y0: -120, x1: 10, y1: 10 }), {
    x: -300 - ROOM_PX,
    y: -120 - ROOM_PX,
    w: page.w + 300 + ROOM_PX,
    h: page.h + 120 + ROOM_PX,
  });
  // to the most a page grows to, keeping what it held
  assert.deepEqual(grownTo(page, { x0: 0, y0: 100, x1: 99_999, y1: 110 }), { ...box, w: GROWN_MAX });
  assert.deepEqual(grownTo(page, { x0: -99_999, y0: 100, x1: 10, y1: 110 }), {
    ...box,
    x: page.w - GROWN_MAX,
    w: GROWN_MAX,
  });
  // and two of one page's boxes are one that holds both
  assert.deepEqual(spanOf({ x: -50, y: 0, w: 300, h: 900 }, page), { x: -50, y: 0, w: page.w + 50, h: page.h });
});

test("a new page is the paper's size in whole px the store takes", () => {
  assert.deepEqual(newPageSize({ w: 455.4, h: 699.6 }), { w: 455, h: 700 });
  assert.deepEqual(newPageSize({ w: 20, h: 9000 }), { w: 100, h: 4000 });
});

test('the ink is drawn for the power of two at or above the zoom, in tiles the same size on screen', () => {
  assert.equal(drawScale(1), 1);
  assert.equal(drawScale(1.2), 2);
  assert.equal(drawScale(0.6), 1);
  assert.equal(drawScale(0.4), 0.5);
  assert.equal(drawScale(4), 4);
  assert.equal(tileSide(2) * 2, TILE_PX);
});

test('only the tiles near what the paper shows are drawn, and none past the page', () => {
  const tall = { w: 455, h: 3000 };
  assert.deepEqual(tilesIn(tall, { x0: 0, y0: 600, x1: 455, y1: 1300 }, 512), [
    [0, 1],
    [0, 2],
  ]);
  assert.deepEqual(tilesIn(tall, { x0: -900, y0: -900, x1: 100, y1: 100 }, 512), [[0, 0]]);
  // (a page grown up and left: its tiles there too)
  assert.deepEqual(tilesIn({ x: -600, y: -10, w: 1055, h: 500 }, { x0: -900, y0: -900, x1: 100, y1: 100 }, 512), [
    [-2, -1],
    [-1, -1],
    [0, -1],
    [-2, 0],
    [-1, 0],
    [0, 0],
  ]);
  assert.deepEqual(tilesIn({ w: 1100, h: 600 }, { x0: 0, y0: 0, x1: 99_999, y1: 99_999 }, 512), [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ]);
  assert.deepEqual(around({ x0: 0, y0: 0, x1: 100, y1: 200 }, 0.5), { x0: -50, y0: -100, x1: 150, y1: 300 });
});

test('a remembered page opens where it was left, and a page gone or none remembered opens the last', () => {
  const place = { page: 4, x: 0, y: 300 };
  assert.deepEqual(placeIn([2, 4, 'new'], place), { i: 1, at: place });
  assert.deepEqual(placeIn([2, 3], place), { i: 1, at: null });
  assert.deepEqual(placeIn([2, 3, 'new'], null), { i: 2, at: null });
});
