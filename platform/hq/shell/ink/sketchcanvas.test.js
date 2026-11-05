// node --test platform/hq/shell/ink/sketchcanvas.test.js   (a sketch page's units at their places; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATE_ABOVE, canvasOf, daysOf, pushedDown } from './sketchcanvas.js';
import { UNIT_W } from './scrapunit.js';
import { GAP, layout, widthFor } from './masonry.js';

// Whether two boxes ({ x, y, w, h }) cover some of each other
const covers = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// A note the board typed at a place, h tall, with what hangs under it below tall
const note = (id, x, y, h, below = 0) => ({ id, h, w: UNIT_W, below, place: { x, y } });

test("what hangs under a placed note covers none of the board's notes nor what hangs under another", () => {
  // (three notes one under another, an answer come under the first, a waiting face under the second)
  const units = [note(1, 20, 100, 60, 90), note(2, 20, 170, 60, 40), note(3, 20, 240, 60)],
    { places } = canvasOf(units, widthFor(2));
  const boxes = places.map((p, i) => ({ x: p.x, y: p.y, w: units[i].w, h: units[i].h })),
    hung = places.filter((p, i) => units[i].below).map(p => p.hung);
  assert.deepEqual(
    places.map(p => [p.x, p.y]),
    units.map(u => [u.place.x, u.place.y]),
    'every note where it was',
  );
  for (const h of hung) for (const b of boxes) assert.ok(!covers(h, b), `${JSON.stringify(h)} clear of a note`);
  assert.ok(!covers(hung[0], hung[1]), 'the two clear of each other');
  assert.deepEqual(places[0].hung, { x: 20 + UNIT_W + GAP, y: 100, w: UNIT_W, h: 90 }, 'beside its note, at its right');
  assert.deepEqual(places[1].hung, { x: 20 - GAP - UNIT_W, y: 170, w: UNIT_W, h: 40 }, 'its right taken: at its left');
  for (const i of [0, 1]) itsOwn(places[i].hung, boxes, i);
});

test('an answer under the first of notes stacked a gap apart hangs beside it, level with it, not under the last', () => {
  // (nine notes 74 px tall, 98 px apart, as the masonry stacked them and the page pinned them; a 60 px answer under the
  // first)
  const units = Array.from({ length: 9 }, (_, i) => note(i + 1, 24, 100 + 98 * i, 74, i ? 0 : 60)),
    { places } = canvasOf(units, widthFor(1));
  assert.deepEqual(places[0].hung, { x: 24 + UNIT_W + GAP, y: 100, w: UNIT_W, h: 60 });
});

// Whether the box hung under notes[i] reads as that note's: tied to it, by a line from its top over no note nor what
// hangs under another (others) to the box's top, or with no tie, its top-left nearer the note's than any other note's
function itsOwn(hung, notes, i, others = []) {
  const own = notes[i];
  if (!hung.tie) {
    const far = b => Math.hypot(hung.x - b.x, hung.y - b.y);
    for (const b of notes.filter(b => b !== own))
      assert.ok(far(own) < far(b), `nearer its note than ${JSON.stringify(b)}`);
    return;
  }
  const [from, to] = [hung.tie[0], hung.tie.at(-1)];
  assert.ok(from[1] === own.y && from[0] > own.x && from[0] < own.x + own.w, `tied from its note's top: ${from}`);
  assert.ok(to[1] === hung.y && to[0] > hung.x && to[0] < hung.x + hung.w, `tied to its top: ${to}`);
  for (const line of linesOf(hung.tie))
    for (const b of [...notes, ...others])
      assert.ok(!covers(line, b), `the tie ${JSON.stringify(line)} over no note: ${JSON.stringify(b)}`);
}
// (a tie's lines, each as a box as wide as a line)
const linesOf = tie =>
  tie.slice(1).map(([x1, y1], k) => {
    const [x0, y0] = tie[k];
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  });
// Every answer hung under notes[i] for i in asked its own note's, clear of every note and of the other answers, and no
// tie across, along or onto another
function allTheirOwn(places, notes, asked) {
  const hung = asked.map(i => places[i].hung);
  asked.forEach((i, k) => {
    const others = hung.filter((_, m) => m !== k);
    itsOwn(hung[k], notes, i, others);
    for (const b of [...notes, ...others])
      assert.ok(!covers(hung[k], b), `${i}'s answer clear of ${JSON.stringify(b)}`);
  });
  // (a line a pixel wider either side meets another where it crosses it, runs along it or ends on it)
  const lines = hung.map(h => linesOf(h.tie ?? []).map(l => ({ x: l.x - 1, y: l.y - 1, w: l.w + 2, h: l.h + 2 })));
  lines.forEach((mine, k) => {
    for (const theirs of hung.filter((h, m) => m !== k && h.tie).flatMap(h => linesOf(h.tie)))
      for (const line of mine) assert.ok(!covers(line, theirs), `${JSON.stringify(theirs)} across ${asked[k]}'s tie`);
  });
}

test("with paper taken on both sides of its note, what hangs under it goes past its row's nearer end, tied to it", () => {
  // (a 3x3 grid of notes 74 px tall, 98 px apart, as the masonry laid them at three columns and the page pinned them; a
  // 60 px answer under the middle one of the first row, and under the one at its end)
  const units = Array.from({ length: 9 }, (_, i) =>
      note(i + 1, [24, 368, 712][i % 3], 100 + 98 * Math.floor(i / 3), 74, i === 1 || i === 2 ? 60 : 0),
    ),
    { places } = canvasOf(units, widthFor(3)),
    notes = units.map(u => ({ ...u.place, w: u.w, h: u.h }));
  assert.ok(places[1].hung.tie, 'the middle note boxed in: its answer tied to it');
  assert.deepEqual(
    places[2].hung,
    { x: 712 + UNIT_W + GAP, y: 100, w: UNIT_W, h: 60 },
    'the end one beside its own note',
  );
  for (const i of [1, 2]) {
    itsOwn(places[i].hung, notes, i);
    for (const b of notes) assert.ok(!covers(places[i].hung, b), `clear of the note at ${JSON.stringify(b)}`);
  }
  assert.ok(!covers(places[1].hung, places[2].hung), 'the two answers clear of each other');
});

test('past the nearer end of its row: left of the leftmost where that is nearer, tied to it', () => {
  // (a note with one note left of it and three right of it, an answer under it, a note below it)
  const units = [
      ...[100, 444, -244, 788, 1132].map((x, i) => note(i + 1, x, 100, 60, i ? 0 : 90)),
      note(6, 100, 184, 60),
    ],
    { places } = canvasOf(units, widthFor(3));
  assert.ok(places[0].hung.x < -244, `left of the leftmost: ${places[0].hung.x}`);
  itsOwn(
    places[0].hung,
    units.map(u => ({ ...u.place, w: u.w, h: u.h })),
    0,
  );
});

test('answers under four middle notes of a full row of seven are each tied to their own, no tie across another', () => {
  // (two rows of seven notes 74 px tall, 98 px apart; 60 px answers under the second to the fifth of the first)
  const units = Array.from({ length: 14 }, (_, i) =>
      note(i + 1, 24 + 344 * (i % 7), 100 + 98 * Math.floor(i / 7), 74, i >= 1 && i <= 4 ? 60 : 0),
    ),
    { places } = canvasOf(units, widthFor(3));
  allTheirOwn(
    places,
    units.map(u => ({ ...u.place, w: u.w, h: u.h })),
    [1, 2, 3, 4],
  );
});

test('a boxed-in note on a staggered masonry: its tie climbs round the note over it, never through it', () => {
  // (tall notes either side of a column of three short ones; a 60 px answer under the middle one)
  const units = [
      note(1, 24, 100, 300),
      note(2, 368, 100, 74),
      note(3, 368, 198, 74, 60),
      note(4, 368, 296, 74),
      note(5, 712, 100, 300),
    ],
    { places } = canvasOf(units, widthFor(3));
  assert.ok(places[2].hung.tie, 'tied to it');
  allTheirOwn(
    places,
    units.map(u => ({ ...u.place, w: u.w, h: u.h })),
    [2],
  );
});

test('answers under five middle notes of a full row with a row over it and one under it: no tie over a note', () => {
  // (three rows of seven notes 74 px tall, 98 px apart; 60 px answers under the five middle ones of the second)
  const units = Array.from({ length: 21 }, (_, i) =>
      note(i + 1, 24 + 344 * (i % 7), 100 + 98 * Math.floor(i / 7), 74, i >= 8 && i <= 12 ? 60 : 0),
    ),
    { places } = canvasOf(units, widthFor(3));
  allTheirOwn(
    places,
    units.map(u => ({ ...u.place, w: u.w, h: u.h })),
    [8, 9, 10, 11, 12],
  );
});

test('answers under notes of a staggered masonry, as the masonry laid notes of every height, each its own', () => {
  // (thirty notes 74 to 234 px tall laid in three columns and pinned there; 60 px answers under notes boxed in by
  // others and one at a column's edge)
  const hs = Array.from({ length: 30 }, (_, i) => 74 + ((i * 37) % 5) * 40),
    { places: laid } = layout(
      hs.map((h, i) => ({ id: i + 1, h })),
      widthFor(3),
    ),
    // (four in the middle column, one in the left: as the masonry staggers them at its GAP.)
    asked = [8, 10, 13, 17, 19],
    units = laid.map((p, i) => note(i + 1, p.x, p.y, hs[i], asked.includes(i) ? 60 : 0)),
    { places } = canvasOf(units, widthFor(3));
  assert.deepEqual(
    asked.map(i => laid[i].column),
    [1, 1, 1, 1, 0],
    'boxed in, but for one at the edge',
  );
  assert.ok(asked.filter(i => places[i].hung.tie).length >= 3, 'boxed in on every side: most tied past their rows');
  allTheirOwn(
    places,
    units.map(u => ({ ...u.place, w: u.w, h: u.h })),
    asked,
  );
});

test("where the board's drawing closes every way round, the answer is still tied from its own note's top", () => {
  // (tall drawings either side of the question, a note under it, and a label whose arrow runs down 6 px into the
  // question's top, or a word ending 4 px over it: no clear way out; a 60 px answer under the question)
  for (const label of [
    { x: 200, y: 40, w: 340, h: 136 },
    { x: 468, y: 46, w: 120, h: 128 },
  ]) {
    const units = [
        note(1, 24, 100, 300),
        note(2, 368, 170, 74, 60),
        note(3, 368, 268, 74),
        note(4, 712, 100, 300),
        { id: 5, h: label.h, w: label.w, below: 0, place: { x: label.x, y: label.y } },
      ],
      { places } = canvasOf(units, widthFor(3)),
      notes = units.map(u => ({ ...u.place, w: u.w, h: u.h })),
      { hung } = places[1],
      [from, to] = [hung.tie[0], hung.tie.at(-1)];
    assert.ok(from[1] === 170 && from[0] > 368 && from[0] < 368 + UNIT_W, `tied from its note's top: ${from}`);
    assert.ok(to[1] === hung.y && to[0] > hung.x && to[0] < hung.x + hung.w, `tied to its top: ${to}`);
    for (const b of notes) assert.ok(!covers(hung, b), `clear of ${JSON.stringify(b)}`);
    for (const line of linesOf(hung.tie))
      for (const b of [0, 2, 3].map(i => notes[i]))
        assert.ok(!covers(line, b), `over only the drawing on its own: ${JSON.stringify(line)} not over ${b.x},${b.y}`);
  }
});

test('what hangs under a note with clear paper below it stays at its foot', () => {
  const { places } = canvasOf([note(1, 20, 100, 60, 90), note(2, 400, 100, 60)], widthFor(2));
  assert.deepEqual(places[0].hung, { x: 20, y: 160, w: UNIT_W, h: 90 });
});

test('a note with no place yet lands under every placed note and what hangs under it, with its own room', () => {
  const units = [note(1, 20, 100, 60, 90), { id: 2, h: 50, w: UNIT_W, below: 30 }],
    { places, fresh } = canvasOf(units, widthFor(2));
  assert.deepEqual(fresh, [2]);
  assert.ok(places[1].y >= 100 + 60 + 90, `under the answer: ${places[1].y}`);
  assert.deepEqual(places[1].hung, { x: places[1].x, y: places[1].y + 50, w: UNIT_W, h: 30 });
});

test("a note's room dragged taller pushes what's under it and below its foot down, never what's beside it", () => {
  const places = [
      { id: 1, place: { x: 8, y: 100 } },
      // (under the note, already over its foot: still pushed, never left under it)
      { id: 2, place: { x: 8, y: 380 } },
      // (beside it, starting lower than its top but above its foot: stays)
      { id: 3, place: { x: 400, y: 150 } },
      // (below its foot, anywhere across: pushed)
      { id: 4, place: { x: 400, y: 500 } },
      { id: 5, place: null },
    ],
    push = { top: 100, from: 400, x0: 8, x1: 8 + UNIT_W, by: 120 };
  assert.deepEqual(pushedDown(places, push), [
    { id: 2, place: { x: 8, y: 500 } },
    { id: 4, place: { x: 400, y: 620 } },
  ]);
  assert.deepEqual(pushedDown(places, { ...push, by: 0 }), [], 'shrinking moves nothing');
  assert.deepEqual(pushedDown(places, undefined), []);
});

test("a sketch page's dates: over the first scrap of each later day, never over the board's drawing", () => {
  const units = [
      { id: 1, day: '2026-11-02' },
      { id: 2, day: '2026-11-03', drawn: true },
      { id: 3, day: '2026-11-03' },
      { id: 4, day: '2026-11-03' },
      { id: 5, day: '2026-11-04', drawn: true },
    ],
    places = new Map(units.map((u, k) => [u.id, { x: 8, y: 100 + k * 200 }]));
  assert.deepEqual(daysOf(units, places, '2026-11-02'), [{ day: '2026-11-03', x: 8, y: 500 - DATE_ABOVE }]);
  assert.deepEqual(daysOf(units.slice(0, 2), places, '2026-11-02'), [], 'free drawing alone dates nothing');
});

test('a scrap come on a later day lands with room above it for its date; on the same day, none', () => {
  const placed = { id: 1, h: 200, w: UNIT_W, below: 0, place: { x: 8, y: 100 }, day: '2026-11-02' },
    later = { id: 2, h: 200, w: UNIT_W, below: 0, day: '2026-11-03' },
    same = { ...later, day: '2026-11-02' };
  const y = u => canvasOf([placed, u], 400, { x: 8, y: 72 }).places[1].y;
  assert.equal(y(later) - y(same), 20);
});
