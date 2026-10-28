// book-check.mjs's stories of a page shared by its corner and of the paper's feel (shell/ink/bookdogear.js, bookshare.js,
// bookpaper.js), on a desktop in Chromium with the played store. The corner drawn away with a mouse and with a finger
// shows PDF, PNG and Call Juno, the page in hand torn out at the spine while the book's stays whole: let go on PNG the system's share sheet gets the page's picture, named for its title and
// day; on PDF a one-page PDF; on Call Juno a call starts with the page in front of Juno (the line hears its id); let go
// anywhere else nothing goes. Tapped, the corner opens the same three as a menu, its keys going round it and Escape
// putting it away. Things deleted crumple over the paper, already gone underneath: the store has them gone at once, a
// press goes through the crumple, and it's over within half a second.
import assert from 'node:assert/strict';
import { playLine } from './bookcall.mjs';
import { freePage, line, paperBox, savedWhere, tool, until } from './bookmouse.mjs';

const DESKTOP = { width: 1440, height: 900 };

// c: book-check.mjs's { hqIn, base, store, pages, shot, settled, noErrorsIn, SNIP }
export function shareStories(c) {
  return {
    "a page's corner drawn onto PNG, PDF and Call Juno with a mouse and a finger; tapped, the same as a menu":
      browser => shareStory(browser, c),
    'things deleted crumple over the paper, gone at once underneath, never in the way': browser =>
      crumpleStory(browser, c),
  };
}

// ---- the stories

async function shareStory(browser, c) {
  const free = freePage(c);
  Object.assign(free, { ink: [inkLine()] });
  // (its title the Notebook's, its day the one it was made on here.)
  const titled = c.notebook.route('/api/notebooks/pages/title', {}, { id: free.id, title: 'Shop: the price' }),
    made = new Date(titled.created),
    day = [made.getFullYear(), made.getMonth() + 1, made.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  const s = await opened(browser, c);
  const { page } = s;
  try {
    const corner = page.locator('#book .bk-dogear');
    await corner.waitFor({ timeout: 5000 });
    await c.shot('share-corner', page);
    // PNG with the mouse: the share sheet gets the page's picture, named for it
    await dragTo(page, 'mouse', 'png', async () => {
      await page.waitForTimeout(400);
      await c.shot('share-targets', page);
      assert.ok(await tornInHand(page), 'the page in hand torn out at the spine, the book’s page whole');
    });
    const png = await sharedFile(page);
    assert.deepEqual(
      { name: png.name, type: png.type, head: png.head.slice(0, 4) },
      { name: `Shop the price ${day}.png`, type: 'image/png', head: [0x89, 0x50, 0x4e, 0x47] },
      'the PNG shared, named for its page',
    );
    // PDF with a finger: a one-page PDF of it
    await dragTo(page, 'touch', 'pdf');
    const pdf = await sharedFile(page);
    assert.equal(pdf.name, `Shop the price ${day}.pdf`);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(String.fromCharCode(...pdf.head.slice(0, 8)), '%PDF-1.4', 'a PDF');
    assert.match(pdf.text, /\/Count 1/, 'of one page');
    // let go off the targets: nothing goes, the corner back
    await dragTo(page, 'mouse', null);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.__shared.length), 0, 'nothing shared');
    assert.equal(await page.locator('#book > .bk-held').count(), 0, 'the page back in its corner');
    assert.equal(await page.locator('#book .bk-share').isHidden(), true, 'the targets gone');
    await menuOfCorner(c, page, corner);
    // Call Juno: the call starts with the page in front of Juno
    await dragTo(page, 'mouse', 'call');
    await until(() => s.line.hello, 8000, 'a call started');
    assert.equal(s.line.hello.page, free.id, 'the line has the page');
    assert.equal(s.line.hello.agent, 'juno');
    c.noErrorsIn(s.errors);
  } finally {
    c.pages.splice(c.pages.indexOf(free), 1);
    await s.done();
  }
}

// Tapped, the corner opens the same three as a menu, its keys going round it, Escape putting it away on the corner
async function menuOfCorner(c, page, corner) {
  await corner.click();
  const menu = page.getByRole('menu', { name: 'Share this page' });
  await menu.waitFor({ timeout: 2000 });
  assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(), ['PDF', 'PNG', 'Call Juno']);
  await c.shot('share-menu', page);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.share), 'png');
  await page.keyboard.press('Escape');
  assert.equal(await menu.isHidden(), true, 'Escape puts the menu away');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'bk-dogear', 'back on the corner');
}

async function crumpleStory(browser, c) {
  const free = freePage(c);
  const s = await opened(browser, c);
  const { page } = s;
  try {
    const box = await paperBox(page);
    await tool(page, 'Pen').click();
    await line(page, box.x + 120, box.y + 200, 260);
    await savedWhere(c, free.id, p => p.ink.length === 1);
    await tool(page, 'Select').click();
    await page.mouse.move(box.x + 300, box.y + 400);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    // the crumple plays over the paper, the line already gone underneath and in the store
    const at = Date.now();
    await page.locator('.bk-fx-sheet').waitFor({ state: 'attached', timeout: 1000 });
    await c.shot('paper-crumple', page);
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector('.bk-fx')).pointerEvents),
      'none',
      'a press goes through it',
    );
    await savedWhere(c, free.id, p => p.ink.length === 0);
    await page.locator('.bk-fx-sheet').waitFor({ state: 'detached', timeout: 1500 });
    assert.ok(Date.now() - at < 900, `over quickly (${Date.now() - at} ms)`);
    c.noErrorsIn(s.errors);
  } finally {
    c.pages.splice(c.pages.indexOf(free), 1);
    await s.done();
  }
}

// ---- the parts

// HQ on the played store on a desktop, the book open on its last page; the store's picture of a page served, the system's
// share sheet played (what it's given kept: window.__shared) and a call's line
async function opened(browser, c) {
  const context = await c.hqIn(browser, DESKTOP, { hasTouch: true, deviceScaleFactor: 1 });
  await context.route(`${c.base}/api/book/picture**`, r =>
    r.fulfill({ contentType: 'image/png', body: Buffer.from(c.SNIP.split(',')[1], 'base64') }),
  );
  await context.addInitScript(() => {
    window.__shared = [];
    navigator.canShare = d => !!d?.files?.length;
    navigator.share = async ({ files }) => {
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        window.__shared.push({
          name: f.name,
          type: f.type,
          head: [...bytes.slice(0, 16)],
          text: new TextDecoder('latin1').decode(bytes.slice(0, 1200)),
        });
      }
    };
  });
  const line = await playLine(context),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
  await c.settled(page, 'open');
  return { page, errors, line, done: () => context.close() };
}

// The corner drawn away and let go on a target ('pdf' | 'png' | 'call'), or off them all (null): with the mouse, or as
// a finger (pointer events of that type). held: done while the page is in hand over its target.
async function dragTo(page, how, kind, held = async () => {}) {
  const corner = await page.locator('#book .bk-dogear').boundingBox(),
    from = [corner.x + corner.width - 8, corner.y + 8],
    peeled = [from[0] - 40, from[1] + 30];
  if (how === 'mouse') {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...peeled, { steps: 6 });
  } else await pointer(page, how, [from, ...steps(from, peeled, 6)], false);
  await page.locator('#book .bk-share[data-mode=carrying]').waitFor({ timeout: 3000 });
  assert.equal(await page.locator('#book > .bk-held').count(), 1, 'the page in hand');
  const target = kind && (await page.locator(`#book .bk-share [data-share=${kind}]`).boundingBox()),
    to = target ? [target.x + target.width / 2, target.y + target.height / 2] : [peeled[0] - 300, peeled[1] + 400];
  if (how === 'mouse') {
    await page.mouse.move(...to, { steps: 10 });
    if (kind) assert.equal(await page.locator('#book .bk-share [data-over]').getAttribute('data-share'), kind);
    await held();
    await page.mouse.up();
  } else await pointer(page, how, steps(peeled, to, 10), true);
}
// The page in hand torn down its spine's edge (its outline jagged there, its fibres under it), while the page in the
// book has no tear of its own
const tornInHand = page =>
  page.evaluate(() => {
    const clip = el => getComputedStyle(el).clipPath,
      teeth = (clip(document.querySelector('#book > .bk-held .bk-held-sheet')).match(/%/g) ?? []).length / 2;
    return (
      teeth > 20 &&
      clip(document.querySelector('#book > .bk-held .bk-held-fibres')) !== 'none' &&
      [...document.querySelectorAll('#book .bk-desk, #book .bk-desk *')].every(el => clip(el) === 'none')
    );
  });
// What the share sheet was given last, waited for (and the list cleared)
async function sharedFile(page) {
  await page.waitForFunction(() => window.__shared.length > 0, null, { timeout: 8000 });
  return page.evaluate(() => window.__shared.splice(0).at(-1));
}
const steps = ([x0, y0], [x1, y1], n) =>
  Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * (i + 1)) / n, y0 + ((y1 - y0) * (i + 1)) / n]);
// A finger's points: the first pressed (when first), each moved over, the last let go (when last)
const pointer = (page, type, points, last) =>
  page.evaluate(
    ([type, points, last]) => {
      const at = (kind, [x, y]) =>
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
          new PointerEvent(kind, {
            pointerId: 21,
            pointerType: type,
            isPrimary: true,
            clientX: x,
            clientY: y,
            pressure: kind === 'pointerup' ? 0 : 0.5,
            button: kind === 'pointermove' ? -1 : 0,
            buttons: kind === 'pointerup' ? 0 : 1,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
      const pressed = !window.__pressing;
      if (pressed) at('pointerdown', points[0]);
      window.__pressing = !last;
      for (const p of pressed ? points.slice(1) : points) at('pointermove', p);
      if (last) at('pointerup', points.at(-1));
    },
    [type, points, last],
  );
// A line of the board's writing across the page
const inkLine = () => ({
  color: '#1d9a5b',
  size: 5,
  points: Array.from({ length: 30 }, (_, i) => [60 + i * 12, 220 + 14 * Math.sin(i / 2), 0.5, i * 16]),
});
