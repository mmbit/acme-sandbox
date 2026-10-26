// node --test shared/review/anchor.test.js   (the anchor's pure rules; its cases on real elements, in a browser, are
// shared/review/check.mjs's "anchor" path)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorOf, box, mapper, noKeys, steps } from './anchor.js';

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
