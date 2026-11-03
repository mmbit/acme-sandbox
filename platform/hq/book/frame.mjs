// book-check.mjs's stories of the book as an object on a desktop, with a mouse (shell/ink/book.js, bookui.js,
// pair.js's card; Ink's folder): one object under a strong shadow, its controls floating over its paper in two islands
// (the tools upright at its right, the bar along its foot) with the book's own tooltips; the cover's edge let go where
// it was dragged, never sliding back first; the book opening straight onto its page, no cover, in well under a second
// (a crossfade with reduced motion); and the dots menu's Sign in another device, its card whole at the book's widest
// and narrowest; on a laptop-height window, every control whole, the tools never scrolling. Each asserts what the
// board sees: boxes, pixels, words. (the two islands)
import assert from 'node:assert/strict';
import { shutBook } from './chrome.mjs';
import { DESKTOP, MINI, shotPixels } from './kit.mjs';
import { press } from './bar.mjs';

// Laptops' windows under their browser's bars: a 768 px screen's, a 13-inch's with its bookmarks and Dock, and one
// with its developer tools docked below
const SHORT = [
  { width: 1366, height: 650 },
  { width: 1280, height: 600 },
  { width: 1280, height: 480 },
];

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode), settle }
export function frameStories(c) {
  return {
    'the book as one object: a strong shadow on HQ beside it, its controls floating over its paper in two islands':
      browser => oneObject(browser, c),
    "the cover's edge let go stays where it was let go: no slide back to where it began": browser => letGo(browser, c),
    'opening the book: straight onto its page, no cover, in well under a second; reduced motion, a crossfade':
      browser => opening(browser, c),
    "the dots menu's Sign in another device: its card whole at any book width, its QR, its words and Close never clipped":
      browser => pairCard(browser, c),
    "a laptop-height window: every control in the book's two islands whole, none scrolling, Undo and Redo at the bar's left":
      browser => shortWindow(browser, c),
    "a hardcover: the black board on the outer edge beside HQ's page, the pages the screen's height; upright, the page fills the screen":
      browser => hardcover(browser, c),
  };
}

// ---- the stories

async function oneObject(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const paper = await box(page, '#book section > div'),
      spine = await box(page, '#book [role=separator]'),
      hqWidth = await page.evaluate(() => document.body.getBoundingClientRect().width);
    assert.ok(Math.abs(hqWidth - spine.x) <= 1, `HQ's page ends at the cover's edge (${hqWidth} vs ${spine.x})`);
    // the controls: two islands over the paper, the tools upright at its right, short, and the bar along its foot
    const [tools, bar] = await islandsOf(page);
    for (const r of [tools, bar])
      assert.ok(r.left >= paper.x && r.right <= paper.x + paper.width, `an island off the paper: ${JSON.stringify(r)}`);
    assert.ok(tools.height > tools.width && tools.height < DESKTOP.height * 0.6, `the tools ${JSON.stringify(tools)}`);
    assert.ok(
      bar.width > bar.height && bar.bottom > DESKTOP.height - 40 && tools.left > bar.left,
      `the bar along the foot ${JSON.stringify(bar)}, the tools at the right ${JSON.stringify(tools)}`,
    );
    // the shadow: HQ's page darker just beside the book than a little further off, on the same rows, below the
    // bookmarks and the pull tab over HQ's side there
    const over = [await box(page, '#book .bk-marks'), await box(page, '#book .bk-lip')],
      y = Math.max(...over.map(b => b.y + b.height)) + 20,
      near = await meanLight(page, { x: spine.x - 8, y, width: 6, height: 250 }),
      far = await meanLight(page, { x: spine.x - 70, y, width: 6, height: 250 });
    assert.ok(near < far * 0.6, `the book's shadow on HQ: ${near} beside the book, ${far} further off`);
    // the book's own tooltip on a control, never the browser's title
    const undo = page.locator('#book').getByRole('button', { name: 'Undo' });
    await undo.hover();
    const tip = page.getByRole('tooltip');
    await tip.waitFor({ timeout: 2000 });
    assert.match(await tip.textContent(), /Undo/);
    assert.equal(await page.locator('#book nav [title]').count(), 0, 'no title= on the controls');
    await c.shot('book-frame-desktop', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function letGo(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    const from = (await box(page, '#book [role=separator]')).x + 6,
      y = 450;
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(from - 140, y, { steps: 10 });
    await page.waitForTimeout(100);
    const held = await spineLeft(page);
    assert.ok(Math.abs(held - (from - 6 - 140)) <= 2, `the cover's edge follows the pointer: at ${held}`);
    await page.mouse.up();
    // every frame after: where it was let go, never back towards where it began
    const after = await page.evaluate(
      () =>
        new Promise(resolve => {
          const lefts = [],
            spine = document.querySelector('#book [role=separator]'),
            frame = () => {
              lefts.push(Math.round(spine.getBoundingClientRect().left));
              if (lefts.length < 30) requestAnimationFrame(frame);
              else resolve(lefts);
            };
          frame();
        }),
    );
    assert.ok(
      after.every(x => Math.abs(x - held) <= 1),
      `the cover's edge after it was let go at ${held}: ${after.join(' ')}`,
    );
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function opening(browser, c) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const { page, errors, done } = await onDesk(browser, c, { reducedMotion });
    try {
      await shutBook(page);
      await c.settled(page, 'folded');
      const t0 = Date.now();
      await page.locator('#book .bk-lip').click();
      // no cover and no title: the book comes in on its page and is laid out open well under a second on
      const opened = await page.evaluate(
        () =>
          new Promise(resolve => {
            const start = performance.now(),
              frame = () => {
                if (document.documentElement.dataset.book === 'open' || performance.now() - start > 2000)
                  resolve(Math.round(performance.now() - start));
                else requestAnimationFrame(frame);
              };
            frame();
          }),
      );
      assert.equal(await page.locator('#book .bk-cover').count(), 0, 'no cover: the book opens straight onto its page');
      assert.ok(opened < 900, `the book is open by ${opened} ms`);
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'open');
      assert.deepEqual(errors, []);
    } finally {
      await done();
    }
  }
}

async function pairCard(browser, c) {
  const { page, errors, done } = await onDesk(browser, c);
  try {
    // (no coordinator in dev mode: a code of the store's shape)
    await page.route(/\/api\/notebooks\/pair$/, r =>
      r.fulfill({ json: { code: '915183', expires: Date.now() + 60_000 } }),
    );
    await press(page, 'Sign in another device');
    await whole(page, 'at its open width');
    await c.shot('book-frame-pair', page);
    // the spine dragged right to the book's narrowest
    const from = (await box(page, '#book [role=separator]')).x + 6;
    await page.mouse.move(from, 450);
    await page.mouse.down();
    await page.mouse.move(DESKTOP.width - 345, 450, { steps: 10 });
    // (held still a moment before it's let go: a drag, never a flick that folds the book)
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(c.settle);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'open');
    await whole(page, 'at its narrowest');
    await c.shot('book-frame-pair-narrow', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// A laptop-height window: every control in the two islands whole in the window and on the paper, the tools' island
// scrolling none of them away, the islands clear of each other, Undo and Redo the bar's first keys
async function shortWindow(browser, c) {
  for (const viewport of SHORT) {
    const { page, errors, done } = await onDesk(browser, c, {}, viewport);
    const at = `${viewport.width} × ${viewport.height}`;
    try {
      const paper = await box(page, '#book section > div'),
        islands = await islandsOf(page),
        controls = await page.$$eval('#book nav [role=toolbar] button', all =>
          all
            .filter(b => b.getClientRects().length)
            .map(b => ({ name: b.getAttribute('aria-label'), ...b.getBoundingClientRect().toJSON() })),
        ),
        scrolls = await page.$eval('#book .bk-strip', el => el.scrollHeight > el.clientHeight + 1);
      assert.equal(scrolls, false, `${at}: the tools scroll`);
      const inside = r =>
        r.left >= paper.x - 1 &&
        r.right <= paper.x + paper.width + 1 &&
        r.top >= paper.y - 1 &&
        r.bottom <= Math.min(paper.y + paper.height, viewport.height) + 1;
      for (const r of [...islands, ...controls])
        assert.ok(inside(r), `${at}: ${r.name ?? 'an island'} off the paper or the window: ${JSON.stringify(r)}`);
      const over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      islands.forEach((a, i) =>
        islands
          .slice(i + 1)
          .forEach(b => assert.ok(!over(a, b), `${at}: an island over another: ${JSON.stringify([a, b])}`)),
      );
      const bar = controls.filter(r => islands[1].left <= r.left && r.top >= islands[1].top);
      assert.deepEqual(
        bar.slice(0, 2).map(r => r.name),
        ['Undo', 'Redo'],
        `${at}: Undo and Redo at the bar's left`,
      );
      if (viewport === SHORT[0]) await c.shot('book-frame-short', page);
      assert.deepEqual(errors, []);
    } finally {
      await done();
    }
  }
}
// The pairing card on the paper: its head, its QR showing, its words beside or under the QR, and Close, all inside it
async function whole(page, when) {
  const card = page.getByRole('region', { name: 'Sign in another device' }),
    qr = card.getByRole('img', { name: 'Scan to sign in' }),
    close = card.getByRole('button', { name: 'Close', exact: true });
  await close.waitFor({ timeout: 3000 });
  const paper = await box(page, '#book section > div'),
    k = await card.boundingBox(),
    q = await qr.boundingBox(),
    parts = {
      head: await card.locator('.pair-head').boundingBox(),
      QR: q,
      words: await card.locator('.pair-words').boundingBox(),
      Close: await close.boundingBox(),
    };
  const inside = (a, b) =>
    a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
  assert.ok(inside(k, paper), `${when}: the card ${JSON.stringify(k)} off the paper ${JSON.stringify(paper)}`);
  for (const [name, part] of Object.entries(parts))
    assert.ok(part && inside(part, k), `${when}: its ${name} ${JSON.stringify(part)} cut off the card`);
  const w = parts.words;
  assert.ok(w.x >= q.x + q.width - 1 || w.y >= q.y + q.height - 1, `${when}: the words over the QR`);
  assert.ok(await qr.isVisible(), `${when}: the QR shows`);
}

// ---- helpers

// The hardcover beside HQ's page on a desktop and an iPad mini on its side, for the look's reader to see (its colours
// are never asserted: CODE_STYLE.md, Tests). Upright (a phone), the book opened lies over the screen, its paper the
// whole width and down from the top, no cover round it.
async function hardcover(browser, c) {
  for (const [name, viewport] of [
    ['desktop', DESKTOP],
    ['mini', MINI],
  ]) {
    const { page, errors, done } = await onDesk(browser, c, {}, viewport);
    try {
      await c.shot(`book-hardcover-${name}`, page);
      assert.deepEqual(errors, []);
    } finally {
      await done();
    }
  }
  const phone = { width: 390, height: 844 };
  const { page, errors, done } = await c.hq(browser, phone);
  try {
    await page.locator('#book .bk-lip').click();
    await c.settled(page, 'spread');
    const paper = await box(page, '#book section > div');
    assert.ok(paper.x <= 0 && paper.x + paper.width >= phone.width, `upright, the paper ${JSON.stringify(paper)}`);
    assert.ok(paper.y + paper.height >= phone.height - 1, `upright, the paper ends at ${paper.y + paper.height}`);
    await c.shot('book-hardcover-phone', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// HQ on a desktop with a mouse (its window DESKTOP's size unless one is given), the book open
async function onDesk(browser, c, options = {}, viewport = DESKTOP) {
  const opened = await c.hq(browser, viewport, { hasTouch: false, deviceScaleFactor: 1, ...options });
  await c.settled(opened.page, 'open');
  return opened;
}
const box = (page, selector) => page.locator(selector).first().boundingBox();
// The two islands' boxes: the tools', and the bar's
const islandsOf = page =>
  page.$$eval('#book .bk-strip, #book .bk-bar', all => all.map(el => el.getBoundingClientRect().toJSON()));
const spineLeft = page =>
  page.evaluate(() => Math.round(document.querySelector('#book [role=separator]').getBoundingClientRect().left));
// The mean lightness (0-255) of a box on the screen, read from a screenshot of it
async function meanLight(page, clip) {
  const { data } = await shotPixels(page, clip);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  return Math.round(sum / (data.length / 4));
}
