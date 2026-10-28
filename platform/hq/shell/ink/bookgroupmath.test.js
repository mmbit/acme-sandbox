// node --test platform/hq/shell/ink/bookgroupmath.test.js   (a Notebook page's groups as numbers; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, changesOf, emptyParts, gap, keyOf, NEAR, scratched, sortNew } from './bookgroupmath.js';

const line = (x0, y0, x1, y1) => ({
  size: 2,
  points: [
    [x0, y0],
    [x1, y1],
  ],
});
const ink = el => ({ kind: 'ink', el });

test('a group box holds its lines, boxes and pictures', () => {
  assert.equal(boxOf(emptyParts()), null);
  const b = boxOf({ ink: [line(10, 10, 50, 20)], texts: [{ x: 0, y: 40, w: 30, text: 'a\nb' }], pictures: [] });
  assert.deepEqual(b, { x: 0, y: 9, w: 51, h: 79 });
  assert.equal(gap({ x: 0, y: 0, w: 10, h: 10 }, { x: 13, y: 14, w: 5, h: 5 }), 5);
});

test('a line starting inside a group joins it, however long ago it was drawn', () => {
  const groups = [{ id: 7, box: { x: 100, y: 100, w: 200, h: 50 } }];
  const { sorted, recent } = sortNew([ink(line(305, 120, 600, 400))], groups, null, 0);
  assert.deepEqual(
    sorted.map(s => s.id),
    [7],
  );
  assert.equal(recent.id, 7);
});

test('the words of a line of writing stay one group; one written later, far off, starts another', () => {
  const groups = [{ id: 1, box: { x: 0, y: 0, w: 100, h: 30 } }];
  const last = { id: 1, at: 1000, box: groups[0].box };
  // soon and near: the group drawn last
  let { sorted } = sortNew([ink(line(140, 10, 180, 20))], groups, last, 1000 + NEAR.ms - 1);
  assert.deepEqual(
    sorted.map(s => s.id),
    [1],
  );
  // near but too late: a new group
  ({ sorted } = sortNew([ink(line(140, 10, 180, 20))], groups, last, 1000 + NEAR.ms + 1));
  assert.deepEqual(
    sorted.map(s => s.id),
    [null],
  );
  // two new lines near each other, far from every group: one new group; a third far off: another
  ({ sorted } = sortNew(
    [ink(line(500, 500, 540, 510)), ink(line(560, 500, 600, 510)), ink(line(500, 900, 540, 910))],
    groups,
    null,
    0,
  ));
  assert.deepEqual(
    sorted.map(s => [s.id, s.items.length]),
    [
      [null, 2],
      [null, 1],
    ],
  );
});

test('a scratch-out deletes the group it covers most of, at least half', () => {
  const groups = [
    { id: 1, box: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 2, box: { x: 200, y: 0, w: 100, h: 100 } },
  ];
  const zig = [
    [10, 10],
    [90, 30],
    [10, 50],
    [90, 70],
    [10, 90],
  ];
  assert.equal(scratched(zig, groups).id, 1);
  assert.equal(
    scratched(
      [
        [0, 0],
        [20, 20],
      ],
      groups,
    ),
    null,
  );
});

test("a page's change: groups changed are edited, groups emptied deleted, the rest left alone", () => {
  const a = line(0, 0, 10, 10),
    b = line(20, 20, 30, 30);
  const was = parts => Object.fromEntries(Object.entries(parts).map(([k, l]) => [k, l.map(keyOf)]));
  const base = new Map([
    [1, was({ ...emptyParts(), ink: [a] })],
    [2, was({ ...emptyParts(), ink: [b] })],
    [3, was({ ...emptyParts(), ink: [a] })],
  ]);
  // (what HQ adds to draw an element doesn't count as a change)
  const now = new Map([
    [1, { ...emptyParts(), ink: [{ ...a, g: 1 }] }],
    [2, { ...emptyParts(), ink: [b, a] }],
  ]);
  const { edits, deletes } = changesOf(base, now);
  assert.deepEqual(
    edits.map(e => e.id),
    [2],
  );
  assert.deepEqual(deletes, [3]);
});
