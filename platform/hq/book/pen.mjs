// book-check.mjs's stories of the Pencil on the book's paper (shell/ink/bookwrite.js, booktexts.js, bookselect.js,
// bookselectclip.js, booktape.js; Ink's folder), with the Pencil in either engine (hands.mjs): a quick tap on a box of
// words or a picture is a click, never a dot, while bare paper keeps its dot; a select box taken off the screen's edge
// and back still selecting; a picture taped in drawn on and scaled by its frame at once; Duplicate, and a paste of
// words; a box of words moved by Select with nothing drawn, the handwriting beside it keeping its focus, a letter
// deleted and a space put in without a keyboard, and new boxes in a row (by hand at the board's iPad sizes:
// penhand.mjs). Each asserts what the board sees and what the store keeps.
import assert from 'node:assert/strict';
import { freePage, onDesk, paperBox, pasteGreen, pick, savedWhere } from './mouse.mjs';
import { MINI, middleOf, until } from './kit.mjs';
import { hands } from './hands.mjs';
import { restsOpen, watchedPage } from './start.mjs';

// how long a story waits to be sure something didn't happen (the page is saved this soon after a change)
export const QUIET_MS = 1200;

// c: book-check.mjs's played store and helpers
export function penStories(c) {
  return {
    'with the Pencil: a tap on a box of words or a picture is a click, never a dot; bare paper keeps its dot':
      browser => taps(browser, c),
    "with the Pencil: a select box taken off the screen's edge and back still selects": browser =>
      offTheEdge(browser, c),
    'with the Pencil: a picture taped in is drawn on and scales by its frame at once, the pen tool still in hand':
      browser => picture(browser, c),
    'with the Pencil: Duplicate from the bar, and words copied elsewhere pasted from a finger’s tap on the paper':
      browser => duplicates(browser, c),
    'with the Pencil: a box of words moved by Select draws nothing, a line beside it with the text tool makes no box, new boxes add':
      browser => boxes(browser, c),
    'with the Pencil on an iPad mini: a box of words moves by its grip straight away with the pen, clear of its words and its bin':
      browser => grip(browser, c, 'mini'),
    'with the mouse on a desktop: a box of words moves by its grip straight away with the pen, clear of its words and its bin':
      browser => grip(browser, c, 'desktop'),
  };
}

// ---- the stories

async function taps(browser, c) {
  const free = { ...freePage(c), texts: [{ x: 120, y: 160, w: 260, text: 'Order the teal mugs', color: '#2a2352' }] };
  c.pages.splice(c.pages.length - 1, 1, free);
  const { page, pen, errors, done } = await onMini(browser, c);
  try {
    const words = page.locator('#book .bk-typed');
    await tool(page, 'Pen');
    await pen.tap(middleOf(await words.boundingBox()));
    await until(() => editing(page), 'the box edited by a tap');
    await page.keyboard.press('End');
    await page.keyboard.type(' today');
    await page.keyboard.press('Escape');
    await savedWhere(c, free.id, p => p.texts[0].text === 'Order the teal mugs today' && p.ink.length === 0);
    // a tap on bare paper is a dot (an i's, a full stop)
    const paper = await paperBox(page);
    await pen.tap([paper.x + 300, paper.y + 620]);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    // a picture taped in (picked as it lands: a tap on bare paper lets it go), tapped with the highlighter: no dot
    const green = await tapedIn(page, c, free);
    await pen.tap([paper.x + 300, paper.y + 660]);
    await savedWhere(c, free.id, p => p.ink.length === 2);
    await tool(page, 'Marker');
    await pen.tap(green);
    // the highlighter's tap on the box of words it would draw over edits it too
    await pen.tap(middleOf(await words.boundingBox()));
    await until(() => editing(page), "the box edited by the highlighter's tap");
    await page.keyboard.press('Escape');
    await page.waitForTimeout(QUIET_MS);
    assert.equal(stored(c, free).ink.length, 2, 'no dot from a tap on a picture or a box of words');
    // a line drawn from a picture starts where the Pencil touched it
    await tool(page, 'Pen');
    await pen.stroke(Array.from({ length: 12 }, (_, i) => [green[0] + i * 8, green[1]]));
    const drawn = await savedWhere(c, free.id, p => p.ink.length === 3);
    assert.ok(drawn.ink[2].points.length > 3, 'a line over the picture');
    await c.shot('book-pen-taps', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// Two lines, one above the other; a box pulled from above the first to the screen's right edge, the Pencil off the
// glass there and back on it at the edge, then down past the second: both picked
async function offTheEdge(browser, c) {
  const free = freePage(c);
  const { page, pen, errors, done } = await onMini(browser, c);
  try {
    const paper = await paperBox(page),
      // (right of the tool strip down the paper's left)
      [x, y] = [paper.x + 160, paper.y + 160],
      edge = MINI.width - 3;
    await tool(page, 'Pen');
    await pen.stroke(line([x, y], 140));
    await pen.stroke(line([x, y + 160], 140));
    await savedWhere(c, free.id, p => p.ink.length === 2);
    await tool(page, 'Select');
    await pen.stroke(path([x - 30, y - 30], [edge, y + 60]));
    await page.waitForTimeout(150);
    await pen.stroke(path([edge, y + 70], [x + 220, y + 200]));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#book .bk-lasso').count(), 0, 'the loop is put away');
    await pen.tap(middleOf(await bar(page).getByRole('button', { name: 'Delete' }).boundingBox()));
    await savedWhere(c, free.id, p => p.ink.length === 0);
    await c.shot('book-pen-edge', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A picture pasted with the pen tool on: picked as it lands, the Pencil draws across its middle (only Select moves
// things) and scales it by its frame's corner
async function picture(browser, c) {
  const free = freePage(c);
  const { page, pen, errors, done } = await onMini(browser, c);
  try {
    await tool(page, 'Pen');
    const at = await tapedIn(page, c, free),
      was = stored(c, free).scraps[0];
    const corner = middleOf(await page.locator('#book .bk-sel-handle[data-corner="2"]').boundingBox());
    await pen.stroke(path(corner, [corner[0] + 80, corner[1] + 60]));
    const scaled = await savedWhere(c, free.id, p => p.scraps[0].w > was.w);
    assert.equal(scaled.ink.length, 0, 'nothing drawn by its corner');
    await pen.stroke(path([at[0] - 40, at[1]], [at[0] + 40, at[1] + 10]));
    const drawn = await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.deepEqual([drawn.scraps[0].x, drawn.scraps[0].y], [scaled.scraps[0].x, scaled.scraps[0].y], 'never moved');
    await c.shot('book-pen-picture', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function duplicates(browser, c) {
  const free = freePage(c);
  const { page, pen, errors, done } = await onMini(browser, c);
  // (the Paste bubble reads the clipboard, as Safari lets a tap do; WebKit's Playwright grants it none, so there a
  // stand-in holds the words copied.)
  if (browser.browserType().name() === 'chromium')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: c.base });
  else
    await page.evaluate(() => {
      let held = '';
      const writeText = async text => void (held = text);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText, readText: async () => held } });
    });
  try {
    // (its select box starting right of the tool strip down the paper's left)
    const paper = await paperBox(page),
      [x, y] = [paper.x + 160, paper.y + 200];
    await tool(page, 'Pen');
    await pen.stroke(line([x, y], 160));
    await savedWhere(c, free.id, p => p.ink.length === 1);
    await tool(page, 'Select');
    await pen.stroke(path([x - 30, y - 30], [x + 200, y + 40]));
    // the bar's Duplicate: a copy a step down and right, picked in its place
    await pen.tap(middleOf(await bar(page).getByRole('button', { name: 'Duplicate' }).boundingBox()));
    const twice = await savedWhere(c, free.id, p => p.ink.length === 2);
    assert.ok(twice.ink[1].points[0][1] > twice.ink[0].points[0][1], 'duplicated a step down from what it copies');
    await c.shot('book-pen-duplicated', page);
    const bubble = page.locator('#book .bk-paste');
    // words copied in another app: a finger's tap on bare paper (one that pans, a pen having been used) offers Paste,
    // and they land
    await page.evaluate(() => navigator.clipboard.writeText('copied elsewhere'));
    await page.touchscreen.tap(x + 120, y + 420);
    await bubble.waitFor({ timeout: 2000 });
    await page.touchscreen.tap(...middleOf(await bubble.boundingBox()));
    const words = await savedWhere(c, free.id, p => p.texts.length === 1);
    assert.equal(words.texts[0].text, 'copied elsewhere', 'the clipboard’s words pasted');
    assert.equal(words.ink.length, 2, 'nothing else pasted');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function boxes(browser, c) {
  const free = freePage(c);
  const { page, pen, errors, done } = await onMini(browser, c);
  try {
    const paper = await paperBox(page),
      [x, y] = [paper.x + 120, paper.y + 200];
    await tool(page, 'Text');
    await pen.tap([x, y]);
    await until(() => editing(page), 'a new box, the caret in it');
    await page.keyboard.type('one more please');
    // a Pencil's line just under the words: the words kept as typed, no new box, nothing read into them
    const first = await page.locator('#book .bk-typed[data-editing]').boundingBox();
    await pen.stroke(line([first.x + 20, first.y + first.height + 10], 30));
    await page.waitForTimeout(QUIET_MS);
    assert.equal(await page.locator('#book .bk-typed').count(), 1, 'no new box beside it');
    assert.equal(await page.locator('#book .bk-typed-words').textContent(), 'one more please', 'the words as typed');
    await c.shot('book-pen-keys', page);
    // a second box further down, and a third: each one adds
    await pen.tap([x, y + 160]);
    await until(() => editing(page, 2), 'the second box');
    await page.keyboard.type('two');
    await pen.tap([x, y + 300]);
    await until(() => editing(page, 3), 'the third box');
    await page.keyboard.type('three');
    await page.keyboard.press('Escape');
    const typed = await savedWhere(c, free.id, p => p.texts.length === 3);
    assert.deepEqual(typed.texts.map(t => t.text).sort(), ['one more please', 'three', 'two']);
    // Select, and the Pencil on the first box carries it down and right; nothing drawn
    await tool(page, 'Select');
    const box = middleOf(await page.locator('#book .bk-typed').filter({ hasText: 'one more please' }).boundingBox());
    await pen.stroke(path(box, [box[0] + 140, box[1] + 80]));
    const oneMore = p => p.texts.find(t => t.text === 'one more please'),
      // (down: across, it's at its scrap's right side already, where it stays whole)
      moved = await savedWhere(c, free.id, p => oneMore(p).y > oneMore(typed).y + 20);
    assert.equal(oneMore(moved).w, oneMore(typed).w, 'as wide as it was');
    assert.equal(moved.ink.length, 0, 'moving a box with Select draws nothing');
    await c.shot('book-pen-boxes', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A box's grip (booktexts.js) shows by it, outside its words and its bin, and dragged with the pen
// in hand it moves the box at once: no Select first, nothing drawn, nothing left picked, the words never opened
async function grip(browser, c, device) {
  // (the played store changes the page in place: what it was is kept here)
  const was = { x: 40, y: 160, w: 140 },
    free = { ...freePage(c), texts: [{ ...was, text: 'Testing!', color: '#2a2352' }] };
  c.pages.splice(c.pages.length - 1, 1, free);
  const mini = device === 'mini',
    { page, pen, errors, done } = mini ? await onMini(browser, c) : await onDesk(browser, c);
  try {
    const box = page.locator('#book .bk-typed'),
      handle = box.locator('.bk-typed-grip');
    await (mini ? tool(page, 'Pen') : pick(page, 'Pen'));
    // (a mouse shows it on hover; a touch screen always)
    if (!mini) await page.mouse.move(...middleOf(await box.boundingBox()));
    await until(
      () => handle.evaluate(el => getComputedStyle(el).opacity === '1' && el.getBoundingClientRect().width > 0),
      'the grip shown',
    );
    const words = await box.locator('.bk-typed-words').boundingBox(),
      held = await handle.boundingBox();
    assert.ok(!overlap(held, words), `the grip clear of the words: ${JSON.stringify({ held, words })}`);
    assert.ok(held.width >= 8 && held.height >= 18, 'a grip big enough to see');
    // typed in, the bin under its right end: the grip clear of it too
    if (mini) await pen.tap(middleOf(words));
    else await page.mouse.click(...middleOf(words));
    await until(() => editing(page), 'the box edited by a tap on its words');
    const bin = await page.locator('#book .bk-typed[data-editing] .bk-typed-keys').boundingBox();
    assert.ok(!overlap(await handle.boundingBox(), bin), 'the grip clear of the bin');
    await c.shot(`book-pen-grip-${device}`, page);
    await page.keyboard.press('Escape');
    // the grip dragged with the pen in hand: the box lands down and right, as one step, nothing else changed
    const from = middleOf(await handle.boundingBox());
    await dragFrom(page, mini && pen, from, [from[0] + 100, from[1] + 90]);
    const moved = await savedWhere(c, free.id, p => p.texts[0].x > was.x + 20),
      k = (await box.boundingBox()).width / (moved.texts[0].w + 8);
    assert.ok(Math.abs(moved.texts[0].x - was.x - 100 / k) < 3, `moved right by the drag: ${moved.texts[0].x}`);
    assert.ok(Math.abs(moved.texts[0].y - was.y - 90 / k) < 3, `and down: ${moved.texts[0].y}`);
    assert.equal(moved.texts[0].w, was.w, 'as wide as it was');
    assert.equal(moved.texts[0].text, 'Testing!', 'the words as they were');
    assert.equal(moved.ink.length, 0, 'moving a box by its grip draws nothing');
    const after = await box.boundingBox();
    assert.ok(Math.abs(after.x - (words.x - 4 + 100)) < 4, `the box under the pen where it let go: ${after.x}`);
    assert.equal(await page.locator('#book .bk-sel').count(), 0, 'nothing left picked: the pen still in hand');
    assert.equal(await editing(page), false, 'the words not opened by the drag');
    await c.shot(`book-pen-grip-${device}-moved`, page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// A drag from one point to another on the screen, with the Pencil (pen) or else the mouse
async function dragFrom(page, pen, from, to) {
  if (pen) return pen.stroke(path(from, to));
  await page.mouse.move(...from);
  await page.mouse.down();
  for (const p of path(from, to).slice(1)) await page.mouse.move(...p);
  await page.mouse.up();
}
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// ---- helpers

// HQ held like an iPad mini, landscape, the book open on its last page, and a Pencil
async function onMini(browser, c) {
  const context = await c.hqIn(browser, MINI, { hasTouch: true });
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0`);
  await restsOpen(page, c, MINI);
  return { page, pen: (await hands(page)).pen, errors, done: () => context.close() };
}
// A tool taken in hand by a finger's tap, unless it's in hand already (pressed again, it opens its card over the paper
// beside the strip): the marker picked on the pen's card where the rail shows the pen alone (mouse.mjs pick).
export const tool = (page, name) => pick(page, name, 'tap');
export const key = (page, name) =>
  page.locator('#book .bk-typed[data-editing] .bk-typed-keys').getByRole('button', { name });
const bar = page => page.locator('#book .bk-sel-bar');
export const line = ([x, y], dx) => Array.from({ length: 16 }, (_, i) => [x + (i * dx) / 15, y + 2 * Math.sin(i / 2)]);
const path = ([x0, y0], [x1, y1]) =>
  Array.from({ length: 16 }, (_, i) => [x0 + ((x1 - x0) * i) / 15, y0 + ((y1 - y0) * i) / 15]);
// Whether a box of words has the caret (n: the boxes there are by then)
export const editing = (page, n = 1) =>
  page.evaluate(
    n =>
      document.querySelectorAll('#book .bk-typed').length === n &&
      !!document.activeElement?.closest('#book .bk-typed[data-editing]'),
    n,
  );
// A picture pasted onto the page in view, picked as it lands: its middle on the screen, between its frame's corners
// as the page draws them (a sketch page's box is only as big as what's on it, so it's no measure of the page's px).
async function tapedIn(page, c, free) {
  const n = stored(c, free).scraps.length;
  await pasteGreen(page);
  await savedWhere(c, free.id, p => p.scraps.length === n + 1);
  await bar(page).waitFor({ timeout: 2000 });
  const [a, b] = await Promise.all(
    [0, 2].map(k => page.locator(`#book .bk-sel-handle[data-corner="${k}"]`).boundingBox().then(middleOf)),
  );
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}
const stored = (c, free) => c.pages.find(p => p.id === free.id);
