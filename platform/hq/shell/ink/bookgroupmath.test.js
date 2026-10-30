// node --test platform/hq/shell/ink/bookgroupmath.test.js   (a Notebook page's groups as numbers; no DOM)
// (a group's box is checked in notebookstack.test.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesOf, emptyParts, keyOf, scratched } from './bookgroupmath.js';

const line = (x0, y0, x1, y1) => ({
  size: 2,
  points: [
    [x0, y0],
    [x1, y1],
  ],
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
