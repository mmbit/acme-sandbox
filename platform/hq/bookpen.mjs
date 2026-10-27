// book-check.mjs's stories of the Pencil on the book's paper (shell/bookwrite.js, booktexts.js, bookselect.js,
// bookselectclip.js, booktape.js), with Chromium's own pen events (trusted: their clicks and capture are the
// browser's): a quick tap on a box of words or a picture is a click, never a dot, while bare paper keeps its dot; a
// select box taken off the screen's edge and back still selecting; a picture taped in moved and scaled at once; Copy
// then Paste; a box of words moved by its grip with nothing drawn, the handwriting beside it keeping its focus, a letter
// deleted and a space put in without a keyboard, and new boxes in a row. Each asserts what the board sees and what the
// store keeps.
import assert from 'node:assert/strict';
import { freePage, paperBox, pasteGreen, savedWhere } from './bookmouse.mjs';

const MINI = { width: 1133, height: 744 };
// how long a story waits to be sure something didn't happen (the page is saved this soon after a change)
const QUIET_MS = 1200;

// c: book-check.mjs's played store and helpers
export function penStories(c) {
  return {
    'with the Pencil: a tap on a box of words or a picture is a click, never a dot; bare paper keeps its dot':
      browser => taps(browser, c),
    "with the Pencil: a select box taken off the screen's edge and back still selects": browser =>
      offTheEdge(browser, c),
    'with the Pencil: a picture taped in moves and scales at once, the pen tool still in hand': browser =>
      picture(browser, c),
    'with the Pencil: Copy, then Paste from the bar and from a tap on the paper': browser => copyPaste(browser, c),
    'with the Pencil: a box of words moved by its grip draws nothing, handwriting beside it keeps it, letters fixed, new boxes add':
      browser => boxes(browser, c),
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
    await tool(page, 'Highlighter');
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
      [x, y] = [paper.x + 80, paper.y + 160],
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

// A picture pasted with the pen tool on: picked as it lands, the Pencil carries it by its middle and scales it by a
// corner, and nothing is drawn
async function picture(browser, c) {
  const free = freePage(c);
  const { page, pen, errors, done } = await onMini(browser, c);
  try {
    await tool(page, 'Pen');
    const at = await tapedIn(page, c, free),
      was = stored(c, free).scraps[0];
    await pen.stroke(path(at, [at[0] + 90, at[1] + 60]));
    const moved = await savedWhere(c, free.id, p => p.scraps[0].x !== was.x);
    assert.ok(Math.abs(moved.scraps[0].x - was.x - 90) < 4, `carried 90 px across: ${moved.scraps[0].x - was.x}`);
    const corner = middleOf(await page.locator('#book .bk-sel-handle[data-corner="2"]').boundingBox());
    await pen.stroke(path(corner, [corner[0] + 80, corner[1] + 60]));
    const scaled = await savedWhere(c, free.id, p => p.scraps[0].w > moved.scraps[0].w);
    assert.equal(scaled.ink.length, 0, 'nothing drawn');
    await c.shot('book-pen-picture', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function copyPaste(browser, c) {
  const free = freePage(c);
  const { page, pen, errors, done } = await onMini(browser, c);
  try {
    const paper = await paperBox(page),
      [x, y] = [paper.x + 100, paper.y + 200];
    await tool(page, 'Pen');
    await pen.stroke(line([x, y], 160));
    await savedWhere(c, free.id, p => p.ink.length === 1);
    await tool(page, 'Select');
    await pen.stroke(path([x - 30, y - 30], [x + 200, y + 40]));
    const paste = bar(page).getByRole('button', { name: 'Paste' });
    assert.equal(await paste.isVisible(), false, 'no Paste before anything is copied');
    await pen.tap(middleOf(await bar(page).getByRole('button', { name: 'Copy' }).boundingBox()));
    await paste.waitFor({ timeout: 2000 });
    await page.waitForTimeout(250);
    await pen.tap(middleOf(await paste.boundingBox()));
    const pasted = await savedWhere(c, free.id, p => p.ink.length === 2);
    assert.ok(pasted.ink[1].points[0][1] > pasted.ink[0].points[0][1], 'pasted a step down from what it copies');
    await c.shot('book-pen-pasted', page);
    // a tap on bare paper lets go and offers Paste there
    await pen.tap([x + 120, y + 300]);
    const bubble = page.locator('#book .bk-paste');
    await bubble.waitFor({ timeout: 2000 });
    await pen.tap(middleOf(await bubble.boundingBox()));
    await savedWhere(c, free.id, p => p.ink.length === 3);
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
    await tool(page, 'Type');
    await pen.tap([x, y]);
    await until(() => editing(page), 'a new box, the caret in it');
    await page.keyboard.type('onx');
    // the letter misread taken back with the Pencil, no keyboard
    await pen.tap(middleOf(await key(page, 'Delete the letter before').boundingBox()));
    await page.keyboard.type('e');
    // handwriting just under the words: the box keeps the focus, no new box
    const first = await page.locator('#book .bk-typed[data-editing]').boundingBox();
    await pen.stroke(line([first.x + 20, first.y + first.height + 10], 30));
    assert.ok(await editing(page), 'the box still has the focus');
    assert.equal(await page.locator('#book .bk-typed').count(), 1, 'no new box beside it');
    await page.keyboard.type(' more');
    await pen.tap(middleOf(await key(page, 'Space').boundingBox()));
    await page.keyboard.type('please');
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
    // the Pencil on the first box's grip carries it down and right; nothing drawn
    const grip = middleOf(await page.locator('#book .bk-typed-grip').first().boundingBox());
    await pen.stroke(path(grip, [grip[0] + 140, grip[1] + 80]));
    const oneMore = p => p.texts.find(t => t.text === 'one more please'),
      moved = await savedWhere(c, free.id, p => oneMore(p).x !== oneMore(typed).x);
    assert.equal(moved.ink.length, 0, 'moving a box by its grip draws nothing');
    await c.shot('book-pen-boxes', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// ---- helpers

// HQ held like an iPad mini, landscape, the book open on its last page, and a Pencil
async function onMini(browser, c) {
  const context = await c.hqIn(browser, MINI, { hasTouch: true });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
  return { page, pen: await pencil(page), errors, done: () => context.close() };
}
// The Pencil as Chromium's own pen: down at the first point, along the rest, and up at the last
async function pencil(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, [x, y], down) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: down || type === 'mouseReleased' ? 'left' : 'none',
      buttons: down ? 1 : 0,
      clickCount: 1,
      pointerType: 'pen',
      force: down ? 0.5 : 0,
    });
  const stroke = async points => {
    await send('mousePressed', points[0], true);
    for (const p of points.slice(1)) await send('mouseMoved', p, true);
    await send('mouseReleased', points.at(-1), false);
  };
  return { stroke, tap: at => stroke([at]) };
}
// A tool's button tapped with a finger
const tool = (page, name) => page.locator('#book').getByRole('button', { name, exact: true }).first().tap();
const key = (page, name) => page.locator('#book .bk-typed[data-editing] .bk-typed-keys').getByRole('button', { name });
const bar = page => page.locator('#book .bk-sel-bar');
const middleOf = b => [b.x + b.width / 2, b.y + b.height / 2];
const line = ([x, y], dx) => Array.from({ length: 16 }, (_, i) => [x + (i * dx) / 15, y + 2 * Math.sin(i / 2)]);
const path = ([x0, y0], [x1, y1]) =>
  Array.from({ length: 16 }, (_, i) => [x0 + ((x1 - x0) * i) / 15, y0 + ((y1 - y0) * i) / 15]);
// Whether a box of words has the caret (n: the boxes there are by then)
const editing = (page, n = 1) =>
  page.evaluate(
    n =>
      document.querySelectorAll('#book .bk-typed').length === n &&
      !!document.activeElement?.closest('#book .bk-typed[data-editing]'),
    n,
  );
// A picture pasted onto the page in view, picked as it lands: its middle on the screen
async function tapedIn(page, c, free) {
  const n = stored(c, free).scraps.length;
  await pasteGreen(page);
  const { scraps } = await savedWhere(c, free.id, p => p.scraps.length === n + 1);
  await bar(page).waitFor({ timeout: 2000 });
  const s = scraps.at(-1);
  return onScreen(page, free, [s.x + s.w / 2, s.y + s.h / 2]);
}
// A point of the page shown (its px, the page with the selection's bar) on the screen, at its pan and zoom
const onScreen = (page, free, [x, y]) =>
  page.evaluate(
    ([w, x, y]) => {
      const r = document.querySelector('#book .bk-sel-bar').closest('.bk-page').getBoundingClientRect(),
        k = r.width / w;
      return [r.left + x * k, r.top + y * k];
    },
    [free.w, x, y],
  );
const stored = (c, free) => c.pages.find(p => p.id === free.id);
async function until(read, what) {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise(r => setTimeout(r, 100)))
    if (await read()) return;
  throw new Error(`not ${what}`);
}
