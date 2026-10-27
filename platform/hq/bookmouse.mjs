// book-check.mjs's stories of the book's tools with a mouse on a desktop (shell/booktools.js, booktexts.js): a picture
// on a page moved by a press and a drag, and Undo putting it back; a post-it moved on its sheet by a mouse's drag, no
// hold first; a line in another colour and a highlighted line, the colour remembered; a note typed on the page, kept
// through a reload, edited, and emptied away. Each asserts what the board sees (pixels on the book's paper, the words
// on it) and what the store keeps (the page saved).
import assert from 'node:assert/strict';

const DESKTOP = { width: 1440, height: 900 };
// a free page of today's, with nothing on it, for a story to work on (ids well past the check's own)
let made = 9000;

// c: book-check.mjs's played store and helpers: { hqIn, base, store, pages, notes, posts, org, renumber, shot, settled,
// noErrorsIn, settle }
export function mouseStories(c) {
  return {
    'with a mouse: a picture on a page moved, and Undo puts it back': browser => movesAPicture(browser, c),
    'with a mouse: a post-it dragged on its sheet, no hold first': browser => movesAPostIt(browser, c),
    'with a mouse: a line in another colour and a highlighted line, the colour remembered': browser => inks(browser, c),
    'with a mouse: a note typed on the page, kept after a reload, edited, and emptied away': browser =>
      typed(browser, c),
  };
}

// ---- the stories

async function movesAPicture(browser, c) {
  const free = freePage(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    await pasteGreen(page);
    const placed = await savedWhere(c, free.id, p => p.scraps?.length === 1);
    await page.waitForTimeout(c.settle);
    const before = await colourIn(page, GREEN);
    assert.ok(before.n > 2000, `the picture shows on the paper (${before.n} px)`);
    const strokes = placed.ink.length;
    // pressed in its middle and dragged: it follows the pointer, lifted, and lands there
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x - 60, before.y + 40, { steps: 6 });
    const lifted = await page.evaluate(() => !!document.querySelector('#book canvas.bk-lifted'));
    assert.ok(lifted, 'the picture lifts as it moves');
    await page.mouse.move(before.x - 120, before.y + 110, { steps: 6 });
    await c.shot('book-mouse-picture-lifted', page);
    await page.mouse.up();
    const moved = await savedWhere(c, free.id, p => p.scraps[0].x !== placed.scraps[0].x);
    await page.waitForTimeout(300);
    const after = await colourIn(page, GREEN);
    assert.ok(
      Math.abs(after.x - before.x + 120) < 6 && Math.abs(after.y - before.y - 110) < 6,
      `the picture lands where it's let go: moved ${after.x - before.x}, ${after.y - before.y}`,
    );
    assert.ok(Math.abs(after.n - before.n) < before.n * 0.05, 'the same picture, whole');
    assert.equal(moved.ink.length, strokes, 'no ink drawn by the drag');
    await c.shot('book-mouse-picture-moved', page);
    // one Undo: back where it was
    await page.keyboard.press('Control+z');
    await savedWhere(c, free.id, p => p.scraps[0].x === placed.scraps[0].x && p.scraps[0].y === placed.scraps[0].y);
    await page.waitForTimeout(300);
    const back = await colourIn(page, GREEN);
    assert.ok(Math.abs(back.x - before.x) < 4 && Math.abs(back.y - before.y) < 4, 'Undo puts it back');
    // a drag on bare paper still draws
    const paper = await paperBox(page);
    await line(page, paper.x + 120, paper.y + paper.height - 160, 240);
    await savedWhere(c, free.id, p => p.ink.length === strokes + 1);
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(free), 1);
  }
}

async function movesAPostIt(browser, c) {
  const { sheet, ours } = kitsSheet(c);
  const { page, errors, done } = await onDesk(browser, c);
  try {
    await page.locator('#book nav [aria-label^="For Kit"]').first().click();
    await page.waitForTimeout(c.settle);
    const kits = page.getByRole('region', { name: 'For Kit' }),
      second = kits.getByRole('group', { name: 'Note 2' });
    await second.waitFor({ timeout: 5000 });
    const first = await kits.getByRole('group', { name: 'Note 1' }).boundingBox(),
      from = c.posts.length;
    // pressed on the post-it itself (not its words, its buttons, or its number and slips: the sheet's ink) and dragged
    // above Note 1 at once: it lifts and moves, nothing drawn
    const [x, y] = await second.evaluate(note => {
      const r = note.getBoundingClientRect();
      for (let y = r.top + 3; y < r.bottom; y += 3)
        for (let x = r.left + 3; x < r.right; x += 3) {
          const at = document.elementFromPoint(x, y);
          if (note.contains(at) && !at.closest('textarea, button, a, .bs-n, .answer-slip')) return [x, y];
        }
      return [r.left + 3, r.top + 3];
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 10, { steps: 2 });
    assert.ok(await page.evaluate(() => !!document.querySelector('.bs-ghost')), 'the post-it lifts at once');
    await page.mouse.move(x, first.y + 4, { steps: 8 });
    await c.shot('book-mouse-postit-carried', page);
    await page.mouse.up();
    const ordered = await until(() => c.posts.slice(from).find(p => p.path === '/api/book/sheet/order'));
    assert.deepEqual(ordered.body.notes, [ours[1].id, ours[0].id], 'Note 2 now first');
    assert.ok(
      !c.posts.slice(from).some(p => p.path === '/api/book/page/save' && p.body.id === sheet.id && p.body.ink.length),
      'no ink drawn by the drag',
    );
    c.noErrorsIn(errors);
  } finally {
    await done();
    c.pages.splice(c.pages.indexOf(sheet), 1);
    for (const n of ours) c.notes.splice(c.notes.indexOf(n), 1);
    c.renumber();
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
    await line(page, paper.x + 120, paper.y + 300, 240);
    const blue = await savedWhere(c, free.id, p => p.ink.length === 1);
    assert.equal(blue.ink[0].color, '#2f6bdc', 'the line is blue');
    assert.ok((await colourIn(page, BLUE)).n > 300, 'a blue line on the paper');
    // the highlighter across it: wide, see-through, yellow, the blue line still showing through
    await tool(page, 'Highlighter').click();
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
    await tool(page, 'Pen').click();
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
    await tool(page, 'Type').click();
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
    await tool(page, 'Pen').click();
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
// Kit's sheet of today's in the played store, two open notes on it
function kitsSheet(c) {
  const owner = 'kit',
    view = { w: 1133, h: 744, x: 0, y: 0, dpr: 2 },
    { today: day } = c.store('/api/book', null, new URLSearchParams()),
    sheet = { id: ++made, day, kind: 'sheet', owner, url: '/?open=shop', label: '', w: 900, h: 760 };
  const words = ['The price is too small', 'And warmer, like Inkbath'];
  const ours = words.map((w, i) => ({
    id: ++made,
    page: sheet.id,
    owner,
    n: i + 1,
    anchor: { v: 1, url: '/?open=shop', el: null, view, ink: [] },
    words: w,
    said: 'typed',
    snip: null,
    status: 'open',
    links: [],
    slips: [],
  }));
  c.pages.push(sheet);
  c.notes.push(...ours);
  c.renumber();
  return { sheet, ours };
}

// Today's free page, blank, the last of the day's row (where the book opens), in the played store
export function freePage(c) {
  const { today: day } = c.store('/api/book', null, new URLSearchParams());
  const p = { id: ++made, day, kind: 'free', owner: null, label: '', w: 1000, h: 800, ink: [], scraps: [], texts: [] };
  c.pages.push(p);
  return p;
}
// HQ on the played store in a desktop Chromium with a mouse, the book open on its last page (keep: this browser's
// storage kept, a reload)
export async function onDesk(browser, c, { keep = false } = {}) {
  onDesk.state = keep ? onDesk.state : undefined;
  const context = await c.hqIn(browser, DESKTOP, {
    hasTouch: false,
    deviceScaleFactor: 1,
    ...(onDesk.state && { storageState: onDesk.state }),
  });
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
export const paperBox = page => page.locator('#book .bk-desk').boundingBox();
// A line drawn with the mouse, from x across by dx
export async function line(page, x, y, dx) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(x + (i * dx) / 20, y + 3 * Math.sin(i / 3));
  await page.mouse.up();
}
// The page as the store has it once a save says so (it's saved a moment after a change), as it is then
export async function savedWhere(c, id, ok) {
  const page = () => c.pages.find(p => p.id === id);
  return until(
    () => (page() && ok(page()) ? structuredClone(page()) : null),
    6000,
    `the page saved as expected: ${JSON.stringify(page())}`,
  );
}
export async function until(read, ms = 5000, what = 'in time') {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const v = read();
    if (v) return v;
  }
  throw new Error(`not ${what}`);
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
