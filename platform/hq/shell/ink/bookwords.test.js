// node --test platform/hq/shell/ink/bookwords.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxesOf, downToClear, tidy } from './bookwords.js';
import { TEXT_MAX } from './notebookparts.js';

test('pasted words come tidy: one kind of break, no stray spaces, a blank line at most, indents kept', () => {
  const pasted = '\r\n\u00a0Title\u200b  \r\n\r\n\r\n\r\nFirst  line\tof it\u2028  indented\n\n\n';
  assert.equal(tidy(pasted), ' Title\n\nFirst line of it\n  indented');
});

test('long words keep their paragraphs and fit the boxes the store keeps', () => {
  const sentence = 'The mug handle should be a touch warmer in tone. ';
  const paragraphs = Array.from({ length: 12 }, (_, i) => `${i + 1}. ${sentence.repeat(6).trim()}`);
  const boxes = boxesOf(paragraphs.join('\n\n'));
  assert.ok(boxes.length > 1, 'more than one box');
  assert.ok(
    boxes.every(b => b.length <= TEXT_MAX),
    'none past the store',
  );
  assert.deepEqual(boxes.join('\n\n').split('\n\n'), paragraphs, 'no paragraph cut or lost');
});

test('a paragraph too long for one box is cut after a sentence, and nothing of it is lost', () => {
  const sentence = 'Words without a break in the middle of a run on paragraph. ';
  const long = sentence.repeat(80).trim();
  const boxes = boxesOf(long);
  assert.ok(boxes.length >= 3 && boxes.every(b => b.length <= TEXT_MAX));
  assert.ok(
    boxes.slice(0, -1).every(b => b.endsWith('.')),
    'each cut after a sentence',
  );
  assert.equal(boxes.join(' '), long);
  const word = 'x'.repeat(TEXT_MAX * 2 + 10);
  assert.equal(boxesOf(word).join(''), word, 'one endless word cut where it must be');
});

test('short words are one box as they are', () => {
  assert.deepEqual(boxesOf('Hello\n\nthere'), ['Hello\n\nthere']);
  assert.deepEqual(boxesOf(''), []);
});

test('words pasted where others lie move down below them, clear of each, and stay where nothing lies', () => {
  const box = { x0: 100, y0: 100, x1: 400, y1: 200 },
    gap = 24;
  assert.equal(downToClear(box, [{ x0: 500, y0: 0, x1: 700, y1: 900 }], gap), 0, 'nothing in its way');
  const first = { x0: 150, y0: 50, x1: 350, y1: 250 },
    second = { x0: 0, y0: 270, x1: 120, y1: 300 };
  const dy = downToClear(box, [second, first], gap);
  assert.equal(dy, 300 + gap - 100, 'below the first, then below the second it then covered');
});
