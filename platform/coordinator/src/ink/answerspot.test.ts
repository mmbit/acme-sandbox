// node --test src/ink/answerspot.test.ts   (where an answer lies: beside its group, else below, else further down,
// inside the paper)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER,
  NARROWEST,
  answerHeight,
  answerSpot,
  downAgain,
  spotBox,
  spotBoxes,
  type Box,
  type Spot,
} from './answerspot.ts';

const group: Box = { x: 140, y: 200, w: 240, h: 80 };
// (a wide page's paper; an answer exactly h tall at any width: ink, which doesn't wrap)
const paper = { x: 0, w: 1200 };
const tall = (h: number) => ({ ink: h - answerHeight({}) });
const spotOf = (h: number, taken: Box[], on = paper) => answerSpot(group, tall(h), taken, on);
// (a spot without its narrow one)
const wide = (s: Spot) => ({ dx: s.dx, dy: s.dy, w: s.w, h: s.h });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('free paper to the right: it lies beside the group, top-aligned', () => {
  assert.deepEqual(wide(spotOf(120, [group])), { dx: group.w + ANSWER.gap, dy: 0, w: ANSWER.w, h: 120 });
});

test("the right strip taken by the board's ink: below the group", () => {
  const beside: Box = { x: 480, y: 180, w: 200, h: 200 };
  assert.deepEqual(wide(spotOf(120, [group, beside])), { dx: 0, dy: group.h + ANSWER.gap, w: ANSWER.w, h: 120 });
});

test('right and below taken: the first free place further down, clear of everything, the page growing', () => {
  const beside: Box = { x: 480, y: 180, w: 200, h: 200 },
    under: Box = { x: 60, y: 300, w: 500, h: 300 };
  const taken = [group, beside, under];
  const spot = spotOf(120, taken),
    box = spotBox(group, spot);
  assert.equal(spot.dx, 0);
  assert.ok(box.y >= under.y + under.h + ANSWER.gap, `under what's there: y ${box.y}`);
  assert.ok(!taken.some(t => overlaps(box, t)));
});

test("a gap between two of the board's groups that fits is taken before the foot", () => {
  const beside: Box = { x: 480, y: 0, w: 400, h: 2000 },
    under: Box = { x: 60, y: 600, w: 500, h: 300 };
  const spot = spotOf(120, [group, beside, under]);
  assert.equal(spot.dy, group.h + ANSWER.gap, 'room between the group and the next one down');
  const tall = spotOf(400, [group, beside, under]);
  assert.ok(group.y + tall.dy >= under.y + under.h + ANSWER.gap, "too tall for the gap: past the board's next group");
});

test('answers already given are kept clear of too: a second answer goes under the first', () => {
  const first = spotBox(group, spotOf(120, [group]));
  const second = spotBox(group, spotOf(120, [group, first]));
  assert.ok(!overlaps(first, second));
  assert.ok(!overlaps(group, second));
});

test('a box in the way, however tall: one jump to the first line past its foot, not a line at a time', () => {
  const beside: Box = { x: 480, y: 0, w: 400, h: 1e12 },
    under: Box = { x: 60, y: 300, w: 500, h: 1e12 };
  const started = performance.now();
  const box = spotBox(group, spotOf(120, [group, beside, under]));
  assert.ok(performance.now() - started < 50, 'its work grows with the boxes, not their size');
  assert.ok(box.y >= under.y + under.h + ANSWER.gap && box.y < under.y + under.h + ANSWER.gap + ANSWER.line);
  assert.equal((box.y - (group.y + group.h + ANSWER.gap)) % ANSWER.line, 0, 'on the line grid');
});

test('a box whose foot falls on a line, an ulp off in floating point: past it, not stuck on it', () => {
  const note: Box = { x: 0, y: 0, w: 100, h: 18.74236903416586 },
    kept: Box = { x: 0, y: 100, w: 300, h: 62.74236903416588 },
    box = spotBox(note, answerSpot(note, {}, [note, kept], { x: 0, w: 400 }));
  assert.ok(!overlaps(box, kept) && !overlaps(box, note), `clear of both: ${JSON.stringify(box)}`);
});

test('a box far down the page, where a line is less than an ulp: past its foot, not stuck on it', () => {
  const note: Box = { x: 37, y: 165496896426334340, w: 6, h: 0 },
    kept: Box = { x: -3, y: -3, w: 606, h: 1069590488993428700 },
    box = spotBox(note, answerSpot(note, {}, [note, kept], { x: -3, w: 1203 }));
  assert.ok(!overlaps(box, kept), `clear of it: ${JSON.stringify(box)}`);
});

test("the right strip past the paper's edge less its controls: below, as wide as it was", () => {
  const narrow = { x: 0, w: group.x + group.w + ANSWER.gap + ANSWER.w + ANSWER.rail - 1 };
  assert.deepEqual(wide(spotOf(120, [group], narrow)), { dx: 0, dy: group.h + ANSWER.gap, w: ANSWER.w, h: 120 });
  const fits = { ...narrow, w: narrow.w + 1 };
  assert.equal(spotOf(120, [group], fits).dx, group.w + ANSWER.gap, 'just room: beside it');
});

test('a spot past the narrowest paper keeps a narrow spot: below its group there, clear of all, kept clear of after', () => {
  const note: Box = { x: 40, y: 60, w: 520, h: 80 },
    next: Box = { x: 40, y: 260, w: 300, h: 60 },
    a = { text: 'x'.repeat(90) },
    first = answerSpot(note, a, [note, next], paper),
    edge = NARROWEST - ANSWER.rail;
  assert.equal(first.dx, note.w + ANSWER.gap, 'beside it on the wide paper');
  const narrow = spotBox(note, first.narrow!);
  assert.ok(narrow.y >= note.y + note.h, `below it: ${JSON.stringify(narrow)}`);
  assert.ok(
    narrow.x >= ANSWER.strip && narrow.x + narrow.w <= edge,
    'inside the narrowest paper, right of its tool strip and left of its controls',
  );
  assert.equal(narrow.h, answerHeight(a, narrow.w), 'as tall as it is at its width');
  assert.ok(![note, next].some(g => overlaps(narrow, g)), "clear of the board's groups");
  // the next answer keeps clear of both, on whichever screen either is drawn
  const second = answerSpot(next, a, [note, next, ...spotBoxes(note, first)], paper);
  for (const b of spotBoxes(next, second))
    for (const t of [note, ...spotBoxes(note, first)]) assert.ok(!overlaps(b, t), `${JSON.stringify(b)} clear`);
  // a spot inside the narrowest paper needs none
  assert.equal(answerSpot({ ...note, w: 40 }, {}, [], { x: 0, w: NARROWEST }).narrow, undefined);
});

test('the narrowest paper placed for has room for an answer at its least between the tool strip and the controls', () => {
  assert.ok(NARROWEST >= ANSWER.narrowest);
  assert.equal(NARROWEST - ANSWER.rail - ANSWER.strip, ANSWER.least);
  const note: Box = { x: 40, y: 60, w: 520, h: 80 },
    narrow = spotBox(note, answerSpot(note, {}, [note], paper).narrow!);
  assert.deepEqual([narrow.x, narrow.w], [ANSWER.strip, ANSWER.least]);
});
test("never under the tool strip at the paper's left: below a group under it, at the strip's right", () => {
  for (const x of [0, 40, 60, 100]) {
    const note: Box = { x, y: 60, w: 520, h: 80 },
      spot = answerSpot(note, { text: 'x'.repeat(90) }, [note], paper);
    for (const b of spotBoxes(note, spot)) {
      assert.ok(b.x >= ANSWER.strip, `right of the strip: ${JSON.stringify(b)}`);
      if (b.y > note.y) assert.ok(b.x <= Math.max(x, ANSWER.strip), "below it: at its x or the strip's right, or in");
    }
  }
  const small: Box = { x: 0, y: 60, w: 40, h: 40 };
  assert.equal(spotBox(small, answerSpot(small, {}, [small], paper)).x, ANSWER.strip, 'beside it: past the strip');
});

test('a spot the board wrote on later, its narrow one or its wide one: moved down clear of it and the rest, as wide', () => {
  const note: Box = { x: 140, y: 60, w: 520, h: 80 },
    spot = answerSpot(note, { text: 'x'.repeat(90) }, [note], paper);
  for (const s of [spot.narrow!, spot]) {
    const was = spotBox(note, s),
      later: Box = { x: was.x - 100, y: was.y + 10, w: 400, h: 60 },
      other: Box = { x: was.x + 20, y: later.y + later.h + ANSWER.gap, w: 200, h: 40 };
    const moved = spotBox(note, downAgain(note, s, [note, later, other]));
    assert.deepEqual([moved.x, moved.w, moved.h], [was.x, was.w, was.h]);
    assert.ok(moved.y > was.y && ![note, later, other].some(b => overlaps(moved, b)), JSON.stringify(moved));
  }
});

test("below a group near the paper's edge: narrowed to the room there, moved in when that's less than its least", () => {
  const phone = { x: 0, w: 390 },
    edge = phone.w - ANSWER.rail;
  for (const x of [60, 200, 300]) {
    const near: Box = { ...group, x },
      a = { text: 'x'.repeat(120) },
      spot = answerSpot(near, a, [near], phone),
      box = spotBox(near, spot);
    assert.ok(
      box.x >= phone.x && box.x + box.w <= edge,
      `inside the paper, left of its controls: ${JSON.stringify(box)}`,
    );
    assert.ok(box.w >= ANSWER.least, 'never narrower than its least');
    assert.equal(spot.h, answerHeight(a, spot.w), 'its height kept at its width');
    assert.ok(!overlaps(box, near), 'clear of its group');
  }
  assert.equal(answerSpot({ ...group, x: 120 }, {}, [], phone).w, edge - 120, 'as wide as the room under it');
});

test("an answer's height at a width: its words wrap to more lines, a picture scales to it", () => {
  const words = { text: 'x'.repeat(64) };
  assert.equal(answerHeight(words, ANSWER.w / 2) - answerHeight(words), 2 * ANSWER.line);
  const picture = { picture: { width: 600, height: 400 } };
  assert.equal(answerHeight(picture, 150) - answerHeight({}, 150), 100);
});

test("an answer's height: its words' lines, a picture at its width, a form's fields", () => {
  const words = answerHeight({ text: 'x'.repeat(64) });
  assert.equal(words, ANSWER.head + 2 * ANSWER.line + ANSWER.reply);
  assert.equal(answerHeight({ text: 'a\nb' }), ANSWER.head + 2 * ANSWER.line + ANSWER.reply);
  assert.equal(answerHeight({ text: '', picture: { width: 600, height: 400 } }) - answerHeight({ text: '' }), 200);
  assert.equal(answerHeight({ text: 'Pick', questions: 2 }) - answerHeight({ text: 'Pick' }), 2 * ANSWER.question);
});
