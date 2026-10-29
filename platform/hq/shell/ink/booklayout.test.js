// node --test platform/hq/shell/ink/booklayout.test.js   (the book's layout per shape, its drags and what's remembered)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, shapeOf, initial, released, pulled, recall, keep, EDGE } from './booklayout.js';

const MINI = [1133, 744],
  MINI_PORTRAIT = [744, 1133],
  DESKTOP = [1440, 900],
  HALF = [560, 744],
  PHONE = [390, 844];
const widths = l => [l.page, l.edge, l.book];

// (the rail's column gone, its controls float over the paper)
test("an iPad mini in landscape: the page 620, the cover's edge 12, the book 501, open by default", () => {
  const l = layout(...MINI, initial(shapeOf(...MINI)));
  assert.equal(l.mode, 'open');
  assert.deepEqual(widths(l), [620, 12, 501]);
  assert.equal(l.room, 513);
});

test('a desktop: the book a column of at most 520 on the right, open by default; the page takes the rest', () => {
  const l = layout(...DESKTOP, initial(shapeOf(...DESKTOP)));
  assert.equal(shapeOf(...DESKTOP), 'wide');
  assert.deepEqual(widths(l), [908, 12, 520]);
});

test('folded, on every shape: the page takes the whole screen, the book none of it (its pull tab lies over the page)', () => {
  for (const size of [MINI, MINI_PORTRAIT, DESKTOP, HALF, PHONE]) {
    const l = layout(...size, { mode: 'folded', book: null });
    assert.deepEqual(widths(l), [size[0], 0, 0]);
    assert.equal(l.room, 0);
  }
});

// (beside HQ's page an upright iPad mini's book is 325 px: an answer there would be a column of 17 characters)
test('portrait and half a split screen start folded; portrait opens as the spread, over HQ at its whole width', () => {
  for (const size of [MINI_PORTRAIT, HALF]) assert.equal(initial(shapeOf(...size)).mode, 'folded');
  const l = layout(...MINI_PORTRAIT, { mode: 'open', book: null });
  assert.equal(l.mode, 'spread');
  assert.equal(l.book, MINI_PORTRAIT[0] - EDGE);
  assert.equal(l.page, MINI_PORTRAIT[0]);
  assert.equal(l.room, 0);
});

test("in portrait the cover's edge drawn right still lays the book beside the page, at the width it was let go", () => {
  const beside = released(...MINI_PORTRAIT, { mode: 'open', book: null }, 400);
  assert.deepEqual(beside, { mode: 'open', book: 332 });
  assert.deepEqual(widths(layout(...MINI_PORTRAIT, beside)), [400, EDGE, 332]);
});

// (HQ's page never under 320 beside the book)
test('half a split screen has no room for a phone-wide HQ beside the book: open, it is the spread', () => {
  assert.equal(layout(...HALF, { mode: 'open', book: null }).mode, 'spread');
});

test('two-thirds of a split screen sits beside the page, open, as in landscape', () => {
  const l = layout(755, 744, initial(shapeOf(755, 744)));
  assert.equal(l.mode, 'open');
  assert.equal(l.page + l.edge + l.book, 755);
});

test('a phone has no room for a page beside the book: open, it is the spread, over HQ at its whole width', () => {
  const l = layout(...PHONE, { mode: 'open', book: null });
  assert.equal(l.mode, 'spread');
  assert.equal(l.book, PHONE[0] - EDGE);
  assert.equal(l.page, PHONE[0]);
  assert.equal(l.room, 0);
});

test("the spread covers the screen, its cover's edge at the left, and the page keeps its open width under it", () => {
  const l = layout(...MINI, { mode: 'spread', book: null });
  assert.equal(l.edge + l.book, 1133);
  assert.equal(l.room, 513);
  assert.equal(l.page, 620);
});

// (the cover's edge only resizes)
test("the cover's edge let go stays where it was let go, at any width that leaves HQ a phone-wide page", () => {
  const open = { mode: 'open', book: null };
  assert.deepEqual(released(...MINI, open, -40), { mode: 'open', book: 541 });
  // past the middle of the screen: still where it was let go, HQ 360 px beside it
  const wide = released(...MINI, open, -260);
  assert.deepEqual(wide, { mode: 'open', book: 761 });
  assert.deepEqual(widths(layout(...MINI, wide)), [360, EDGE, 761]);
  assert.deepEqual(released(...MINI, open, 160), { mode: 'open', book: 341 });
});

test("the cover's edge never closes the book: dragged right past drawing room it stops at 320; too far left it lies over HQ", () => {
  const open = { mode: 'open', book: 515 };
  assert.deepEqual(released(...MINI, open, 260), { mode: 'open', book: 320 });
  assert.deepEqual(released(...MINI, open, 900), { mode: 'open', book: 320 });
  assert.equal(released(...MINI, open, -320).mode, 'spread');
});

test('a width the board gave the book stays within the screen: never under 320, never leaving HQ under 320', () => {
  assert.equal(layout(...MINI, { mode: 'open', book: 100 }).book, 320);
  assert.equal(layout(...MINI, { mode: 'open', book: 2000 }).book, 801);
});

test("from the spread, the cover's edge drawn right brings HQ's page back beside it, never closing the book", () => {
  const spread = { mode: 'spread', book: 515 };
  assert.deepEqual(released(...MINI, spread, 500), { mode: 'open', book: 621 });
  assert.equal(released(...MINI, spread, 200).mode, 'spread');
  assert.deepEqual(released(...MINI, spread, 1100), { mode: 'open', book: 320 });
});

test('the pull tab drawn left opens the book at the width it had, once drawn a third of it or flicked; else it stays shut', () => {
  const shut = { mode: 'folded', book: 515 };
  assert.deepEqual(pulled(...MINI, shut, -200, 0), { mode: 'open', book: 515 });
  assert.deepEqual(pulled(...MINI, shut, -100, 0), shut);
  assert.deepEqual(pulled(...MINI, shut, -30, -0.8), { mode: 'open', book: 515 });
  assert.deepEqual(pulled(...MINI, shut, -300, 0.8), shut);
  // (a phone: it opens over HQ)
  assert.equal(layout(...PHONE, pulled(...PHONE, { mode: 'folded', book: null }, -200, 0)).mode, 'spread');
});

test('the pull tab of the open book drawn right a third of its width, or flicked right, closes it; else it stays open', () => {
  const open = { mode: 'open', book: 515 };
  assert.deepEqual(pulled(...MINI, open, 200, 0), { mode: 'folded', book: 515 });
  assert.deepEqual(pulled(...MINI, open, 100, 0), open);
  assert.deepEqual(pulled(...MINI, open, 20, 0.9), { mode: 'folded', book: 515 });
  assert.deepEqual(pulled(...MINI, open, 300, -0.9), open);
  assert.deepEqual(pulled(...PHONE, { mode: 'spread', book: null }, 200, 0).mode, 'folded');
});

test('remembered per shape: open or folded and the width, apart for landscape and portrait', () => {
  const kept = new Map(),
    storage = { get: (k, d) => (kept.has(k) ? kept.get(k) : d), set: (k, v) => kept.set(k, v) };
  assert.deepEqual(recall(storage, 'landscape'), { mode: 'open', book: null });
  keep(storage, 'landscape', { mode: 'folded', book: 515 });
  keep(storage, 'portrait', { mode: 'open', book: null });
  assert.deepEqual(recall(storage, 'landscape'), { mode: 'folded', book: 515 });
  assert.deepEqual(recall(storage, 'portrait'), { mode: 'open', book: null });
  assert.deepEqual(recall(storage, 'wide'), { mode: 'open', book: null });
  kept.set('book.narrow', { mode: 'sideways' });
  assert.deepEqual(recall(storage, 'narrow'), { mode: 'folded', book: null });
});
