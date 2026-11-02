// node --test platform/hq/shell/ink/bookpan.test.js   (a finger's flick on the page glides on; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';

// (what the pan reads of the browser: its listeners, the frames it asks for and the clock, played by the test)
const frames = [];
let clock = 0;
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, hidden: false };
globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = f => frames.push(f);
globalThis.cancelAnimationFrame = () => frames.splice(0);
const { panning } = await import('./bookpan.js');
const { setView } = await import('./bookview.js');

// The paper and a long page on it, a finger moving it (as on the board's iPad once a pen was used)
function paper() {
  const on = {},
    desk = {
      dataset: {},
      style: { setProperty() {} },
      addEventListener: (type, f) => (on[type] = f),
      setPointerCapture() {},
      hasPointerCapture: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      releasePointerCapture() {},
    },
    book = {
      desk,
      world: { style: {} },
      views: [{ page: { h: 20_000 }, show() {} }],
      cur: 0,
      size: { w: 800, h: 700 },
      pan: { x: 0, y: 0 },
      scale: 1,
      input: { fingerPans: () => true },
      remember() {},
    };
  panning(desk, book, { drawing: () => false });
  // (bare paper)
  const target = { closest: () => null };
  // (a finger's events: the first one down, unless id says another)
  const finger = (type, y, timeStamp, id = 1) =>
    on[type]({
      type,
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
      clientX: 300 + 100 * id,
      clientY: y,
      timeStamp,
      target,
    });
  // (the Pencil coming down)
  const pen = y =>
    on.pointerdown({ type: 'pointerdown', pointerId: 9, pointerType: 'pen', clientX: 300, clientY: y, target });
  return { book, finger, pen };
}
// Frames at a whole ms each, every 16 ms from the first: Safari's clocks
function play(first, n) {
  for (let k = 0, now = first; k < n && frames.length; k++, now += 16) frames.shift()(now);
}

test("a flick whose glide's first frame lands in the lift's own ms glides on (board, call 176)", () => {
  const { book, finger } = paper();
  finger('pointerdown', 600, 0);
  for (let t = 10; t <= 50; t += 10) finger('pointermove', 600 - 6 * t, t);
  clock = 50;
  finger('pointerup', 300, 50);
  const lifted = book.pan.y;
  play(50, 30);
  assert.ok(book.pan.y > lifted + 200, `glided on from ${lifted}: at ${book.pan.y}`);
});

test("a glide stops where the page's reach ends", () => {
  const { book, finger } = paper();
  book.views[0].page.h = 1200;
  finger('pointerdown', 600, 0);
  for (let t = 10; t <= 50; t += 10) finger('pointermove', 600 - 6 * t, t);
  clock = 50;
  finger('pointerup', 300, 50);
  play(51, 200);
  // (the page's end leaves its foot's last 120 px in sight, bookview.js FOOT_SHOWN.)
  assert.equal(book.pan.y, 1200 - 120);
  assert.equal(frames.length, 0, 'no frame asked for past the end');
});

test("a note's room dragged shorter at the page's end leaves the page there, scrolled back up but no further down", () => {
  const { book, finger } = paper(),
    page = book.views[0].page;
  page.h = 1200;
  setView(book, { pan: { x: 0, y: 2000 } });
  assert.equal(book.pan.y, 1200 - 120, "at the page's end");
  // (the last note's room dragged 500 px shorter, then let go)
  page.resizing = { id: 1, h: 100 };
  page.h = 700;
  setView(book);
  page.resizing = null;
  setView(book);
  assert.equal(book.pan.y, 1200 - 120, 'held where it was once let go');
  // (a finger's slow drag down the page, then up it)
  const drag = (from, to) => {
    finger('pointerdown', from, 0);
    finger('pointermove', to, 1000);
    clock = 1000;
    finger('pointerup', to, 2000);
    play(2000, 200);
  };
  drag(300, 200);
  assert.equal(book.pan.y, 1200 - 120, 'no further down');
  drag(200, 500);
  assert.equal(book.pan.y, 1200 - 120 - 300, 'back up by the drag');
  drag(400, 300);
  assert.equal(book.pan.y, 1200 - 120 - 300, 'nor down from there, still past the end');
  drag(200, 500);
  drag(500, 200);
  assert.equal(book.pan.y, 700 - 120, "back above it, down again only as far as the page's end now");
});

test('a pen puts a page held past its end back where the resting hand found it', () => {
  const { book, finger, pen } = paper(),
    page = book.views[0].page;
  page.h = 1200;
  setView(book, { pan: { x: 0, y: 2000 } });
  page.resizing = { id: 1, h: 100 };
  page.h = 700;
  setView(book);
  page.resizing = null;
  setView(book);
  // (a palm drifting a little down the glass, then the pen)
  finger('pointerdown', 300, 0);
  finger('pointermove', 340, 10);
  assert.equal(book.pan.y, 1200 - 120 - 40, 'moved by the drift');
  pen(400);
  assert.equal(book.pan.y, 1200 - 120, 'back where it was');
  // (and one drifting above the page's end, which lets go of the hold)
  finger('pointerdown', 300, 20);
  finger('pointermove', 900, 30);
  assert.equal(book.pan.y, 1200 - 120 - 600, 'above the end');
  pen(400);
  assert.equal(book.pan.y, 1200 - 120, 'back where it was, still held');
  finger('pointerdown', 300, 40);
  finger('pointermove', 200, 50);
  assert.equal(book.pan.y, 1200 - 120, 'no further down');
});

test('two fingers flicked glide on as one does', () => {
  const { book, finger } = paper();
  finger('pointerdown', 600, 0);
  finger('pointerdown', 600, 0, 2);
  for (let t = 10; t <= 50; t += 10) for (const id of [1, 2]) finger('pointermove', 600 - 6 * t, t, id);
  clock = 50;
  finger('pointerup', 300, 50);
  finger('pointerup', 300, 51, 2);
  const lifted = book.pan.y;
  play(51, 30);
  assert.ok(book.pan.y > lifted + 200, `glided on from ${lifted}: at ${book.pan.y}`);
});
