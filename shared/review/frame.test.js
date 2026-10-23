// node --test shared/review/frame.test.js   (the framing rule as a plain function, no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameMark } from './frame.js';

const PHONE = { w: 390, h: 844 };
const THUMBNAIL = 70 / 52;
const POLAROID = 3 / 4;

// Where a mark lands in the preview, in % of the preview, from the img's placement
function shown(mark, viewport, placement) {
  const [width, height, left, top] = [placement.width, placement.height, placement.left, placement.top].map(parseFloat);
  const x = left + (mark.x / viewport.w) * width;
  const y = top + (mark.y / viewport.h) * height;
  return { left: x, top: y, right: x + (mark.w / viewport.w) * width, bottom: y + (mark.h / viewport.h) * height };
}
const inside = box => box.left >= 0 && box.top >= 0 && box.right <= 100 && box.bottom <= 100;

test('a circle is shown whole in either preview, the img keeping its own shape', () => {
  const circle = { kind: 'circle', rect: { x: 20, y: 80, w: 350, h: 60 }, area: { x: 10, y: 70, w: 370, h: 90 } };
  for (const aspect of [THUMBNAIL, POLAROID]) {
    const placement = frameMark(circle, PHONE, aspect);
    assert.ok(inside(shown(circle.area, PHONE, placement)), JSON.stringify(placement));
    const scaleX = parseFloat(placement.width) / PHONE.w;
    const scaleY = (parseFloat(placement.height) / PHONE.h) * (1 / aspect);
    assert.ok(Math.abs(scaleX - scaleY) < 0.01, 'not stretched');
  }
});

test("a pin's frame holds the element and the pin's head above it", () => {
  const pin = { kind: 'pin', rect: { x: 120, y: 410, w: 150, h: 44 }, area: null };
  const placement = frameMark(pin, PHONE, THUMBNAIL);
  assert.ok(inside(shown({ x: 120, y: 410 - 32, w: 150 + 22, h: 44 + 32 }, PHONE, placement)));
});

test('a mark in a corner keeps the frame inside the screenshot', () => {
  const corner = { kind: 'circle', area: { x: 0, y: 790, w: 60, h: 54 } };
  const placement = frameMark(corner, PHONE, THUMBNAIL);
  const screenshot = shown({ x: 0, y: 0, w: PHONE.w, h: PHONE.h }, PHONE, placement);
  assert.ok(screenshot.left <= 0 && screenshot.bottom >= 100, JSON.stringify(placement));
});

test('a pin on something as big as the page keeps the stylesheet crop rather than a sliver', () => {
  assert.equal(frameMark({ kind: 'pin', rect: { x: 0, y: 0, w: 390, h: 5000 } }, PHONE, THUMBNAIL), null);
  assert.equal(frameMark({ kind: 'pin', rect: { x: 0, y: 0, w: 390, h: 5000 } }, PHONE, POLAROID), null);
});

test('a big circle is still shown whole, never left to the stylesheet crop that would hide it', () => {
  const circle = { kind: 'circle', area: { x: 40, y: 430, w: 300, h: 330 } };
  const placement = frameMark(circle, PHONE, THUMBNAIL);
  assert.ok(placement, 'a frame');
  assert.ok(inside(shown(circle.area, PHONE, placement)), JSON.stringify(placement));
});

test('no mark, no screenshot size or a mark off the screen: no frame', () => {
  assert.equal(frameMark(null, PHONE, THUMBNAIL), null);
  assert.equal(frameMark({ kind: 'pin', rect: { x: 10, y: 10, w: 20, h: 20 } }, {}, THUMBNAIL), null);
  assert.equal(frameMark({ kind: 'pin', rect: { x: 10, y: 900, w: 20, h: 20 } }, PHONE, THUMBNAIL), null);
});
