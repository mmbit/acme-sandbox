// book-check.mjs's stories of the book's tools with a mouse on a desktop (shell/ink/booktools.js, booktexts.js; Ink's
// folder): a line drawn with the pen across a picture just taped in, which stays put (only Select moves things);
// a line in another colour and a highlighted line, the colour remembered; a note typed on the page, kept through
// a reload, edited, and emptied away. Each asserts what the board sees (pixels on the book's paper, the words on it)
// and what the store keeps (the page saved).
import assert from 'node:assert/strict';
import { DESKTOP, until } from './bookkit.mjs';

// c: book-check.mjs's played store and helpers: { hqIn, base, store, pages, notes, posts, org, renumber, shot, settled,
// noErrorsIn, settle }
export function mouseStories(c) {
  return {
    'with a mouse: the pen draws across a picture just taped in, which stays put': browser =>
      drawsOnAPicture(browser, c),
    'with a mouse: a line in another colour and a highlighted line, the colour remembered': browser => inks(browser, c),
    'with a mouse: a note typed on the page, kept after a reload, edited, and emptied away': browser =>
      typed(browser, c),
  };
}

// ---- the stories

async function drawsOnAPicture(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    await pasteGreen(page);
    const placed = await savedWhere(c, free.id, p => p.scraps?.length === 1);
    await page.waitForTimeout(c.settle);
    const before = await colourIn(page, GREEN);
    assert.ok(before.n > 2000, `the picture shows on the paper (${before.n} px)`);
    const strokes = placed.ink.length;
    // the pen pressed in its middle (just taped in, it's picked: its frame round it) and dragged across it: a line on
    // it, never a move
    await line(page, before.x - 40, before.y, 80);
    const drawn = await savedWhere(c, free.id, p => p.ink.length === strokes + 1);
    assert.deepEqual(
      [drawn.scraps[0].x, drawn.scraps[0].y],
      [placed.scraps[0].x, placed.scraps[0].y],
      'the picture stays where it was',
    );
    await page.waitForTimeout(300);
    const after = await colourIn(page, GREEN);
    assert.ok(Math.abs(after.x - before.x) < 4 && Math.abs(after.y - before.y) < 4, 'nothing moved on the paper');
    await c.shot('book-mouse-picture-drawn-on', page);
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function inks(browser, c) {
  const free = freePage(c);
  let { page, done } = await onDesk(browser, c);
  try {
    const paper = await paperBox(page);
    // Blue from the colour card, a line in it (the card's name)
    await tool(page, 'Colour and width').click();
    await page.getByRole('menuitemradio', { name: 'Blue' }).click();
    // (the card stays open over the paper beside the strip for a width too: Escape closes it.)
    await page.keyboard.press('Escape');
    await line(page, paper.x + 120, paper.y + 300, 240);
    const blue = await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.equal(blue.ink[0].color, '#2f6bdc', 'the line is blue');
    assert.ok((await colourIn(page, BLUE)).n > 300, 'a blue line on the paper');
    // the highlighter across it: wide, see-through, yellow, the blue line still showing through
    await pick(page, 'Highlighter');
    await line(page, paper.x + 100, paper.y + 300, 280);
    await page.mouse.move(paper.x + 60, paper.y + 600);
    const lit = await savedWhere(c, free.id, p => p.ink.length === 2);
    assert.deepEqual(
      [lit.ink[1].color, lit.ink[1].alpha < 1, lit.ink[1].size > lit.ink[0].size * 2],
      ['#ffd23f', true, true],
      'a wide see-through yellow',
    );
    await page.waitForTimeout(300);
    await c.shot('book-mouse-inks', page);
    assert.ok((await colourIn(page, LIT)).n > 1500, 'the highlight on the paper');
    assert.ok((await colourIn(page, BLUE, 60)).n > 200, 'the blue line still shows');
    // the colours remembered: Blue still the pen's after a reload
    await done();
    const again = await onDesk(browser, c, { keep: true });
    ({ page, done } = again);
    await pick(page, 'Pen');
    await line(page, paper.x + 140, paper.y + 420, 200);
    const third = await savedWhere(c, free.id, p => p.ink.length === 3);
    assert.equal(third.ink[2].color, '#2f6bdc', 'the pen is still blue');
    c.noErrorsIn(again.errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function typed(browser, c) {
  const free = freePage(c);
  let { page, done } = await onDesk(browser, c);
  try {
    const paper = await paperBox(page);
    // the text tool: a press on the paper, the caret there, typed, and Escape keeps it
    await pick(page, 'Type');
    await page.mouse.click(paper.x + 160, paper.y + 260);
    await page.keyboard.type('Order the teal mugs');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and the gold box');
    await page.keyboard.press('Escape');
    const kept = await savedWhere(c, free.id, p => p.texts?.length === 1);
    assert.equal(kept.texts[0].text, 'Order the teal mugs\nand the gold box');
    assert.equal(kept.texts[0].color, '#2a2352', 'in Night, the pen colour');
    await c.shot('book-mouse-typed', page);
    // a double click on bare paper with the pen: another box there, and no dots left by the clicks
    await pick(page, 'Pen');
    await page.mouse.dblclick(paper.x + 160, paper.y + 420);
    await page.keyboard.type('Ask Lark');
    await page.mouse.click(paper.x + 700, paper.y + 600);
    const two = await savedWhere(c, free.id, p => p.texts?.length === 2);
    assert.equal(two.ink.length, 0, 'the double click left no ink');
    // kept after a reload: the words on the page as the board reads them
    await done();
    const again = await onDesk(browser, c, { keep: true });
    ({ page, done } = again);
    const words = page.locator('#book .bk-desk').getByText('Order the teal mugs');
    await words.waitFor({ timeout: 5000 });
    assert.ok(await words.isVisible(), 'the typed note shows after a reload');
    // a click edits it again; emptied, it's gone from the page and the store
    await words.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    const one = await savedWhere(c, free.id, p => p.texts?.length === 1);
    assert.equal(one.texts[0].text, 'Ask Lark');
    assert.equal(await page.locator('#book .bk-desk').getByText('Order the teal mugs').count(), 0, 'gone');
    // Undo brings it back
    await page.keyboard.press('Control+z');
    await savedWhere(c, free.id, p => p.texts?.length === 2);
    await words.waitFor({ timeout: 3000 });
    c.noErrorsIn(again.errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

// ---- helpers (the drawing tools' stories use them too: bookdraw.mjs)

// A green picture pasted onto the page in view
export const pasteGreen = page =>
  page.evaluate(async () => {
    const cv = Object.assign(document.createElement('canvas'), { width: 240, height: 160 }),
      g = cv.getContext('2d');
    g.fillStyle = '#1d9a5b';
    g.fillRect(0, 0, 240, 160);
    const png = await new Promise(res => cv.toBlob(res, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'shot.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
// A new page in My Notebook, blank, its newest (where the book opens), on book-check's played Notebook; in c.pages, its
// mirror: what's put on it before HQ opens goes on as a group, and what's saved on it shows there (book-check.mjs).
// (the Notebook)
export function freePage(c) {
  const made = c.notebook.route('/api/notebooks/pages/create', {}, { notebook: 1 });
  const p = { id: made.id, notebook: 1, kind: 'free', owner: null, label: '', w: made.w, h: made.h };
  c.pages.push(Object.assign(p, { ink: [], scraps: [], texts: [] }));
  return p;
}
// HQ on the played store, the book open on its last page. Defaults to a desktop mouse, with context options for
// other devices. With keep, this browser's storage survives a reload.
export async function onDesk(browser, c, { keep = false, viewport = DESKTOP, initScript, ...options } = {}) {
  onDesk.state = keep ? onDesk.state : undefined;
  const context = await c.hqIn(browser, viewport, {
    hasTouch: false,
    deviceScaleFactor: 1,
    ...options,
    ...(onDesk.state && { storageState: onDesk.state }),
  });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
  return {
    page,
    errors,
    done: async () => {
      onDesk.state = await context.storageState();
      await context.close();
    },
  };
}
export const tool = (page, name) => page.locator('#book').getByRole('button', { name, exact: true });
// A tool taken in hand by a click (or a tap: how), unless it's in hand already: pressed again, it opens its card over
// the paper beside the strip (bookstrip.js.)
export async function pick(page, name, how = 'click') {
  const b = tool(page, name).first();
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b[how]();
}
export const paperBox = page => page.locator('#book .bk-desk').boundingBox();
// A line drawn with the mouse, from x across by dx
export async function line(page, x, y, dx) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(x + (i * dx) / 20, y + 3 * Math.sin(i / 3));
  await page.mouse.up();
}
// The page as the store has it once a save says so (it's saved a moment after a change), as it is then. (waited on as
// long as Playwright waits for anything: on a loaded worker the page's 600 ms save timer fires seconds late, a
// strike's once 8 s after it)
export async function savedWhere(c, id, ok) {
  const page = () => c.pages.find(p => p.id === id);
  return until(
    () => (page() && ok(page()) ? structuredClone(page()) : null),
    `the page saved as expected: ${JSON.stringify(page())}`,
  );
}

// The pixels of a colour on the book's paper: how many, and their middle on the screen
export const GREEN = [29, 154, 91],
  BLUE = [47, 107, 220],
  // (the highlighter's yellow over the paper)
  LIT = [255, 234, 162];
export async function colourIn(page, rgb, near = 40) {
  const box = await paperBox(page),
    png = await page.screenshot({ clip: box });
  const seen = await page.evaluate(
    async ([src, rgb, near]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, cv.width, cv.height);
      let n = 0,
        sx = 0,
        sy = 0;
      for (let i = 0; i < data.length; i += 4)
        if (Math.abs(data[i] - rgb[0]) + Math.abs(data[i + 1] - rgb[1]) + Math.abs(data[i + 2] - rgb[2]) < near) {
          n++;
          sx += (i / 4) % cv.width;
          sy += Math.floor(i / 4 / cv.width);
        }
      return { n, x: n ? sx / n : 0, y: n ? sy / n : 0 };
    },
    [`data:image/png;base64,${png.toString('base64')}`, rgb, near],
  );
  return { n: seen.n, x: box.x + seen.x, y: box.y + seen.y };
}
