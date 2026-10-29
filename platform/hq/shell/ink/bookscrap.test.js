// node --test platform/hq/shell/ink/bookscrap.test.js   (a taped picture's size, place and tilt)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILT, placeScrap, scrapAt, tiltOf } from './bookscrap.js';

const page = { w: 500, h: 900 },
  view = { x0: 0, y0: 100, x1: 500, y1: 700 };

test('a touch askew: never more than TILT degrees either way, to a tenth', () => {
  assert.equal(tiltOf(0), -TILT);
  assert.equal(tiltOf(0.5), 0);
  assert.equal(tiltOf(0.999999), TILT);
  for (let i = 0; i < 200; i++) {
    const t = tiltOf(Math.random());
    assert.ok(t >= -TILT && t <= TILT, `${t}`);
    assert.equal(Math.round(t * 10) / 10, t);
  }
});

test('a picture lands where it was put, its middle on the spot, at most half the page wide', () => {
  const s = placeScrap({ nw: 2000, nh: 1000 }, page, { at: [200, 300], view, rand: 0.75 });
  assert.deepEqual(s, { x: 75, y: 237.5, w: 250, h: 125, tilt: 2 });
});

test('a small picture keeps its size; a tall one is at most about half the paper high', () => {
  assert.deepEqual(placeScrap({ nw: 120, nh: 80 }, page, { at: [200, 300], view, rand: 0.5 }), {
    x: 140,
    y: 260,
    w: 120,
    h: 80,
    tilt: 0,
  });
  const tall = placeScrap({ nw: 600, nh: 2000 }, page, { view, rand: 0.5 });
  assert.equal(tall.h, 330);
  assert.equal(tall.w, 99);
});

test('with no spot it lands in the middle of what the paper shows of the page, and stays on the page', () => {
  const s = placeScrap({ nw: 100, nh: 100 }, page, { view, rand: 0.5 });
  assert.deepEqual([s.x + s.w / 2, s.y + s.h / 2], [250, 400]);
  const edge = placeScrap({ nw: 100, nh: 100 }, page, { at: [490, 5], view, rand: 0.5 });
  assert.deepEqual([edge.x, edge.y], [400, 0]);
  // (several at once, dealt a little apart)
  const [a, b] = [0, 1].map(i => placeScrap({ nw: 100, nh: 100 }, page, { view, i, rand: 0.5 }));
  assert.deepEqual([b.x - a.x, b.y - a.y], [28, 22]);
});

test('a press finds the scrap on top, turned as it lies; a moved one keeps its middle on the page', () => {
  const flat = { x: 100, y: 100, w: 200, h: 100, tilt: 0 },
    turned = { x: 150, y: 120, w: 200, h: 100, tilt: 30 };
  assert.equal(scrapAt([flat], [110, 105]), 0);
  assert.equal(scrapAt([flat], [99, 150]), -1);
  assert.equal(scrapAt([flat, turned], [250, 170]), 1, 'the one on top');
  // (the turned one's corner: inside its box unturned, outside it turned 30 degrees)
  assert.equal(scrapAt([turned], [155, 125]), -1);
  assert.equal(scrapAt([turned], [250, 170]), 0);
});
