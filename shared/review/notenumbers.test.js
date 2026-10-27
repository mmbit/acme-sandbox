// node --test shared/review/notenumbers.test.js   (the number a note shows on its page and on its sheet)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownNumbers } from './notenumbers.js';

const shown = notes => [...shownNumbers(notes).values()];

test('a page with one open note numbers none: there is nothing to tell apart', () => {
  assert.deepEqual(shown([]), []);
  assert.deepEqual(shown([{ id: 7, n: 3 }]), [null]);
});

test('several open notes each show their number on their sheet, so page and sheet point at each other', () => {
  assert.deepEqual(
    shown([
      { id: 1, n: 1 },
      { id: 2, n: 2 },
    ]),
    [1, 2],
  );
  // (a page of an owner's shows the notes made on it, which may be the sheet's 2nd and 5th)
  assert.deepEqual(
    shown([
      { id: 2, n: 2 },
      { id: 5, n: 5 },
    ]),
    [2, 5],
  );
});

test('never two the same: the later of two notes sharing a number takes the next one free', () => {
  // (two owners' sheets, each with its note 1, marked on one page)
  assert.deepEqual(
    shown([
      { id: 10, n: 1 },
      { id: 20, n: 1 },
    ]),
    [1, 2],
  );
  assert.deepEqual(
    shown([
      { id: 10, n: 1 },
      { id: 11, n: 2 },
      { id: 20, n: 1 },
      { id: 21, n: 2 },
    ]),
    [1, 2, 3, 4],
  );
  // (the mark being made, with no number yet, shows one past the page's)
  assert.deepEqual(
    shown([
      { id: 1, n: 1 },
      { id: 'new', n: 0 },
    ]),
    [1, 2],
  );
  const ns = shown([
    { id: 1, n: 3 },
    { id: 2, n: 1 },
    { id: 3, n: 3 },
    { id: 4, n: 1 },
  ]);
  assert.equal(new Set(ns).size, ns.length, `two the same in ${ns}`);
});
