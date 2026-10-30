// node --test platform/hq/shell/ink/masonry.test.js   (a page's masonry: pure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_H, GAP, columnsOf, layout, placeAt, widthFor } from './masonry.js';

// Units of mixed heights, as a page has them
const units = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, h: 80 + ((i * 137) % 400) }));

// Whether every place lies on a page this wide, left to right
const onPage = (places, width) => places.every(p => p.x >= 0 && p.x + p.w <= width + 1e-9);

test('a phone-width page has one column at scale 1, on the page', () => {
  const page = layout(units, 390);
  assert.equal(page.columns, 1);
  assert.equal(page.scale, 1);
  assert.ok(onPage(page.places, 390));
});

test('an iPad mini upright has two columns', () => {
  const page = layout(units, 744);
  assert.equal(page.columns, 2);
  assert.equal(page.scale, 1);
  assert.ok(onPage(page.places, 744));
  assert.deepEqual(new Set(page.places.map(p => p.column)), new Set([0, 1]));
});

test('a 4K-wide page has ten columns or more', () => {
  const page = layout(units, 3840);
  assert.ok(page.columns >= 10, `${page.columns} columns`);
  assert.ok(onPage(page.places, 3840));
});

test('a sliver of a page has one column scaled down so nothing runs off it', () => {
  const page = layout(units, 240);
  assert.equal(page.columns, 1);
  assert.ok(page.scale < 1);
  assert.ok(onPage(page.places, 240));
});

test('widthFor(n) is a page wide enough for n columns, no more', () => {
  for (let n = 1; n <= 12; n++) {
    assert.equal(columnsOf(widthFor(n)), n);
    assert.equal(columnsOf(widthFor(n + 1) - 1), n);
    assert.equal(layout(units, widthFor(n)).scale, 1);
  }
});

test('the places keep the units in order, their heights at the scale', () => {
  for (const width of [240, 390, 744, 1400]) {
    const page = layout(units, width);
    assert.deepEqual(
      page.places.map(p => p.id),
      units.map(u => u.id),
    );
    page.places.forEach((p, i) => assert.ok(Math.abs(p.h - units[i].h * page.scale) < 1e-9));
    assert.ok(page.places.every(p => p.y + p.h <= page.height));
  }
});

test('units never overlap, and keep at least a GAP from each other', () => {
  for (const width of [240, 390, 744, 1400, 3840]) {
    const { places, scale } = layout(units, width),
      gap = GAP * scale - 1e-9;
    for (const a of places)
      for (const b of places) {
        if (a === b) continue;
        const apart =
          a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
        assert.ok(apart, `${width}: units ${a.id} and ${b.id} closer than the gap`);
      }
  }
});

test('each unit goes under the shortest column, the leftmost of equals', () => {
  const { places, columns } = layout(units, 1400);
  const top = places[0].y;
  places.forEach((p, i) => {
    const before = places.slice(0, i),
      foot = c => Math.max(top, ...before.filter(q => q.column === c).map(q => q.y + q.h));
    for (let c = 0; c < columns; c++) {
      if (c === p.column) continue;
      assert.ok(foot(c) > foot(p.column) || (foot(c) === foot(p.column) && p.column < c), `unit ${p.id}`);
    }
  });
});

test('an empty page has no places and still a height', () => {
  const page = layout([], 744);
  assert.deepEqual(page.places, []);
  assert.ok(page.height > 0);
});

test('placeAt finds the unit under a point and nothing in the space between', () => {
  const { places, scale } = layout(units, 744);
  for (const p of places) assert.equal(placeAt(places, p.x + p.w / 2, p.y + p.h / 2)?.id, p.id);
  const [a, b] = places.filter(p => p.column === 0);
  assert.equal(placeAt(places, a.x + a.w / 2, (a.y + a.h + b.y) / 2), undefined);
  const right = places.find(p => p.column === 1);
  assert.equal(placeAt(places, (a.x + a.w + right.x) / 2, a.y + 1), undefined);
  assert.equal(placeAt(places, a.x - GAP * scale, a.y + 1), undefined);
});

test("a new day's units start under its header, below every unit of the day before", () => {
  const days = units.map((u, i) => ({ ...u, day: i < 9 ? '2026-10-29' : '2026-10-30' }));
  for (const width of [390, 744, 1400]) {
    const { places, headers, scale, height } = layout(days, width);
    assert.deepEqual(
      headers.map(d => d.day),
      ['2026-10-29', '2026-10-30'],
    );
    const [first, second] = headers,
      before = places.slice(0, 9),
      after = places.slice(9);
    assert.ok(Math.abs(second.h - DAY_H * scale) < 1e-9);
    assert.ok(before.every(p => p.y >= first.y + first.h));
    assert.ok(before.every(p => p.y + p.h + GAP * scale <= second.y + 1e-9));
    assert.ok(after.every(p => p.y >= second.y + second.h));
    assert.ok(places.every(p => p.y + p.h <= height));
  }
});

test('units without a day get no headers', () => {
  assert.deepEqual(layout(units, 744).headers, []);
});
