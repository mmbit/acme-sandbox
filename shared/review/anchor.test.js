// node --test shared/review/anchor.test.js   (the anchor's pure rules; its cases on real elements, in a browser, are
// shared/review/check.mjs's "anchor" path)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COVERS, anchorOf, box, lands, mapper, noKeys, roundOf, steps } from './anchor.js';

test("a page keeps its fragment's names and a plain anchor, never a value", () => {
  assert.equal(noKeys('https://hello.test/order?n=42#t=secret&faq'), 'https://hello.test/order?n=42#t=…&faq');
  assert.equal(noKeys('/a#7'), '/a#7');
  assert.equal(noKeys('/a'), '/a');
});

test("a selector's steps into each shadow root keep a hex escape's space", () => {
  assert.deepEqual(steps('chat-box#\\39 lives button#send'), ['chat-box#\\39 lives', 'button#send']);
  assert.deepEqual(steps('section#\\31 23 > p.lead'), ['section#\\31 23 > p.lead']);
});

test('a box is whole px, from a client rect or a plain one', () => {
  assert.deepEqual(box({ left: 10.4, top: 20.6, width: 99.5, height: 40 }), { x: 10, y: 21, w: 100, h: 40 });
  assert.deepEqual(box({ x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
});

test('a note about the whole page has no element, and keeps its view', () => {
  const view = { w: 390, h: 844, x: 0, y: 500, dpr: 3 };
  assert.deepEqual(anchorOf(null, { url: '/order#t=secret', view }), {
    v: 1,
    url: '/order#t=…',
    el: null,
    view,
    ink: [],
  });
});

test('a point follows its element to its box now, each axis on its own', () => {
  const at = mapper({ x: 100, y: 200, w: 200, h: 100 }, { x: 50, y: 400, w: 400, h: 50 });
  assert.deepEqual(at([150, 250, 0.5, 12]), [150, 425, 0.5, 12]);
  assert.deepEqual(at([100, 200]), [50, 400]);
});

test('without its element, or with one of no size, a point stays where it was drawn', () => {
  const was = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(mapper(was, null)([5, 6, 1, 0]), [5, 6, 1, 0]);
  assert.deepEqual(mapper(was, { x: 9, y: 9, w: 0, h: 0 })([5, 6]), [5, 6]);
  assert.deepEqual(mapper(null, { x: 9, y: 9, w: 10, h: 10 })([5, 6]), [5, 6]);
});

// ---- a mark on another screen's layout
const button = {
  selector: 'nav > button:nth-of-type(2)',
  tag: 'button',
  text: 'Send',
  box: { x: 100, y: 40, w: 80, h: 30 },
};
const ringOn = (x0, y0, x1, y1) => [
  {
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  },
];
const round = { v: 1, el: button, ink: ringOn(90, 30, 190, 80) };

test('a ring round an element lands on that element on another screen', () => {
  assert.equal(lands(round, { tag: 'button', text: 'Send', box: { x: 600, y: 10, w: 120, h: 40 } }), true);
});

test('a ring lands nowhere when its element there is another, gone or not shown', () => {
  assert.equal(lands(round, { tag: 'button', text: 'Sent', box: { x: 600, y: 10, w: 120, h: 40 } }), false);
  assert.equal(lands(round, { tag: 'a', text: 'Send', box: { x: 600, y: 10, w: 120, h: 40 } }), false);
  assert.equal(lands(round, { tag: 'button', text: 'Send', box: { x: 600, y: 10, w: 0, h: 0 } }), false);
  assert.equal(lands(round, null), false);
  assert.equal(lands({ ...round, el: null }, { tag: 'button', text: 'Send', box: button.box }), false);
});

test('a ring on part of an element (a word in a paragraph, a spot on a canvas) lands nowhere', () => {
  const para = { tag: 'p', text: 'A long line of words', box: { x: 0, y: 0, w: 400, h: 120 } };
  const word = { v: 1, el: { selector: 'p', ...para }, ink: ringOn(10, 10, 60, 30) };
  assert.equal(lands(word, para), false, 'a word in a paragraph');
  // (the same box covered whole would land, so it's the share that tells: just under, and at, COVERS)
  const half = 400 * 120 * COVERS;
  assert.equal(lands({ ...word, ink: ringOn(0, 0, half / 120 - 1, 120) }, para), false);
  assert.equal(lands({ ...word, ink: ringOn(0, 0, half / 120, 120) }, para), true);
  const scene = { selector: 'canvas#world', tag: 'canvas', text: '', box: { x: 0, y: 0, w: 390, h: 844 } };
  assert.equal(
    lands({ v: 1, el: scene, ink: ringOn(0, 0, 390, 844) }, { tag: 'canvas', text: '', box: scene.box }),
    false,
    'a canvas draws its own picture inside its box',
  );
});

test('a ring whose middle is off its element (begun on a neighbour) lands nowhere; a pin on its element does', () => {
  assert.equal(lands({ ...round, ink: ringOn(150, 20, 400, 200) }, { ...button, box: button.box }), false);
  assert.equal(lands({ ...round, ink: [] }, { ...button }), true);
});

// What a ring is round, as the phone sends it: elements nested in a page, each
// with its box in client px
function nest(...boxes) {
  const doc = {};
  let parentElement = null;
  const els = ['html', 'body', ...boxes].map(b => {
    const [x, y, w, h] = typeof b === 'string' ? [0, 0, 400, 2000] : b;
    const el = {
      ownerDocument: doc,
      parentElement,
      getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }),
    };
    parentElement = el;
    return el;
  });
  [doc.documentElement, doc.body] = els;
  return els.slice(2);
}

test('a ring is round the outermost element it covers COVERS of, not the row it sits in nor the page', () => {
  // a panel, a row in it, a button in the row, the button's label
  const [panel, row, button, label] = nest([0, 0, 400, 600], [0, 100, 400, 60], [10, 110, 100, 40], [20, 115, 60, 30]);
  assert.equal(roundOf(label, { x: 5, y: 105, w: 110, h: 50 }), button, 'the button, from its label up');
  assert.equal(roundOf(row, { x: 5, y: 105, w: 110, h: 50 }), null, 'the row it sits in is not covered');
  assert.equal(roundOf(label, { x: 0, y: 0, w: 400, h: 2000 }), panel, 'short of the page itself');
  assert.equal(roundOf(label, { x: 25, y: 120, w: 10, h: 10 }), null, 'a spot on a word');
  // (a box of no size, as display: contents lays one out, ends the climb even inside a covered one)
  const [, zero, inside] = nest([0, 0, 400, 400], [0, 0, 0, 0], [10, 10, 50, 20]);
  assert.equal(roundOf(inside, { x: 0, y: 0, w: 400, h: 400 }), inside);
  assert.equal(roundOf(zero, { x: 0, y: 0, w: 400, h: 400 }), null);
});
