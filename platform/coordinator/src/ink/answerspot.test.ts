// node --test src/ink/answerspot.test.ts   (where an answer lies: beside its group, else below, else further down,
// inside the paper)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER,
  NARROWER,
  NARROWEST,
  answerHeight,
  answerSpot,
  downAgain,
  overlapping,
  spotAgain,
  spotBox,
  spotBoxes,
  spotChain,
  type Box,
  type Spot,
} from './answerspot.ts';
import { boardScreens } from '../screens.ts';
import { BOOK, paperWidth } from '../../../hq/shell/ink/booklayout.js';

const group: Box = { x: 140, y: 200, w: 240, h: 80 };
// (a wide page's paper; an answer exactly h tall at any width: ink, which doesn't wrap)
const paper = { x: 0, w: 1200 };
const tall = (h: number) => ({ ink: h - answerHeight({}) });
const spotOf = (h: number, taken: Box[], on = paper) => answerSpot(group, tall(h), taken, on);
// (a spot without its narrow ones)
const wide = ({ narrow: _narrow, ...s }: Spot) => s;
// (as wide as it can be on paper w wide: an answer's full width, else all the room between the paper's inset and its
// controls)
const widest = (b: Box, w: number) => b.w === ANSWER.w || (b.x === ANSWER.inset && b.x + b.w === w - ANSWER.rail);

test('free paper to the right: it lies beside the group, top-aligned', () => {
  assert.deepEqual(wide(spotOf(120, [group])), { dx: group.w + ANSWER.gap, dy: 0, w: ANSWER.w, h: 120 });
});

test("the right strip taken by the board's ink: below the group", () => {
  const beside: Box = { x: 600, y: 180, w: 200, h: 200 };
  assert.deepEqual(wide(spotOf(120, [group, beside])), { dx: 0, dy: group.h + ANSWER.gap, w: ANSWER.w, h: 120 });
});

test('right and below taken: the first free place further down, clear of everything, the page growing', () => {
  const beside: Box = { x: 600, y: 180, w: 200, h: 200 },
    under: Box = { x: 60, y: 300, w: 500, h: 300 };
  const taken = [group, beside, under];
  const spot = spotOf(120, taken),
    box = spotBox(group, spot);
  assert.equal(spot.dx, 0);
  assert.ok(box.y >= under.y + under.h + ANSWER.gap, `under what's there: y ${box.y}`);
  assert.ok(!taken.some(t => overlapping(box, t)));
});

test("a gap between two of the board's groups that fits is taken before the foot", () => {
  const beside: Box = { x: 600, y: 0, w: 400, h: 2000 },
    under: Box = { x: 60, y: 600, w: 500, h: 300 };
  const spot = spotOf(120, [group, beside, under]);
  assert.equal(spot.dy, group.h + ANSWER.gap, 'room between the group and the next one down');
  const tall = spotOf(400, [group, beside, under]);
  assert.ok(group.y + tall.dy >= under.y + under.h + ANSWER.gap, "too tall for the gap: past the board's next group");
});

test('answers already given are kept clear of too: a second answer goes under the first', () => {
  const first = spotBox(group, spotOf(120, [group]));
  const second = spotBox(group, spotOf(120, [group, first]));
  assert.ok(!overlapping(first, second));
  assert.ok(!overlapping(group, second));
});

test('a box in the way, however tall: one jump to the first line past its foot, not a line at a time', () => {
  const beside: Box = { x: 600, y: 0, w: 400, h: 1e12 },
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
  assert.ok(!overlapping(box, kept) && !overlapping(box, note), `clear of both: ${JSON.stringify(box)}`);
});

test('a box far down the page, where a line is less than an ulp: past its foot, not stuck on it', () => {
  const note: Box = { x: 37, y: 165496896426334340, w: 6, h: 0 },
    kept: Box = { x: -3, y: -3, w: 606, h: 1069590488993428700 },
    box = spotBox(note, answerSpot(note, {}, [note, kept], { x: -3, w: 1203 }));
  assert.ok(!overlapping(box, kept), `clear of it: ${JSON.stringify(box)}`);
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
  const narrowest = spotBox(note, spotChain(first).at(-1)!);
  assert.ok(narrowest.y >= note.y + note.h, `below it: ${JSON.stringify(narrowest)}`);
  assert.ok(narrowest.x >= 0 && narrowest.x + narrowest.w <= edge, 'inside the narrowest paper, left of its controls');
  assert.equal(narrowest.h, answerHeight(a, narrowest.w), 'as tall as it is at its width');
  for (const b of spotBoxes(note, first).slice(1))
    assert.ok(![note, next].some(g => overlapping(b, g)), `clear of the board's groups: ${JSON.stringify(b)}`);
  // the next answer keeps clear of all of them, on whichever screen either is drawn
  const second = answerSpot(next, a, [note, next, ...spotBoxes(note, first)], paper);
  for (const b of spotBoxes(next, second))
    for (const t of [note, ...spotBoxes(note, first)]) assert.ok(!overlapping(b, t), `${JSON.stringify(b)} clear`);
  // a spot inside the narrowest paper needs none
  assert.equal(answerSpot({ ...note, w: 40 }, {}, [], { x: 0, w: NARROWEST }).narrow, undefined);
});

// (an answer at a readable width on every paper wide enough for it, narrower only where the paper is)
test('one narrow spot for each narrower paper it runs past, widest first, each left of that paper’s controls', () => {
  const note: Box = { x: 40, y: 60, w: 520, h: 80 },
    spots = spotChain(answerSpot(note, { text: 'x'.repeat(200) }, [note], paper));
  assert.equal(spots.length, 1 + NARROWER.length, 'the wide spot, then one a paper');
  for (const [i, w] of NARROWER.entries()) {
    const b = spotBox(note, spots[i + 1]);
    assert.ok(b.x >= ANSWER.inset && b.x + b.w <= w - ANSWER.rail, `inside ${w} px of paper, left of its controls`);
    assert.ok(widest(b, w), `as wide as ${w} px of paper allows: ${JSON.stringify(b)}`);
  }
});

// (whichever screens the company's settings name: each gives the book beside HQ's page and the book at its least)
test("a paper for each of the board's screens, each width once, widest first", () => {
  for (const { width, height } of boardScreens())
    for (const book of [null, BOOK.min])
      assert.ok(NARROWER.includes(paperWidth(width, height, { mode: 'open', book })));
  assert.ok(
    NARROWER.every((w, i) => i === 0 || w < NARROWER[i - 1]),
    `widest first, once each: ${NARROWER}`,
  );
});

test('an answer is written at a readable width, not a column', () => {
  const note: Box = { x: 40, y: 60, w: 520, h: 80 },
    beside = spotChain(answerSpot(note, {}, [note], paper))[1];
  assert.ok(widest(spotBox(note, beside), NARROWER[0]), "on the book beside HQ's page, as wide as the paper lets it");
  assert.ok(beside.w >= 0.8 * ANSWER.w, 'no column');
});
// (the tool strip sits with the controls at the paper's right: the left is the page's but for a phone's pull tab)
test("the paper's left is the board's: an answer beside a group there, below one only its inset in", () => {
  const small: Box = { x: 0, y: 60, w: 40, h: 40 };
  assert.equal(spotBox(small, answerSpot(small, {}, [small], paper)).x, small.w + ANSWER.gap);
  const across: Box = { x: 0, y: 60, w: 1000, h: 40 };
  assert.equal(spotBox(across, answerSpot(across, {}, [across], paper)).x, ANSWER.inset);
});

test('a spot the board wrote on later, its narrow one or its wide one: moved down clear of it and the rest, as wide', () => {
  const note: Box = { x: 140, y: 60, w: 520, h: 80 },
    spot = answerSpot(note, { text: 'x'.repeat(90) }, [note], paper);
  for (const s of spotChain(spot)) {
    const was = spotBox(note, s),
      later: Box = { x: was.x - 100, y: was.y + 10, w: 400, h: 60 },
      other: Box = { x: was.x + 20, y: later.y + later.h + ANSWER.gap, w: 200, h: 40 };
    const moved = spotBox(note, downAgain(note, s, [note, later, other]));
    assert.deepEqual([moved.x, moved.w, moved.h], [was.x, was.w, was.h]);
    assert.ok(moved.y > was.y && ![note, later, other].some(b => overlapping(moved, b)), JSON.stringify(moved));
  }
});

test("below a group near the paper's edge: moved in to the left, as wide as the paper left of its controls lets it", () => {
  const phone = { x: 0, w: NARROWEST },
    edge = phone.w - ANSWER.rail;
  for (const x of [60, 200, 300]) {
    const near: Box = { ...group, x },
      a = { text: 'x'.repeat(120) },
      spot = answerSpot(near, a, [near], phone),
      box = spotBox(near, spot);
    assert.ok(
      box.x >= phone.x + ANSWER.inset && box.x + box.w <= edge,
      `inside the paper, left of its controls: ${JSON.stringify(box)}`,
    );
    assert.ok(widest(box, phone.w), 'as wide as the room left of the controls');
    assert.equal(spot.h, answerHeight(a, spot.w), 'its height kept at its width');
    assert.ok(!overlapping(box, near), 'clear of its group');
  }
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
  assert.equal(
    answerHeight({ text: '', picture: { width: 600, height: 400 } }) - answerHeight({ text: '' }),
    Math.round((400 * ANSWER.w) / 600),
  );
  assert.equal(answerHeight({ text: 'Pick', questions: 2 }) - answerHeight({ text: 'Pick' }), 2 * ANSWER.question);
});

// (the spot HQ draws on paper w wide, as bookanswers.js spotHere walks the chain)
const drawnOn = (s: Spot, w: number) => {
  while (s.narrow && group.x + s.dx + s.w > w - ANSWER.rail) s = s.narrow;
  return s;
};
test('a spot kept from before the controls grew: placed again, its spot on every paper left of the controls', () => {
  // (beside its group on a wide page, its narrow spot below it from page x 100 to 280: left of the controls on the
  // book beside HQ's page, under them on a phone's)
  // (a phone's: the first paper under it, whichever screens the company names)
  const narrow = { dx: -40, dy: 104, w: 180, h: 200 },
    old: Spot = { dx: 264, dy: 0, w: 400, h: 120, narrow },
    [beside] = NARROWER,
    phone = NARROWER.find(w => 280 > w - ANSWER.rail)!;
  assert.ok(280 <= beside - ANSWER.rail && phone !== undefined, 'the papers this test is about');
  const again = spotAgain(group, old, tall(120), [group], paper);
  assert.deepEqual(wide(again), wide(old), 'the wide spot still fits: kept');
  assert.deepEqual(wide(drawnOn(again, beside)), narrow, 'and the narrow one where it still fits');
  for (const w of NARROWER) {
    const box = spotBox(group, drawnOn(again, w));
    assert.ok(box.x >= 0 && box.x + box.w <= w - ANSWER.rail, `on ${w} px paper: ${JSON.stringify(box)}`);
    assert.ok(!overlapping(box, group), 'clear of its group');
  }
  assert.notDeepEqual(wide(drawnOn(again, phone)), narrow, "a phone's: a new spot");
  // (one with no narrow spot, kept between x 100 and 280 under the old rules: one for the phone now)
  const lone: Spot = { dx: -40, dy: 104, w: 180, h: 200 },
    placed = spotAgain(group, lone, tall(200), [group], paper);
  assert.deepEqual(wide(placed), lone, 'kept where it fits');
  for (const w of NARROWER) {
    const box = spotBox(group, drawnOn(placed, w));
    assert.ok(box.x + box.w <= w - ANSWER.rail, `on ${w} px paper: ${JSON.stringify(box)}`);
  }
});

test("a kept spot that's no longer clear of the page's boxes is placed again", () => {
  const old: Spot = { dx: 264, dy: 0, w: 400, h: 120 },
    beside: Box = { x: 600, y: 180, w: 200, h: 200 };
  const box = spotBox(group, spotAgain(group, old, tall(120), [group, beside], paper));
  assert.ok(!overlapping(box, beside) && !overlapping(box, group), JSON.stringify(box));
});
