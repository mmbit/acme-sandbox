// node --test platform/hq/shell/booklayout.test.js   (the book's layout per shape, its drags and what's remembered)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, shapeOf, initial, released, pulled, recall, keep, RAIL, SPINE } from './booklayout.js';

const MINI = [1133, 744],
  MINI_PORTRAIT = [744, 1133],
  DESKTOP = [1440, 900],
  HALF = [560, 744],
  PHONE = [390, 844];
const widths = l => [l.page, l.spine, l.book, l.rail];

test('an iPad mini in landscape: the page 620, the spine 10, the book 455, the rail 48, open by default', () => {
  const l = layout(...MINI, initial(shapeOf(...MINI)));
  assert.equal(l.mode, 'open');
  assert.deepEqual(widths(l), [620, 10, 455, 48]);
  assert.equal(l.room, 513);
});

test('a desktop: the book a column of at most 480 on the right, open by default; the page takes the rest', () => {
  const l = layout(...DESKTOP, initial(shapeOf(...DESKTOP)));
  assert.equal(shapeOf(...DESKTOP), 'wide');
  assert.deepEqual(widths(l), [902, 10, 480, 48]);
});

test('folded, on every shape: the page takes the whole screen, the book none of it (its lip lies over the page)', () => {
  for (const size of [MINI, MINI_PORTRAIT, DESKTOP, HALF, PHONE]) {
    const l = layout(...size, { mode: 'folded', book: null });
    assert.deepEqual(widths(l), [size[0], 0, 0, 0]);
    assert.equal(l.room, 0);
  }
});

test('portrait and half a split screen start folded, and open beside the page, which narrows', () => {
  for (const size of [MINI_PORTRAIT, HALF]) {
    const shape = shapeOf(...size);
    assert.equal(initial(shape).mode, 'folded');
    const l = layout(...size, { mode: 'open', book: null });
    assert.equal(l.mode, 'open');
    assert.equal(l.page + l.spine + l.book + l.rail, size[0]);
    assert.ok(l.page >= 200, `${shape}: a page of ${l.page}`);
  }
  assert.deepEqual(widths(layout(...MINI_PORTRAIT, { mode: 'open', book: null })), [386, 10, 300, 48]);
});

test('two-thirds of a split screen sits beside the page, open, as in landscape', () => {
  const l = layout(755, 744, initial(shapeOf(755, 744)));
  assert.equal(l.mode, 'open');
  assert.equal(l.page + l.spine + l.book + l.rail, 755);
});

test('a phone has no room for a page beside the book: open, it is the spread, over HQ at its whole width', () => {
  const l = layout(...PHONE, { mode: 'open', book: null });
  assert.equal(l.mode, 'spread');
  assert.equal(l.book, PHONE[0] - RAIL);
  assert.equal(l.page, PHONE[0]);
  assert.equal(l.room, 0);
});

test('the spread covers the screen with the rail, and the page keeps its open width under it', () => {
  const l = layout(...MINI, { mode: 'spread', book: null });
  assert.equal(l.book + l.rail, 1133);
  assert.equal(l.room, 513);
  assert.equal(l.page, 620);
});

// (the lip and facing)
test("the spread's paper holds two facing pages only where each is at least 300 wide; a phone's is one page", () => {
  const facing = size => layout(...size, { mode: 'spread', book: null }).facing;
  assert.equal(layout(...PHONE, { mode: 'open', book: null }).facing, false);
  assert.equal(facing(PHONE), false);
  assert.equal(facing(HALF), false);
  assert.equal(facing(MINI_PORTRAIT), true);
  assert.equal(facing(MINI), true);
  assert.equal(facing(DESKTOP), true);
  assert.equal(layout(...MINI, { mode: 'open', book: null }).facing, false);
});

test('the spine let go: a flick or past half the book folds it, past half the screen spreads it, else a new width', () => {
  const open = { mode: 'open', book: null };
  assert.equal(released(...MINI, open, 40, 0.9).mode, 'folded');
  assert.equal(released(...MINI, open, 240, 0).mode, 'folded');
  assert.equal(released(...MINI, open, -120, -0.2).mode, 'spread');
  const wider = released(...MINI, open, -60, 0);
  assert.deepEqual(wider, { mode: 'open', book: 515 });
  assert.deepEqual(widths(layout(...MINI, wider)), [560, SPINE, 515, RAIL]);
});

test('a width the board gave the book stays within the screen: never under 300, never past half', () => {
  assert.equal(layout(...MINI, { mode: 'open', book: 100 }).book, 300);
  assert.equal(layout(...MINI, { mode: 'open', book: 2000 }).book, 532);
});

test('from the spread, a flick right or a drag past a quarter brings the page back at the width it had', () => {
  const spread = { mode: 'spread', book: 515 };
  assert.deepEqual(released(...MINI, spread, 40, 0.8), { mode: 'open', book: 515 });
  assert.deepEqual(released(...MINI, spread, 300, 0), { mode: 'open', book: 515 });
  assert.equal(released(...MINI, spread, 100, 0).mode, 'spread');
});

test('the lip pulled left past a third of the book, or flicked, brings the book back', () => {
  const folded = { mode: 'folded', book: null };
  assert.equal(pulled(...MINI, folded, -160, 0).mode, 'open');
  assert.equal(pulled(...MINI, folded, -40, -0.8).mode, 'open');
  assert.equal(pulled(...MINI, folded, -40, 0).mode, 'folded');
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
