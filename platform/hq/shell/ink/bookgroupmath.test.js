// node --test platform/hq/shell/ink/bookgroupmath.test.js   (a Notebook page's groups as numbers; no DOM)
// (a group's box is checked in notebookstack.test.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesOf, emptyParts, keyOf } from './bookgroupmath.js';

const line = (x0, y0, x1, y1) => ({
  size: 2,
  points: [
    [x0, y0],
    [x1, y1],
  ],
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

test("a unit's line laid on the page and taken back to its px is the same element, unchanged", () => {
  const stored = { size: 2, points: [[1.76, 11.43, 0.48, 0]] },
    back = { size: 2, points: [[1.76 + 1009 - 1009, 11.43 + 605 - 605, 0.48, 0]] };
  assert.notEqual(back.points[0][0], 1.76);
  const base = new Map([[1, { ...emptyParts(), ink: [keyOf(stored)] }]]);
  assert.deepEqual(changesOf(base, new Map([[1, { ...emptyParts(), ink: [back] }]])), { edits: [], deletes: [] });
});
