// book-check.mjs's stories of the book's drawing tools (shell/ink/bookpalette.js, bookerase.js, bookshapes.js,
// bookselect.js, bookedit.js; Ink's folder): with a mouse on a desktop and with
// the Pencil on an iPad mini, ink erased at two sizes (cut where the eraser passed, the rest kept), an ellipse and a
// rectangle filled and outlined and an arrow, some ink and a picture selected, moved, cut, pasted and deleted, and Undo
// taking every step back and Redo making them again. Each asserts what the board sees (pixels on the book's paper) and
// what the store keeps (the page saved). Each draws in a new scrap opened by a click (a tap) on the blank page.
import assert from 'node:assert/strict';
import { colourIn, freePage, line, onDesk, paperBox, pasteGreen, pick, savedWhere, GREEN } from './mouse.mjs';
import { MINI, openScrap, pressAlong, shotPixels } from './kit.mjs';
import { WIDTHS } from '../shell/ink/bookinkmath.js';

const NIGHT = [42, 35, 82];

// c: book-check.mjs's played store and helpers (mouse.mjs's)
export function drawStories(c) {
  return {
    'with a mouse: the eraser at two sizes, shapes outlined and filled, an arrow, and Undo and Redo all of it':
      browser => erasesAndShapes(browser, c),
    'with a mouse: ink and a picture selected, moved, cut, pasted and deleted, and Undo all of it': browser =>
      selects(browser, c),
    'with the Pencil on an iPad mini: erased, a shape, a selection moved, and Undo': browser => pencil(browser, c),
  };
}

// ---- the stories

async function erasesAndShapes(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const box = await sheetOn(page, mouse(page)),
      at = [box.x + 100, box.y + 200];
    await erases(page, c, free, at, box);
    const drawn = await shapes(page, c, free, at);
    // Undo takes every step back, the page empty again; Redo makes them all again
    await page.mouse.move(at[0] + 200, at[1] + 400);
    for (let i = 0; i < 7; i++) await page.keyboard.press('Control+z');
    await savedWhere(c, free.id, p => p.ink.length === 0);
    for (let i = 0; i < 7; i++) await page.keyboard.press('Control+Shift+z');
    const again = await savedWhere(c, free.id, p => p.ink.length === 7);
    assert.deepEqual(again.ink, drawn.ink, 'Redo makes the same strokes again');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// Two lines, each cut by one pass of the eraser: a fine one, then a wide one
async function erases(page, c, free, [x, y], box) {
  await pick(page, 'Pen');
  await drag(page, [x, y], [x + 360, y]);
  await drag(page, [x, y + 110], [x + 360, y + 110]);
  await savedWhere(c, free.id, p => p.ink.length === 2);
  // the eraser, fine: one pass down through the first line cuts it in two
  await pick(page, 'Eraser');
  await card(page, 'Fine eraser');
  // (the card stays open over the paper beside the strip: Escape closes it.)
  await page.keyboard.press('Escape');
  await pass(page, x + 120, y - 40, 80);
  await savedWhere(c, free.id, p => p.ink.length === 3);
  // wide: through the second, a wider gap
  await card(page, 'Wide eraser');
  await page.keyboard.press('Escape');
  await pass(page, x + 120, y + 70, 80);
  const erased = await savedWhere(c, free.id, p => p.ink.length === 4);
  const fine = await gapIn(page, box, y),
    wide = await gapIn(page, box, y + 110);
  assert.ok(fine > 6 && fine < 30, `the fine eraser's gap: ${fine} px`);
  assert.ok(wide > fine + 20, `the wide eraser's gap (${wide} px) wider than the fine one's (${fine} px)`);
  assert.ok(
    erased.ink.every(s => s.points.length > 1),
    'what was left of each line stays a line',
  );
  await c.shot('book-draw-erased', page);
}
// An ellipse filled, a rectangle outlined, an arrow, under the lines: each in the pen's own ink, the Pencil picked
// in the pen's card before
async function shapes(page, c, free, [x, y]) {
  // (the scrap's own paper, bare where the rectangle's middle comes)
  const paper = await pixel(page, x + 195, y + 225);
  await pick(page, 'Pen');
  await card(page, 'Pencil');
  await page.keyboard.press('Escape');
  await pick(page, 'Shapes: rectangle');
  await card(page, 'Ellipse');
  await card(page, 'Filled', { keep: true });
  await c.shot('book-draw-shapes-card', page);
  await page.keyboard.press('Escape');
  await drag(page, [x, y + 180], [x + 110, y + 270]);
  await card(page, 'Rectangle');
  await card(page, 'Outline', { keep: true });
  await page.keyboard.press('Escape');
  await drag(page, [x + 140, y + 180], [x + 250, y + 270]);
  await card(page, 'Arrow');
  await page.keyboard.press('Escape');
  await drag(page, [x + 280, y + 270], [x + 370, y + 190]);
  const drawn = await savedWhere(c, free.id, p => p.ink.length === 7);
  assert.deepEqual(
    drawn.ink.slice(4).map(s => !!s.fill),
    [true, false, false],
    'the ellipse filled, the rectangle and the arrow not',
  );
  assert.deepEqual(
    drawn.ink.slice(4).map(s => [s.size, s.alpha]),
    Array(3).fill([WIDTHS.pen[1], undefined]),
    "each shape at the pen's middle width, never see-through",
  );
  await page.waitForTimeout(300);
  assert.deepEqual(await pixel(page, x + 55, y + 225), NIGHT, "the filled ellipse's middle is ink");
  assert.deepEqual(await pixel(page, x + 195, y + 225), paper, "the outlined rectangle's middle is paper");
  assert.deepEqual(await pixel(page, x + 140, y + 225), NIGHT, 'its side is ink');
  await c.shot('book-draw-shapes', page);
  return drawn;
}

async function selects(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const box = await sheetOn(page, mouse(page)),
      x = box.x + 80,
      y = box.y + 160;
    await pick(page, 'Pen');
    await line(page, x, y, 200);
    await pasteGreen(page);
    const placed = await savedWhere(c, free.id, p => p.ink.length === 1 && p.scraps.length === 1);
    await page.waitForTimeout(c.settle);
    await selectsAndMoves(page, c, free, placed, [x, y]);
    await threeOnOneLine(page, c);
    const pasted = await cutsAndPastes(page, c, free, box);
    // (cut and pasted on its own page, the picture keeps its file: it's on the page once again)
    assert.equal(pasted.scraps[0].file, placed.scraps[0].file, 'the cut picture pasted keeps its file');
    // deleted
    await page.keyboard.press('Delete');
    await savedWhere(c, free.id, p => p.ink.length === 0 && p.scraps.length === 0);
    // Undo all of it: the delete, the paste, the cut, the move, the paste of the picture, the line
    await page.mouse.move(box.x + 300, box.y + 500);
    await page.keyboard.press('Control+z');
    await savedWhere(c, free.id, p => p.ink.length === 1 && p.scraps.length === 1);
    for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z');
    await savedWhere(c, free.id, p => p.ink.length === 0 && p.scraps.length === 0);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// A box from bare paper above-left of the line round it and the picture: both selected; then pressed on the picture
// and dragged, both move
async function selectsAndMoves(page, c, free, placed, [x, y]) {
  const green = await colourIn(page, GREEN);
  await pick(page, 'Select');
  await drag(page, [Math.min(x, green.x - 140) - 20, y - 30], [green.x + 140, green.y + 100]);
  await page.waitForTimeout(250);
  await c.shot('book-draw-selected', page);
  await drag(page, [green.x, green.y], [green.x + 60, green.y + 40]);
  const moved = await savedWhere(c, free.id, p => p.scraps[0]?.x !== placed.scraps[0].x);
  // (the store keeps the opened scrap's own px, the sheet showing them zoomed k times)
  const k = await page.evaluate(() => {
    const shown = document.querySelector('#book .bk-page[data-focus]');
    return shown.getBoundingClientRect().width / shown.offsetWidth;
  });
  const dx = moved.scraps[0].x - placed.scraps[0].x;
  assert.ok(Math.abs(dx * k - 60) < 2, `the picture moved with the selection: ${dx * k} px`);
  assert.ok(Math.abs(moved.ink[0].points[0][0] - placed.ink[0].points[0][0] - dx) < 1, 'and the line with it');
  await c.shot('book-draw-moved', page);
}
// The bar beside what's picked: Assign, Duplicate, Move to page… and Delete, one line of icons, each named (no Cut,
// Copy or Paste)
async function threeOnOneLine(page, c) {
  const buttons = await page
    .locator('#book .bk-sel-bar button:visible')
    .evaluateAll(bs =>
      bs.map(b => ({ name: b.getAttribute('aria-label'), top: Math.round(b.getBoundingClientRect().top) })),
    );
  assert.deepEqual(
    buttons.map(b => b.name),
    ['Assign', 'Duplicate', 'Bring forward', 'Send backward', 'Move to page…', 'Delete'],
    // (Bring forward and Send backward)
    'the bar has Assign, Duplicate, Bring forward, Send backward, Move to page… and Delete',
  );
  assert.equal(new Set(buttons.map(b => b.top)).size, 1, 'on one line');
  await c.shot('book-draw-bar', page);
}
// Cut: gone; pasted where the pointer is: back, as one more step each. Returns the page as saved after the paste.
async function cutsAndPastes(page, c, free, box) {
  await page.keyboard.press('Control+x');
  await savedWhere(c, free.id, p => p.ink.length === 0 && p.scraps.length === 0);
  assert.ok((await colourIn(page, GREEN)).n < 50, 'cut, the picture is gone from the paper');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.keyboard.press('Control+v');
  const pasted = await savedWhere(c, free.id, p => p.ink.length === 1 && p.scraps.length === 1);
  await page.waitForTimeout(300);
  const green = await colourIn(page, GREEN);
  assert.ok(green.n > 2000, 'pasted, it shows again');
  assert.ok(Math.hypot(green.x - box.x - 300, green.y - box.y - 300) < 160, 'pasted where the pointer is');
  await c.shot('book-draw-pasted', page);
  return pasted;
}

async function pencil(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c, {
    viewport: MINI,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  try {
    // (the sheet's left, clear of the tools island at its right)
    const box = await sheetOn(page, { tap: at => pressAlong(page, [at]) }),
      at = [box.x + 50, box.y + 180];
    const shaped = await pencilInks(page, c, free, at);
    await pencilSelects(page, c, free, shaped, at);
    assert.deepEqual(
      errors.filter(e => !/No active pointer/.test(e)),
      [],
    );
  } finally {
    await done();
  }
}
// With the Pencil: a line, erased through, and a shape. Returns the page as saved then.
async function pencilInks(page, c, free, [x, y]) {
  await tap(page, 'Pen');
  await pressAlong(
    page,
    Array.from({ length: 25 }, (_, i) => [x + i * 10, y]),
  );
  await savedWhere(c, free.id, p => p.ink.length === 1);
  await tap(page, 'Eraser');
  await pressAlong(
    page,
    Array.from({ length: 12 }, (_, i) => [x + 150, y - 40 + i * 7]),
  );
  await savedWhere(c, free.id, p => p.ink.length === 2);
  await tap(page, /^Shapes/);
  await pressAlong(
    page,
    Array.from({ length: 12 }, (_, i) => [x + i * 12, y + 80 + i * 8]),
  );
  const shaped = await savedWhere(c, free.id, p => p.ink.length === 3);
  assert.ok(
    shaped.ink[2].points.every(p => p[2] === shaped.ink[2].points[0][2]),
    'a shape, its line even',
  );
  await c.shot('book-draw-ipad', page);
  return shaped;
}
// With the Pencil in select mode: a box from bare paper round all of it (its frame and bar show), then the Pencil on
// the line carries it down, and Undo puts it back
async function pencilSelects(page, c, free, shaped, [x, y]) {
  await tap(page, 'Select');
  await pressAlong(
    page,
    Array.from({ length: 14 }, (_, i) => [x - 30 + i * 23, y - 40 + i * 18]),
  );
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#book .bk-sel-bar').isVisible(), true, 'the selection shows its bar');
  await c.shot('book-draw-ipad-selected', page);
  await pressAlong(
    page,
    Array.from({ length: 11 }, (_, i) => [x + 100, y + i * 5]),
  );
  // (the page goes to the store group by group, its order theirs: waited for till nothing is where it was. The store
  // keeps the opened scrap's own px, the sheet showing them zoomed: each moved down as far as the others.)
  const was = starts(shaped);
  const moved = await savedWhere(c, free.id, p => starts(p).every(s => !was.includes(s))),
    dy = moved.ink[0].points[0][1] - shaped.ink[0].points[0][1];
  assert.ok(dy > 20, `all of it moved down: ${dy} px`);
  assert.deepEqual(starts(moved, dy), was, 'all of it moved down as one');
  // (the opened scrap's Undo, on the tools' island)
  await page.locator('#book .bk-scrap-history').getByRole('button', { name: 'Undo' }).tap();
  await savedWhere(c, free.id, p => starts(p).join() === was.join());
}
// Where a page's strokes start (dy down from there), sorted, to tell them apart whatever their order on the page
const starts = (p, dy = 0) => p.ink.map(s => `${Math.round(s.points[0][0])},${Math.round(s.points[0][1] - dy)}`).sort();

// ---- helpers

// A new scrap opened by a tap (pen: what taps) on the blank page: its sheet's box on the screen
async function sheetOn(page, pen) {
  const desk = await paperBox(page),
    { gid, sheet } = await openScrap(page, pen, undefined, [desk.x + 120, desk.y + 200]);
  assert.ok(gid, 'a new scrap opened');
  return sheet;
}
const mouse = page => ({ tap: ([x, y]) => page.mouse.click(x, y) });

// A choice on the tool's card: the card opened by pressing the tool in use again if it isn't open (keep: it's open)
async function card(page, name, { keep = false } = {}) {
  if (!keep || !(await page.locator('#book .bk-palette').isVisible()))
    if (!(await page.locator('#book .bk-palette').isVisible()))
      await page.locator('#book [data-island=tools] [aria-pressed=true]').click();
  await page.locator('#book .bk-palette').getByRole('menuitemradio', { name, exact: true }).click();
}
// A pass straight down, dy long, with the mouse
async function pass(page, x, y, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(x, y + (i * dy) / 16);
  await page.mouse.up();
}
async function drag(page, [x0, y0], [x1, y1]) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12);
  await page.mouse.up();
}
// The widest run of paper between ink along a row of the sheet (box: a cut line's gap), in screen px
async function gapIn(page, box, y) {
  const { data, w } = await shotPixels(page, { x: box.x, y: y - 1, width: box.width, height: 3 });
  // (the middle of the three rows)
  const inked = [];
  for (let i = 0; i < w; i++) if (data[(w + i) * 4] < 140) inked.push(i);
  let gap = 0;
  for (let k = 1; k < inked.length; k++) gap = Math.max(gap, inked[k] - inked[k - 1] - 1);
  return gap;
}
const pixel = async (page, x, y) => [...(await shotPixels(page, { x, y, width: 1, height: 1 })).data.subarray(0, 3)];
// A tool's button tapped with a finger, unless it's the tool in hand (tapped again, it opens its card over the paper
// beside the strip.)
async function tap(page, name) {
  const b = page
    .locator('#book')
    .getByRole('button', { name, exact: typeof name === 'string' })
    .first();
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.tap();
}
