// node --test platform/hq/shell/booksheetlay.test.js   (where a sheet page's notes lie).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAR_PX, laidOut, takenBoxes } from './booksheetlay.js';

const column = { x0: 12, x1: 430 };
// a line of handwriting across the page at y, x from 40 to 400
const writing = (y, size = 4) => ({ size, points: Array.from({ length: 30 }, (_, i) => [40 + i * 12, y + (i % 3)]) });
const ys = out => [...out.values()].map(p => p.y);

test("writing's boxes hug its line: a ring's empty middle is free paper", () => {
  const ring = {
    size: 4,
    points: Array.from({ length: 64 }, (_, i) => [200 + 100 * Math.cos(i / 10), 300 + 100 * Math.sin(i / 10)]),
  };
  const boxes = takenBoxes([ring]);
  assert.ok(boxes.length > 4);
  assert.ok(!boxes.some(b => b.x0 < 200 && b.x1 > 200 && b.y0 < 300 && b.y1 > 300), 'the middle is taken');
  assert.deepEqual(takenBoxes([], [{ x: 10, y: 20, w: 100, h: 50 }]), [
    { x0: 10 - CLEAR_PX, y0: 20 - CLEAR_PX, x1: 110 + CLEAR_PX, y1: 70 + CLEAR_PX },
  ]);
});

test('notes on bare paper lie where the flow puts them', () => {
  const notes = [
    { id: 1, top: 58, h: 120, after: null },
    { id: 2, top: 198, h: 80, after: 1 },
  ];
  assert.deepEqual(ys(laidOut(notes, column, [])), [58, 198]);
});

test("a new note never lands on the board's writing under the last one: it goes below it, the rest after", () => {
  // (the board wrote under note 1 before note 2 came: picture 134)
  const taken = takenBoxes([writing(230), writing(290)]);
  const notes = [
    { id: 1, top: 58, h: 120, after: null },
    { id: 2, top: 198, h: 80, after: 1 },
    { id: 3, top: 298, h: 60, after: 2 },
  ];
  const out = laidOut(notes, column, taken);
  const [a, b, c] = [...out.values()];
  assert.equal(a.y, 58);
  const low = Math.max(...taken.map(t => t.y1));
  assert.ok(b.y >= low, `note 2 at ${b.y} is on the writing down to ${low}`);
  assert.ok(c.y >= b.y + b.h + 20 - 1, 'note 3 keeps its distance under note 2');
  // (and none touches the writing)
  for (const p of out.values()) assert.ok(!taken.some(t => t.y1 > p.y && t.y0 < p.y + p.h));
});

test('writing beside the notes, off their column, takes no room from them', () => {
  const taken = takenBoxes([
    {
      size: 4,
      points: [
        [600, 210],
        [700, 230],
      ],
    },
  ]);
  assert.deepEqual(ys(laidOut([{ id: 1, top: 198, h: 80, after: null }], column, taken)), [198]);
});

test('a note keeps its place once given: written on later, it stays under that writing', () => {
  const kept = new Map([[1, { y: 58, h: 120, after: null }]]);
  const taken = takenBoxes([writing(100)]); // (a word written over the note's snip)
  assert.deepEqual(ys(laidOut([{ id: 1, top: 58, h: 120, after: null }], column, taken, kept)), [58]);
  // ...but one with another note before it now (the order changed) finds room again
  const moved = new Map([[1, { y: 58, h: 120, after: 7 }]]);
  assert.ok(laidOut([{ id: 1, top: 58, h: 120, after: null }], column, taken, moved).get(1).y > 100);
});

test('a note grown into writing below it moves on to free paper; one being written in stays', () => {
  const kept = new Map([[1, { y: 58, h: 60, after: null }]]);
  const taken = takenBoxes([writing(150)]),
    grown = [{ id: 1, top: 58, h: 120, after: null }];
  assert.ok(laidOut(grown, column, taken, kept).get(1).y > 150);
  assert.equal(laidOut(grown, column, taken, kept, 1).get(1).y, 58);
  // (grown into bare paper, it stays)
  assert.equal(laidOut(grown, column, takenBoxes([writing(400)]), kept).get(1).y, 58);
});

test('a kept place above where the flow now puts a note (the note before it grew) gives way', () => {
  const kept = new Map([
    [1, { y: 58, h: 100, after: null }],
    [2, { y: 170, h: 80, after: 1 }],
  ]);
  const out = laidOut(
    [
      { id: 1, top: 58, h: 160, after: null },
      { id: 2, top: 230, h: 80, after: 1 },
    ],
    column,
    [],
    kept,
  );
  assert.deepEqual(ys(out), [58, 230]);
});
