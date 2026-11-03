// node --test platform/hq/shell/ink/bookrow.test.js   (the book's page as plain numbers; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROWN_MAX,
  ROOM_PX,
  ZOOM_MAX,
  ZOOM_OUT,
  canvasPans,
  dotsShown,
  grownTo,
  pageAt,
  placeIn,
  showsBox,
  shownBox,
  unitsPans,
  unitsZoom,
  zoomAt,
  zoomWithin,
} from './bookrow.js';

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

// (a sketch page's zoom and pan)
test('a sketch page zooms in to the most, and out past its least only as far as what is drawn needs to show whole', () => {
  assert.equal(zoomWithin(9, page, view), ZOOM_MAX);
  assert.equal(zoomWithin(0.01, page, view), ZOOM_OUT, 'a page the paper nearly holds: out to the least');
  const far = { x: -3000, y: -2000, w: 9000, h: 8000 };
  assert.equal(zoomWithin(0.01, far, view), view.w / far.w, 'drawn far out: out till it all shows');
  assert.equal(zoomWithin(1.5, far, view), 1.5);
});

test('a sketch page pans any way till only an edge of what is on it is left on the paper', () => {
  const box = { x: -100, y: -50, w: 1000, h: 2000 },
    at1 = canvasPans(box, view, 1, 120);
  assert.deepEqual(at1, { x0: -100 - 455 + 120, x1: 900 - 120, y0: -50 - 700 + 120, y1: 1950 - 120 });
  const at2 = canvasPans(box, view, 2, 120);
  assert.equal(at2.x0, -100 - 227.5 + 60, 'zoomed in, the edge in page px is smaller');
});

// (every page pinch-zooms, a page of scraps too)
test("a page of scraps zooms in to the most and out to its masonry's fit, never past the paper's width", () => {
  assert.equal(unitsZoom(9, 1.2), ZOOM_MAX);
  assert.equal(unitsZoom(0.3, 1.2), 1.2, "out no further than the page's width on the paper");
  assert.equal(unitsZoom(2.5, 1.2), 2.5);
  assert.equal(unitsZoom(2, 5), 5, 'a fit past the most: the fit');
  assert.equal(unitsZoom(1.22, 1.2), 1.2, "two fingers' wobble: the fit");
});

test('a page of scraps pans across as far as it is zoomed past its width, and down to its foot', () => {
  const laid = { w: 380, h: 2000 };
  assert.deepEqual(unitsPans(laid, view, view.w / laid.w, 120), { x0: 0, x1: 0, y0: 0, y1: 2000 - 120 / (455 / 380) });
  const zoomed = unitsPans(laid, view, 2, 120);
  assert.equal(zoomed.x1, 380 - 455 / 2, 'zoomed in, across to its right side');
  assert.equal(zoomed.y1, 2000 - 60);
});

test("a pinch keeps the page's point under the fingers' middle where it is", () => {
  const at = { x: 200, y: 300 },
    pan = { x: 40, y: 60 },
    under = pageAt(pan, 1, at),
    zoomed = zoomAt(pan, 1, 2.5, at);
  assert.deepEqual(pageAt(zoomed, 2.5, at), under);
});
