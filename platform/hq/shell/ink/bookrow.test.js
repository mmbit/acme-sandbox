// node --test platform/hq/shell/ink/bookrow.test.js   (the book's page as plain numbers; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROWN_MAX, ROOM_PX, ZOOM_MAX, dotsShown, grownTo, pageAt, placeIn, showsBox, shownBox } from './bookrow.js';

const view = { w: 455, h: 700 };
const page = { w: 455, h: 1050 };

// (the page grows every way)

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
});

test("the paper's dots ease out as the zoom shrinks them, and are gone before they'd be under a pixel", () => {
  assert.equal(dotsShown(1), 1);
  assert.equal(dotsShown(ZOOM_MAX), 1);
  assert.ok(dotsShown(0.5) > 0 && dotsShown(0.5) < dotsShown(0.7) && dotsShown(0.7) < 1);
  // (2.8 px across at a zoom of 1: bookdesk.css)
  assert.equal(dotsShown(1 / 2.8), 0);
});

test('a remembered page opens where it was left, and a page gone or none remembered opens the last', () => {
  const place = { page: 4, x: 0, y: 300 };
  assert.deepEqual(placeIn([2, 4, 'new'], place), { i: 1, at: place });
  assert.deepEqual(placeIn([2, 3], place), { i: 1, at: null });
  assert.deepEqual(placeIn([2, 3, 'new'], null), { i: 2, at: null });
});
