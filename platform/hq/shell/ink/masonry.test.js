// node --test platform/hq/shell/ink/masonry.test.js   (a page's masonry: pure)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_H,
  GAP,
  LEAST,
  MARGIN,
  MOST,
  columnUnder,
  columnsOf,
  layout,
  placeAt,
  rightMarginOf,
  widthFor,
} from './masonry.js';
import { UNIT_W } from './scrapunit.js';
// (MOST, atLeft, columnUnder's, a unit's reach's and the narrowest book's tests)

// Units of mixed heights, as a page has them
const units = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, h: 80 + ((i * 137) % 400) }));

// Whether every place lies on a page this wide, left to right
const onPage = (places, width) => places.every(p => p.x >= 0 && p.x + p.w <= width + 1e-9);

// Whether the grid sits at the page's left, under its title: the masonry's margin, at the page's scale, left of it, and
// at least that right of it (the width left over is paper)
const atLeft = (page, width) => {
  const left = Math.min(...page.places.map(p => p.x)),
    right = Math.max(...page.places.map(p => p.x + p.w)),
    margin = MARGIN * page.scale;
  return Math.abs(left - margin) < 1e-9 && width - right >= margin - 1e-9;
};
// Whether the grid spans the page: only the masonry's margin, at the page's scale, left of it and right of it
const spans = (page, width) => {
  const right = Math.max(...page.places.map(p => p.x + p.w));
  return atLeft(page, width) && Math.abs(width - right - MARGIN * page.scale) < 1e-9;
};

test('a phone-width page has one column, at its own size, on the page', () => {
  const page = layout(units, 390);
  assert.equal(page.columns, 1);
  assert.equal(page.scale, MOST);
  assert.ok(atLeft(page, 390));
  assert.ok(onPage(page.places, 390));
});

test("the book's page beside HQ, on an iPad or a desktop: one column at its own size, the rest paper at its right", () => {
  for (const width of [430, 500, 560, 580]) {
    const page = layout(units, width);
    assert.equal(page.columns, 1);
    assert.equal(page.scale, MOST, `${width} px: scale ${page.scale}`);
    assert.ok(atLeft(page, width), `${width} px: the column at the page's left`);
  }
});

test("a page's notes are never drawn past their own size, whatever its width", () => {
  for (const width of [600, 639, 700, 1000, 1400]) {
    const page = layout(units, width);
    assert.ok(page.scale <= MOST, `${width} px: scale ${page.scale}`);
    assert.ok(
      page.places.every(p => p.w <= UNIT_W * MOST),
      `${width} px: a note wider than its own`,
    );
  }
});

test('an iPad mini upright has two columns at its left', () => {
  const page = layout(units, 744);
  assert.equal(page.columns, 2);
  assert.ok(page.scale >= LEAST && page.scale <= MOST);
  assert.ok(atLeft(page, 744));
  assert.ok(onPage(page.places, 744));
  assert.deepEqual(new Set(page.places.map(p => p.column)), new Set([0, 1]));
});

test('a 4K-wide page has ten columns or more', () => {
  const page = layout(units, 3840);
  assert.ok(page.columns >= 10, `${page.columns} columns`);
  assert.ok(onPage(page.places, 3840));
});

// (the narrowest book's paper, the masonry's width: 400 px of book less its page block, its tools and the page's
// insets, on a tablet's keys and a desktop's: booklayout.js BOOK.min, book.css, bookunits.js; 310 and 314 px)
test("the narrowest book's page keeps both margins round its column, at LEAST of its size or more", () => {
  for (const width of [310, 314]) {
    const page = layout(units, width);
    assert.equal(page.columns, 1);
    assert.ok(page.scale >= LEAST - 1e-9, `${width} px: scale ${page.scale}`);
    assert.ok(atLeft(page, width), `${width} px: both margins`);
  }
});

test("a page narrower than a column at LEAST with both margins gives up the margin at its right before its notes' size", () => {
  for (const width of [widthFor(1) * LEAST - 16, widthFor(1) * LEAST - 4]) {
    const page = layout(units, width),
      [p] = page.places;
    assert.equal(page.columns, 1);
    assert.ok(page.scale >= LEAST - 1e-9, `${width} px: scale ${page.scale}, its words under LEAST of their size`);
    assert.equal(p.x, MARGIN * page.scale, `${width} px: the column off the page's left by its margin`);
    const right = width - p.x - p.w;
    assert.ok(
      right > -1e-9 && right < MARGIN * page.scale,
      `${width} px: ${right} px at the column's right, its margin`,
    );
  }
  // (where the column fits at LEAST with both margins, they stay; the scale never drops as a page of one column widens)
  assert.equal(rightMarginOf(widthFor(1) * LEAST), MARGIN);
  let was = 0;
  for (let width = 240; columnsOf(width) === 1; width += 2) {
    const { scale } = layout(units, width);
    assert.ok(scale >= was - 1e-9, `${width} px: scale ${scale} under ${was} at ${width - 2} px`);
    was = scale;
  }
});

test('a sliver of a page has one column scaled down so nothing runs off it', () => {
  const page = layout(units, 240);
  assert.equal(page.columns, 1);
  assert.ok(page.scale < 1);
  assert.ok(onPage(page.places, 240));
});

test('a page takes another column once it fits at LEAST of its size, never drawn past MOST', () => {
  for (let n = 1; n <= 12; n++) {
    assert.equal(columnsOf(widthFor(n + 1) * LEAST), n + 1);
    assert.equal(columnsOf(widthFor(n + 1) * LEAST - 1), n);
    for (const width of [widthFor(n + 1) * LEAST - 1, widthFor(n + 1) * LEAST, widthFor(n + 1)]) {
      const page = layout(units, width);
      assert.ok(page.scale >= LEAST && page.scale <= MOST && atLeft(page, width), `${width} px: scale ${page.scale}`);
      // (squeezed below its own size, it spans the page)
      if (page.scale < MOST) assert.ok(spans(page, width), `${width} px: the columns across the page`);
    }
  }
});

test('columnUnder finds the column at an x, the nearest beside the grid', () => {
  // (x in the masonry's px at scale 1, as bookunits.js gives it: the page's px at the layout's scale divided out)
  const { places, columns, scale } = layout(units, 1000);
  for (const p of places) assert.equal(columnUnder((p.x + p.w / 2) / scale, columns), p.column);
  assert.equal(columnUnder(-50, columns), 0);
  assert.equal(columnUnder(5000, columns), columns - 1);
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
    const { places, columns } = layout(page, widthFor(n) * LEAST);
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

test("what's drawn beside a note takes the columns it reaches into, so a wider page lays no note under it", () => {
  // (note 1 with a word written in the paper right of it on a one-column page, about 450 px from its left)
  const page = [{ id: 1, h: 200, w: 450 }, ...units.slice(1, 6)];
  for (const n of [1, 2, 3]) {
    const { places } = layout(page, widthFor(n)),
      first = places[0],
      reach = first.x + 450 * (first.w / UNIT_W);
    assert.equal(first.column, 0);
    for (const p of places.slice(1))
      assert.ok(p.x >= reach || p.y >= first.y + first.h, `${n} columns: unit ${p.id} under the word beside note 1`);
  }
  // (one reaching into the next column only by the space between them takes its own)
  const { places } = layout(
    [
      { id: 1, h: 200, w: UNIT_W + GAP },
      { id: 2, h: 100 },
    ],
    widthFor(2),
  );
  assert.deepEqual([places[1].column, places[1].y], [1, places[0].y]);
});
