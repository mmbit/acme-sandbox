// node --test platform/hq/shell/ink/scrapunit.test.js   (a scrap unit: pure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM, UNIT_W, added, bodyOf, heightFor, pointIn, resized, unitOf } from './scrapunit.js';
import { layout } from './masonry.js';
import { boxOf, typedHigh } from './notebookstack.js';
import { emptyGroup } from './notebookparts.js';
import { LINE } from './bookinkmath.js';

const stroke = (points, size = 4) => ({ color: '#2a2352', size, points });
// A drawing in an old page's px, far from its origin
const drawing = {
  ink: [
    stroke([
      [900, 1200, 0.5],
      [960, 1260, 0.5],
    ]),
    stroke([[1000, 1300, 0.5]], 6),
  ],
  texts: [{ x: 880, y: 1180, w: 200, text: 'a note' }],
  pictures: [{ file: 'a.png', x: 950, y: 1210, w: 120, h: 90 }],
};
// How many points its strokes have in all
const points = parts => parts.ink.reduce((n, s) => n + s.points.length, 0);

test('unitOf keeps every stroke, point, typed box and picture, moved to its top-left', () => {
  const unit = unitOf(drawing);
  assert.equal(unit.parts.ink.length, drawing.ink.length);
  assert.equal(points(unit.parts), points(drawing));
  assert.equal(unit.parts.texts.length, drawing.texts.length);
  assert.deepEqual(
    unit.parts.pictures.map(c => c.file),
    ['a.png'],
  );
  const box = boxOf(unit.parts);
  assert.ok(Math.abs(box.x) < 1e-9 && Math.abs(box.y) < 1e-9);
  assert.ok(unit.h >= box.h);
});

test('unitOf keeps a narrow drawing at its size and adds the room asked for', () => {
  const unit = unitOf(drawing, ROOM),
    box = boxOf(unit.parts);
  assert.equal(box.w, boxOf(drawing).w);
  assert.equal(unit.parts.ink[1].size, 6);
  assert.ok(unit.h >= box.h + ROOM);
  assert.ok(unit.h < box.h + ROOM + 1);
});

test('unitOf scales a drawing wider than a unit down to its width, pens and all', () => {
  const wide = {
    ...emptyGroup,
    ink: [
      stroke(
        [
          [0, 0],
          [1280, 400],
        ],
        8,
      ),
    ],
    pictures: [{ file: 'b.png', x: 0, y: 0, w: 640, h: 300 }],
  };
  const unit = unitOf(wide),
    box = boxOf(unit.parts),
    k = box.w / boxOf(wide).w;
  assert.ok(Math.abs(box.w - UNIT_W) < 1e-6);
  assert.ok(Math.abs(unit.parts.ink[0].size - 8 * k) < 1e-9);
  assert.ok(Math.abs(unit.parts.pictures[0].w / unit.parts.pictures[0].h - 640 / 300) < 1e-9);
  assert.ok(unit.h >= box.h);
});

test('unitOf scales a wide drawing down within what the store keeps: a thin pen stays a line, typed words never overlap', () => {
  const words = 'Make the price smaller and move the basket up to the corner, where it reads';
  const wide = {
    ink: [
      stroke(
        [
          [0, 0],
          [2000, 40],
        ],
        2.5,
      ),
    ],
    texts: [
      { x: 100, y: 100, w: 640, text: words },
      { x: 100, y: 100 + typedHigh({ w: 640, text: words }), w: 640, text: 'and the shop sign' },
    ],
    pictures: [],
  };
  const unit = unitOf(wide);
  assert.ok(
    unit.parts.ink.every(s => s.size >= LINE.min),
    'every line as thick as the store keeps one',
  );
  const [a, b] = unit.parts.texts.map(t => ({ ...t, h: typedHigh(t) }));
  assert.ok(b.y >= a.y + a.h, 'the second box below the first, its words wrapped again');
  assert.ok(
    [a, b].every(t => t.x + t.w <= UNIT_W && t.y + t.h <= unit.h),
    'inside the unit',
  );
});

test('an empty unit is just its room tall', () => {
  assert.deepEqual(unitOf(emptyGroup, ROOM), { parts: emptyGroup, h: ROOM });
});

test('resized can grow a unit, but not cut into its parts', () => {
  const { parts } = unitOf(drawing),
    bottom = boxOf(parts).h;
  assert.equal(resized(parts, bottom + 200), Math.round(bottom + 200));
  assert.ok(resized(parts, 10) >= bottom);
  assert.ok(resized(emptyGroup, 40) === 40);
});

test('heightFor grows a unit when ink goes past its bottom, and never shrinks it', () => {
  const { parts, h } = unitOf(drawing, ROOM);
  assert.equal(heightFor(parts, h), h);
  const below = { ...parts, ink: [...parts.ink, stroke([[20, h + 100]])] };
  assert.ok(heightFor(below, h) >= h + 100);
  assert.equal(heightFor(emptyGroup, h), h);
});

test('added joins more parts after a unit’s own, taller if they reach past it', () => {
  const unit = unitOf(drawing, ROOM),
    more = { ...emptyGroup, ink: [stroke([[10, unit.h + 50]])] },
    after = added(unit, more);
  assert.equal(after.parts.ink.length, unit.parts.ink.length + 1);
  assert.equal(after.parts.ink.at(-1), more.ink[0]);
  assert.ok(after.h >= unit.h + 50);
  assert.equal(added(unit, emptyGroup).h, unit.h);
});

test('bodyOf ends at its pictures and typed words, leaving ink in the room under them', () => {
  const { parts } = unitOf(drawing, ROOM),
    withInk = { ...parts, ink: [...parts.ink, stroke([[10, 900]])] };
  assert.equal(bodyOf(withInk), bodyOf(parts));
  assert.ok(bodyOf(parts) <= boxOf(parts).h + 1);
  assert.equal(bodyOf(emptyGroup), 0);
});

test('pointIn turns a point on the laid-out page into the unit’s own px at any scale', () => {
  for (const width of [240, 744]) {
    const { places, scale } = layout(
        [
          { id: 1, h: 200 },
          { id: 2, h: 100 },
        ],
        width,
      ),
      p = places[1];
    const at = pointIn(p, scale, p.x + 30 * scale, p.y + 50 * scale);
    assert.ok(Math.abs(at.x - 30) < 1e-9 && Math.abs(at.y - 50) < 1e-9);
  }
});
