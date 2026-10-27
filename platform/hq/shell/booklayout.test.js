// node --test platform/hq/shell/booklayout.test.js   (the book's layout per shape, its drags and what's remembered)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, shapeOf, initial, released, pulled, recall, keep, SPINE } from './booklayout.js';

const MINI = [1133, 744],
  MINI_PORTRAIT = [744, 1133],
  DESKTOP = [1440, 900],
  HALF = [560, 744],
  PHONE = [390, 844];
const widths = l => [l.page, l.spine, l.book];

// (the rail's column gone, its controls float over the paper)
test('an iPad mini in landscape: the page 620, the spine 12, the book 501, open by default', () => {
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

test('folded, on every shape: the page takes the whole screen, the book none of it (its lip lies over the page)', () => {
  for (const size of [MINI, MINI_PORTRAIT, DESKTOP, HALF, PHONE]) {
    const l = layout(...size, { mode: 'folded', book: null });
    assert.deepEqual(widths(l), [size[0], 0, 0]);
    assert.equal(l.room, 0);
  }
});

test('portrait and half a split screen start folded; portrait opens beside the page, which narrows', () => {
  for (const size of [MINI_PORTRAIT, HALF]) assert.equal(initial(shapeOf(...size)).mode, 'folded');
  const l = layout(...MINI_PORTRAIT, { mode: 'open', book: null });
  assert.equal(l.mode, 'open');
  assert.deepEqual(widths(l), [407, 12, 325]);
});

// (HQ's page never under 320 beside the book)
test('half a split screen has no room for a phone-wide HQ beside the book: open, it is the spread', () => {
  assert.equal(layout(...HALF, { mode: 'open', book: null }).mode, 'spread');
});

test('two-thirds of a split screen sits beside the page, open, as in landscape', () => {
  const l = layout(755, 744, initial(shapeOf(755, 744)));
  assert.equal(l.mode, 'open');
  assert.equal(l.page + l.spine + l.book, 755);
});

test('a phone has no room for a page beside the book: open, it is the spread, over HQ at its whole width', () => {
  const l = layout(...PHONE, { mode: 'open', book: null });
  assert.equal(l.mode, 'spread');
  assert.equal(l.book, PHONE[0] - SPINE);
  assert.equal(l.page, PHONE[0]);
  assert.equal(l.room, 0);
});

test('the spread covers the screen, its spine at the left edge, and the page keeps its open width under it', () => {
  const l = layout(...MINI, { mode: 'spread', book: null });
  assert.equal(l.spine + l.book, 1133);
  assert.equal(l.room, 513);
  assert.equal(l.page, 620);
});

// (the book stays where it's let go)
test('the spine let go stays where it was let go, at any width that leaves HQ a phone-wide page', () => {
  const open = { mode: 'open', book: null };
  assert.deepEqual(released(...MINI, open, -40, 0), { mode: 'open', book: 541 });
  // past the middle of the screen: still where it was let go, HQ 360 px beside it
  const wide = released(...MINI, open, -260, 0);
  assert.deepEqual(wide, { mode: 'open', book: 761 });
  assert.deepEqual(widths(layout(...MINI, wide)), [360, SPINE, 761]);
  // past the middle of the book: narrower, never folded while there's room to draw
  assert.deepEqual(released(...MINI, open, 160, 0), { mode: 'open', book: 341 });
});

test('the spine let go with the paper too narrow to draw on folds it; with HQ too narrow it spreads', () => {
  const open = { mode: 'open', book: 515 };
  assert.deepEqual(released(...MINI, open, 260, 0), { mode: 'folded', book: 515 });
  assert.equal(released(...MINI, open, -320, 0).mode, 'spread');
});

test('a flick still folds the book or spreads it, wherever it is', () => {
  const open = { mode: 'open', book: null };
  assert.equal(released(...MINI, open, 40, 0.9).mode, 'folded');
  assert.equal(released(...MINI, open, -40, -0.9).mode, 'spread');
});

test('a width the board gave the book stays within the screen: never under 320, never leaving HQ under 320', () => {
  assert.equal(layout(...MINI, { mode: 'open', book: 100 }).book, 320);
  assert.equal(layout(...MINI, { mode: 'open', book: 2000 }).book, 801);
});

test('from the spread, a flick right brings the page back at the width it had; a drag stays where it was let go', () => {
  const spread = { mode: 'spread', book: 515 };
  assert.deepEqual(released(...MINI, spread, 40, 0.8), { mode: 'open', book: 515 });
  assert.deepEqual(released(...MINI, spread, 500, 0), { mode: 'open', book: 621 });
  assert.equal(released(...MINI, spread, 200, 0).mode, 'spread');
  assert.equal(released(...MINI, spread, 900, 0).mode, 'folded');
});

test('the lip pulled left stays where it was let go; too little to draw on, or flicked back, it folds again', () => {
  const folded = { mode: 'folded', book: null };
  assert.deepEqual(pulled(...MINI, folded, -580, 0), { mode: 'open', book: 568 });
  assert.equal(pulled(...MINI, folded, -250, 0).mode, 'folded');
  assert.equal(pulled(...MINI, folded, -40, -0.8).mode, 'open');
  assert.equal(pulled(...MINI, folded, -400, 0.8).mode, 'folded');
  assert.equal(pulled(...MINI, folded, -900, 0).mode, 'spread');
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
