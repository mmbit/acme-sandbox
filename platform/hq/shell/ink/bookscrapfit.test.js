// node --test platform/hq/shell/ink/bookscrapfit.test.js   (a scrap drawn to fit a narrow paper; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitOf, fitScraps, storedOf } from './bookscrapfit.js';
import { changesOf, emptyParts, keyOf } from './bookgroupmath.js';
import { moveBy, movedScrap, movedStroke } from './bookselectmath.js';
import { boxOf, STACK } from './notebookstack.js';

// (the controls' width, as bookui.js sets it on the book: one column, 52 px)
globalThis.getComputedStyle = () => ({ getPropertyValue: name => (name === '--bk-controls-width' ? '52px' : '') });
const bookOf = w => ({ desk: {}, size: { w, h: 800 } });

// A page holding a scrap as the store stacks it, with a line drawn on it, and a note of the board's
function pageOf() {
  const picture = { file: 'a.png', url: '/a.png', x: STACK.x, y: 80, w: STACK.w, h: 157, tilt: 0, g: 1 },
    onIt = {
      size: 2,
      points: [
        [100, 100],
        [200, 150],
      ],
      g: 1,
    },
    note = {
      size: 2,
      points: [
        [300, 900],
        [500, 950],
      ],
      g: 2,
    },
    stored = (id, kind, parts, box) => ({
      id,
      kind,
      box,
      ink: parts.ink ?? [],
      texts: [],
      pictures: parts.pictures ?? [],
      base: { ink: (parts.ink ?? []).map(keyOf), texts: [], pictures: (parts.pictures ?? []).map(keyOf) },
    });
  return {
    ink: [onIt, note],
    scraps: [picture],
    texts: [],
    groups: new Map([
      [1, stored(1, 'scrap', { ink: [onIt], pictures: [picture] }, { x: STACK.x, y: 80, w: STACK.w, h: 157 })],
      [2, stored(2, 'drawing', { ink: [note] }, { x: 299, y: 899, w: 202, h: 52 })],
    ]),
  };
}
// (as booksave.js compares a page with what it read: each element at the store's scale)
const changes = page =>
  changesOf(
    new Map([...page.groups.values()].map(g => [g.id, g.base])),
    new Map(
      [...page.groups.keys()].map(id => [
        id,
        {
          ...emptyParts(),
          ink: page.ink.filter(s => s.g === id).map(el => storedOf(page, el)),
          pictures: page.scraps.filter(s => s.g === id).map(el => storedOf(page, el)),
        },
      ]),
    ),
  );

test("a scrap past a phone's controls is drawn scaled about its top-left to end left of them; nothing to save", () => {
  const page = pageOf(),
    [was] = page.scraps;
  assert.equal(fitScraps(bookOf(342), page), true);
  const [s] = page.scraps,
    k = fitOf(page, 1),
    edge = 342 - 52 - 24;
  assert.ok(k > 0.7 && k < 0.8, `scaled by ${k}`);
  assert.deepEqual([s.x, s.y], [was.x, was.y], 'at its top-left');
  assert.ok(Math.abs(s.x + s.w - edge) < 0.01, 'ending left of the controls');
  assert.ok(Math.abs(s.h - was.h * k) < 0.01, 'its picture in proportion');
  assert.ok(Math.abs(page.ink[0].points[1][0] - (STACK.x + (200 - STACK.x) * k)) < 0.01, 'the line on it with it');
  assert.deepEqual(
    page.ink[1].points,
    [
      [300, 900],
      [500, 950],
    ],
    "the board's note as it is",
  );
  assert.equal(fitOf(page, 2), 1);
  assert.deepEqual(changes(page), { edits: [], deletes: [] }, "the store's own: nothing to save");
  assert.equal(keyOf(s), keyOf(was), 'compared as the store has it');
  assert.equal(Object.keys({ ...s }).includes('fit'), false, 'never sent, nor carried by a copy');
});

test("a fitted scrap moved, or drawn on, here is saved at the store's scale; wide paper draws it as the store has it", () => {
  const page = pageOf(),
    [was] = page.scraps;
  fitScraps(bookOf(342), page);
  const k = fitOf(page, 1),
    drag = moveBy(0, 40 * k),
    line = {
      size: 2,
      points: [
        [STACK.x + 50 * k, 80 + 60 * k],
        [STACK.x + 100 * k, 80 + 60 * k],
      ],
      g: 1,
    };
  // (Select drags the scrap and the ink on it 40 px of the store's down on this screen)
  page.scraps[0] = movedScrap(page.scraps[0], drag);
  page.ink[0] = movedStroke(page.ink[0], drag);
  page.ink.push(line);
  const { edits } = changes(page);
  assert.deepEqual(
    edits.map(e => e.id),
    [1],
    'an edit',
  );
  const [picture] = edits[0].parts.pictures,
    [onIt, drawn] = edits[0].parts.ink;
  assert.deepEqual([picture.w, picture.h], [was.w, was.h], 'its picture as wide as the store has it');
  assert.ok(Math.abs(picture.y - (was.y + 40 * k)) < 0.02, 'moved as far as it was dragged on the screen');
  assert.ok(Math.abs(onIt.points[0][1] - (100 + 40 * k)) < 0.02 && onIt.size === 2, 'the ink on it with it');
  assert.ok(
    Math.abs(drawn.points[0][0] - (STACK.x + 50)) < 0.02 && drawn.size > line.size,
    'the line drawn on it with it',
  );

  const wide = pageOf();
  assert.equal(fitScraps(bookOf(342), wide), true);
  assert.equal(fitScraps(bookOf(1000), wide), true, 'the paper sized wider');
  assert.deepEqual([wide.scraps[0].w, wide.scraps[0].h], [STACK.w, 157], 'as the store has it');
  assert.equal(fitOf(wide, 1), 1);
  assert.equal(fitScraps(bookOf(1000), wide), false, 'nothing more to draw again');
  assert.equal(fitScraps({ desk: {}, size: { w: 0, h: 0 } }, pageOf()), false, 'no paper yet: as stored');
});

test('a fitted scrap moved here is drawn where it was dropped once saved and fitted again', () => {
  const page = pageOf();
  fitScraps(bookOf(342), page);
  const drag = moveBy(0, 200);
  page.scraps[0] = movedScrap(page.scraps[0], drag);
  page.ink[0] = movedStroke(page.ink[0], drag);
  const dropped = { picture: page.scraps[0], onIt: page.ink[0] },
    [{ parts }] = changes(page).edits,
    saved = pageOf();
  // (the page read back as the store keeps the edit)
  saved.scraps = parts.pictures.map(el => ({ ...el, g: 1 }));
  saved.ink = [...parts.ink.map(el => ({ ...el, g: 1 })), saved.ink[1]];
  saved.groups.set(1, {
    ...saved.groups.get(1),
    box: boxOf(parts),
    ink: parts.ink,
    pictures: parts.pictures,
    base: { ink: parts.ink.map(keyOf), texts: [], pictures: parts.pictures.map(keyOf) },
  });
  assert.equal(fitScraps(bookOf(342), saved), true);
  const [s] = saved.scraps;
  assert.ok(
    ['x', 'y', 'w', 'h'].every(n => Math.abs(s[n] - dropped.picture[n]) < 0.05),
    `drawn at ${[s.x, s.y]}, dropped at ${[dropped.picture.x, dropped.picture.y]}`,
  );
  assert.ok(
    saved.ink[0].points.every((p, i) => p.every((v, j) => Math.abs(v - dropped.onIt.points[i][j]) < 0.05)),
    'the ink on it where it was dropped',
  );
});

test('a scrap with changes not saved yet, or one that would be drawn under LEAST wide, is left as it is', () => {
  const page = pageOf();
  page.scraps[0] = { ...page.scraps[0], y: 120 };
  assert.equal(fitScraps(bookOf(342), page), false, 'moved here, not yet saved');
  const far = pageOf();
  far.groups.get(1).box.x = 200;
  assert.equal(fitScraps(bookOf(342), far), false, 'room for 66 px only');
});

test('a scrap narrower than the stack ends left of the controls by its own width, or by its words when it has some', () => {
  const edge = 342 - 52 - 24,
    narrowed = (words, typed) => {
      const page = pageOf(),
        g = page.groups.get(1);
      if (typed) page.typed = new Map([[1, typed]]);
      page.scraps[0] = { ...page.scraps[0], w: 250, h: 125 };
      Object.assign(g, { box: { ...g.box, w: 250, h: 125 }, words, pictures: [page.scraps[0]] });
      g.base.pictures = [keyOf(page.scraps[0])];
      fitScraps(bookOf(342), page);
      return { s: page.scraps[0], k: fitOf(page, 1) };
    };
  const bare = narrowed(undefined);
  assert.ok(Math.abs(bare.s.x + bare.s.w - edge) < 0.01, `its picture ending there (${bare.s.x + bare.s.w})`);
  const worded = narrowed('A note under it');
  assert.ok(Math.abs(STACK.x + STACK.w * worded.k - edge) < 0.01, 'its words, as wide as the stack, ending there');
  const typing = narrowed(undefined, 'A note being typed');
  assert.ok(Math.abs(STACK.x + STACK.w * typing.k - edge) < 0.01, 'its words being typed, not saved yet, ending there');
});
