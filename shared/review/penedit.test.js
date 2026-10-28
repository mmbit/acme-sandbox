// node --test shared/review/penedit.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editOf, inserted, struck } from './penedit.js';

// Words laid out as a browser would in a fixed-width face: 10 px a letter, lines 20 px high from y 100, at x 100,
// each line of the text one line on screen
const CHAR = 10,
  LINE = 20;
function laidOut(text) {
  const words = [];
  let from = 0;
  text.split('\n').forEach((row, n) => {
    for (const m of row.matchAll(/\S+/g)) {
      const left = 100 + m.index * CHAR,
        top = 100 + n * LINE;
      words.push({
        start: from + m.index,
        end: from + m.index + m[0].length,
        rects: [{ left, top, right: left + m[0].length * CHAR, bottom: top + LINE }],
      });
    }
    from += row.length + 1;
  });
  return words;
}
// A hand's line from one point to another, a little wobble on it
const stroke = ([x0, y0], [x1, y1], n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n + Math.sin(i) * 0.8]);

const TEXT = 'order the teal mugs today';
// (x of a letter's left edge, and a line's middle)
const x = i => 100 + i * CHAR,
  middle = row => 100 + row * LINE + LINE / 2;

test('a line along the middle of a word strikes it out', () => {
  const edit = editOf(stroke([x(10) - 6, middle(0)], [x(14) + 5, middle(0) + 2]), laidOut(TEXT));
  assert.deepEqual(edit, { kind: 'strike', ranges: [[10, 14]] });
  assert.equal(struck(TEXT, edit.ranges), 'order the mugs today');
});

test('a line through two words strikes both, and they go with the space between them', () => {
  const edit = editOf(stroke([x(6) - 4, middle(0)], [x(14) + 3, middle(0) - 1]), laidOut(TEXT));
  assert.deepEqual(edit, {
    kind: 'strike',
    ranges: [
      [6, 9],
      [10, 14],
    ],
  });
  assert.equal(struck(TEXT, edit.ranges), 'order mugs today');
});

test('a stroke over too little of a word, or too slanted, or over its top, is ink', () => {
  const words = laidOut(TEXT);
  assert.equal(editOf(stroke([x(10), middle(0)], [x(11) + 5, middle(0)]), words), null, 'a third of "teal"');
  assert.equal(editOf(stroke([x(10), middle(0) - 8], [x(14), middle(0) + 14]), words), null, 'slanted');
  assert.equal(editOf(stroke([x(10) - 4, 99], [x(14) + 4, 101]), words), null, 'along its top edge');
});

test('the first and last words struck leave no space at the line’s ends', () => {
  const words = laidOut(TEXT);
  assert.equal(struck(TEXT, editOf(stroke([x(0) - 6, middle(0)], [x(5) + 4, middle(0)]), words).ranges), TEXT.slice(6));
  const last = editOf(stroke([x(20) - 3, middle(0)], [x(25) + 6, middle(0)]), words);
  assert.equal(struck(TEXT, last.ranges), 'order the teal mugs');
});

test('a slice between two words opens the text between them', () => {
  // (in the space between "teal" and "mugs", nearer "teal"'s end)
  const edit = editOf(stroke([x(14) + 2, middle(0) - 16], [x(14) + 4, middle(0) + 15]), laidOut(TEXT));
  assert.deepEqual(edit, { kind: 'slice', at: 14 });
  assert.deepEqual(inserted(TEXT, edit.at, 'blue'), { text: 'order the teal blue mugs today', caret: 19 });
});

test('a slice inside a word opens the text at the word’s nearest edge', () => {
  const words = laidOut(TEXT);
  // (after "mu" of "mugs": its start is nearer)
  assert.deepEqual(editOf(stroke([x(16) + 1, middle(0) - 14], [x(16), middle(0) + 14]), words), {
    kind: 'slice',
    at: 15,
  });
  // (after "mug": its end is nearer)
  assert.deepEqual(editOf(stroke([x(18) - 1, middle(0) - 14], [x(18) + 2, middle(0) + 14]), words), {
    kind: 'slice',
    at: 19,
  });
});

test('a slice that crosses no line of words, or only grazes one, is ink', () => {
  const words = laidOut(TEXT);
  assert.equal(editOf(stroke([x(10), middle(0) + 30], [x(10), middle(0) + 80]), words), null, 'under the words');
  assert.equal(editOf(stroke([x(40), middle(0) - 14], [x(40), middle(0) + 14]), words), null, 'far to their right');
  assert.equal(editOf(stroke([x(10), middle(0) + 6], [x(10), middle(0) + 30]), words), null, 'its foot only');
});

test('across several lines: a strike takes the line it runs along, a slice the line its middle is on', () => {
  const text = 'order the teal mugs\nand the green jugs\nby friday',
    words = laidOut(text);
  const strike = editOf(stroke([x(8) - 5, middle(1)], [x(13) + 5, middle(1)]), words);
  assert.deepEqual(strike, { kind: 'strike', ranges: [[28, 33]] });
  assert.equal(struck(text, strike.ranges), 'order the teal mugs\nand the jugs\nby friday');
  // (a slice reaching from line 1 deep into line 2, its middle on line 2: before "jugs")
  const slice = editOf(stroke([x(14) - 2, middle(1) - 12], [x(14) - 1, middle(2) - 2]), words);
  assert.deepEqual(slice, { kind: 'slice', at: 34 });
  assert.equal(inserted(text, slice.at, 'big').text, 'order the teal mugs\nand the green big jugs\nby friday');
});

test('words put in at the text’s end or start get one space, on the side that needs it', () => {
  assert.deepEqual(inserted('mugs', 4, ' today '), { text: 'mugs today', caret: 10 });
  assert.deepEqual(inserted('mugs', 0, 'teal'), { text: 'teal mugs', caret: 4 });
  assert.deepEqual(inserted('', 0, 'teal'), { text: 'teal', caret: 4 });
});
