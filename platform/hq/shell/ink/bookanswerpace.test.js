// node --test platform/hq/shell/ink/bookanswerpace.test.js   (an answer's letters)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LETTER_MS, WHOLE_MS, lettersAt, writingMs } from './bookanswerpace.js';

test('a short answer comes a letter every LETTER_MS', () => {
  assert.equal(writingMs(20), 20 * LETTER_MS);
  assert.equal(lettersAt(0, 20), 0);
  assert.equal(lettersAt(LETTER_MS * 5, 20), 5);
  assert.equal(lettersAt(LETTER_MS * 20, 20), 20);
});

test('a long answer speeds up and is whole within WHOLE_MS', () => {
  assert.equal(writingMs(400), WHOLE_MS);
  assert.equal(lettersAt(WHOLE_MS / 2, 400), 200);
  assert.equal(lettersAt(WHOLE_MS, 400), 400);
  assert.equal(lettersAt(WHOLE_MS * 9, 400), 400);
});
