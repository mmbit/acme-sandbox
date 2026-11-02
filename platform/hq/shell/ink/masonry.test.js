// node --test platform/hq/shell/ink/masonry.test.js   (a page's masonry: pure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_H, GAP, LEAST, MARGIN, columnsOf, layout, placeAt, widthFor } from './masonry.js';
import { UNIT_W } from './scrapunit.js';

// Units of mixed heights, as a page has them
const units = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, h: 80 + ((i * 137) % 400) }));

// Whether every place lies on a page this wide, left to right
const onPage = (places, width) => places.every(p => p.x >= 0 && p.x + p.w <= width + 1e-9);

// Whether the grid spans the page: only the masonry's margin, at the page's scale, left of it and right of it
const spans = (page, width) => {
  const left = Math.min(...page.places.map(p => p.x)),
    right = Math.max(...page.places.map(p => p.x + p.w)),
    margin = MARGIN * page.scale;
  return Math.abs(left - margin) < 1e-9 && Math.abs(width - right - margin) < 1e-9;
};

test('a phone-width page has one column across it, on the page', () => {
  const page = layout(units, 390);
  assert.equal(page.columns, 1);
  assert.ok(page.scale >= 1);
  assert.ok(spans(page, 390));
  assert.ok(onPage(page.places, 390));
});

test("the book's page beside HQ on an iPad, at its own width or half the screen: one column across it, never slim", () => {
  for (const width of [430, 500, 560]) {
    const page = layout(units, width);
    assert.equal(page.columns, 1);
    assert.ok(page.scale > 1, `${width} px: scale ${page.scale}`);
    assert.ok(spans(page, width), `${width} px: the column across the page`);
  }
});

test('an iPad mini upright has two columns across it', () => {
  const page = layout(units, 744);
  assert.equal(page.columns, 2);
  assert.ok(page.scale >= LEAST);
  assert.ok(spans(page, 744));
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

test('a page takes another column once it fits at LEAST of its size, its columns always across the page', () => {
  for (let n = 1; n <= 12; n++) {
    assert.equal(columnsOf(widthFor(n + 1) * LEAST), n + 1);
    assert.equal(columnsOf(widthFor(n + 1) * LEAST - 1), n);
    for (const width of [widthFor(n + 1) * LEAST - 1, widthFor(n + 1) * LEAST]) {
      const page = layout(units, width);
      assert.ok(page.scale >= LEAST && spans(page, width), `${width} px: scale ${page.scale}`);
    }
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

test("a new day's units start under its header, below every unit of the day before; the first day has none", () => {
  const days = units.map((u, i) => ({ ...u, day: i < 9 ? '2026-10-29' : '2026-10-30' }));
  for (const width of [390, 744, 1400]) {
    const { places, headers, scale, height } = layout(days, width);
    assert.deepEqual(
      headers.map(d => d.day),
      ['2026-10-30'],
    );
    const [header] = headers,
      before = places.slice(0, 9),
      after = places.slice(9);
    assert.ok(Math.abs(header.h - DAY_H * scale) < 1e-9);
    assert.ok(Math.abs(Math.min(...before.map(p => p.y)) - MARGIN * scale) < 1e-9);
    assert.ok(before.every(p => p.y + p.h + GAP * scale <= header.y + 1e-9));
    assert.ok(after.every(p => p.y >= header.y + header.h));
    assert.ok(places.every(p => p.y + p.h <= height));
  }
});

test('units without a day get no headers', () => {
  assert.deepEqual(layout(units, 744).headers, []);
});

// (A to F of mixed heights, a line the board wrote under one following it.)
const scraps = [200, 400, 420, 200, 200, 200].map((h, i) => ({ id: 'ABCDEF'[i], h }));
const under = (all, id, line) => {
  const a = all.find(p => p.id === id),
    l = all.find(p => p.id === line);
  return l.column === a.column && Math.abs(l.y - (a.y + a.h + (GAP * l.w) / UNIT_W)) < 1e-9;
};

test('a unit that follows stays right under the one before it, at every column count', () => {
  const page = [scraps[0], { id: 'line', h: 40, follows: true }, ...scraps.slice(1)];
  for (const n of [1, 2, 3, 4]) {
    const { places, columns } = layout(page, widthFor(n));
    assert.equal(columns, n);
    assert.ok(under(places, 'A', 'line'), `${n} columns: ${JSON.stringify(places)}`);
  }
});

test("a unit following the tallest column's last stays in that column, under it", () => {
  const page = [...scraps.slice(0, 3), { id: 'line', h: 40, follows: true }],
    { places } = layout(page, widthFor(3));
  assert.equal(places.find(p => p.id === 'C').column, 2);
  assert.ok(under(places, 'C', 'line'), JSON.stringify(places));
});

test('a unit kept in its column stays there, at that column foot, and one past the columns goes to the shortest', () => {
  const two = [
    { id: 1, h: 100 },
    { id: 2, h: 400 },
  ];
  const kept = layout([...two, { id: 3, h: 50, column: 1 }], widthFor(2)).places.at(-1),
    free = layout([...two, { id: 3, h: 50 }], widthFor(2)).places.at(-1),
    narrow = layout([...two, { id: 3, h: 50, column: 1 }], widthFor(1)).places.at(-1);
  assert.deepEqual([kept.column, kept.y], [1, 24 + 400 + GAP]);
  assert.equal(free.column, 0);
  assert.equal(narrow.column, 0);
});
