// book-check.mjs's stories of the book as an object on a desktop, with a mouse (shell/ink/book.js, bookui.js; Ink's
// folder): one object under one soft shadow, its controls floating over its paper in two islands
// (the tools upright at its right, the bar along its foot) with the book's own tooltips; the cover's edge let go where
// it was dragged, never sliding back first; the book opening straight onto its page, no cover, in well under a second
// (a crossfade with reduced motion); on a laptop-height window, every control whole, the tools never scrolling. Each asserts what the
// board sees: boxes, pixels, words. (the two islands; the tools, Undo and Redo only on an opened scrap, where the bar
// goes)
// (the soft shadow read in Wire)
import assert from 'node:assert/strict';
import { shutBook } from './chrome.mjs';
import { DESKTOP, MINI, openScrapInMiddle, shotPixels } from './kit.mjs';
import { mouseOf } from './hands.mjs';

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
    'the book as one object: one soft shadow on HQ beside it, its controls floating over its paper in two islands':
      browser => oneObject(browser, c),
    "the cover's edge let go stays where it was let go: no slide back to where it began": browser => letGo(browser, c),
    'opening the book: straight onto its page, no cover, in well under a second; reduced motion, a crossfade':
      browser => opening(browser, c),
    "a laptop-height window: every control in the book's islands whole, none scrolling, Undo and Redo with an opened scrap's tools":
      browser => shortWindow(browser, c),
    "a hardcover: the black board on the outer edge beside HQ's page, the pages the screen's height; upright, the page fills the screen":
      browser => hardcover(browser, c),
  };
}

// ---- the stories

async function oneObject(browser, c) {
  const { page, errors, done } = await onDesk(browser, c, { look: WIRE });
  try {
    const paper = await box(page, '#book section > div'),
      spine = await box(page, '#book [role=separator]'),
      hqWidth = await page.evaluate(() => document.body.getBoundingClientRect().width);
    assert.ok(Math.abs(hqWidth - spine.x) <= 1, `HQ's page ends at the cover's edge (${hqWidth} vs ${spine.x})`);
    // the controls: two islands over the paper, the bar along its foot on the page, and on an opened scrap the tools
    // upright at its right, short (below)
    const bar = await islandOf(page, 'bk-bar');
    assert.ok(
      bar.left >= paper.x && bar.right <= paper.x + paper.width,
      `an island off the paper: ${JSON.stringify(bar)}`,
    );
    assert.ok(
      bar.width > bar.height && bar.bottom > DESKTOP.height - 40,
      `the bar along the foot ${JSON.stringify(bar)}`,
    );
    // the shadow (the book's frame, One soft shadow): HQ's page darker just beside the book than a little further
    // off, on the same rows, below the bookmarks and the pull tab over HQ's side there. The soft shadow (book.css,
    // 0 6px 22px at 0.4) is some 14% darker at 8 px and gone by 70, where no shadow reads the same: 0.9 tells the two
    // apart. Read on Wire's even ground (the default look's has a gradient of its own)
    const over = [await box(page, '#book .bk-marks'), await box(page, '#book .bk-lip')],
      y = Math.max(...over.map(b => b.y + b.height)) + 20,
      near = await meanLight(page, { x: spine.x - 8, y, width: 6, height: 250 }),
      far = await meanLight(page, { x: spine.x - 70, y, width: 6, height: 250 });
    assert.ok(near < far * 0.9, `the book's shadow on HQ: ${near} beside the book, ${far} further off`);
    await openScrapInMiddle(page, mouseOf(page));
    const tools = await islandOf(page, 'bk-strip');
    assert.ok(
      tools.left >= paper.x && tools.right <= paper.x + paper.width,
      `an island off the paper: ${JSON.stringify(tools)}`,
    );
    assert.ok(tools.height > tools.width && tools.height < DESKTOP.height * 0.6, `the tools ${JSON.stringify(tools)}`);
    assert.ok(tools.left > bar.left, `the tools at the right ${JSON.stringify(tools)}, the bar ${JSON.stringify(bar)}`);
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

// A laptop-height window: every control in the islands whole in the window and on the paper, the bar's on the page,
// the tools' on an opened scrap, its island scrolling none of them away, Undo and Redo in it
async function shortWindow(browser, c) {
  for (const viewport of SHORT) {
    const { page, errors, done } = await onDesk(browser, c, { viewport });
    const at = `${viewport.width} × ${viewport.height}`;
    try {
      const paper = await box(page, '#book section > div'),
        inside = r =>
          r.left >= paper.x - 1 &&
          r.right <= paper.x + paper.width + 1 &&
          r.top >= paper.y - 1 &&
          r.bottom <= Math.min(paper.y + paper.height, viewport.height) + 1,
        whole = async island => {
          for (const r of [await islandOf(page, island), ...(await controlsOf(page, island))])
            assert.ok(inside(r), `${at}: ${r.name ?? 'an island'} off the paper or the window: ${JSON.stringify(r)}`);
        };
      await whole('bk-bar');
      await openScrapInMiddle(page, mouseOf(page));
      await whole('bk-strip');
      const scrolls = await page.$eval('#book .bk-strip', el => el.scrollHeight > el.clientHeight + 1);
      assert.equal(scrolls, false, `${at}: the tools scroll`);
      const names = (await controlsOf(page, 'bk-strip')).map(r => r.name);
      assert.ok(names.includes('Undo') && names.includes('Redo'), `${at}: Undo and Redo with the tools: ${names}`);
      if (viewport === SHORT[0]) await c.shot('book-frame-short', page);
      assert.deepEqual(errors, []);
    } finally {
      await done();
    }
  }
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
    const { page, errors, done } = await onDesk(browser, c, { viewport });
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

// HQ on a desktop with a mouse (its window DESKTOP's size and the check's own look unless either is given), the book
// open
async function onDesk(browser, c, { viewport = DESKTOP, look = '', ...options } = {}) {
  const opened = await c.hq(browser, viewport, { hasTouch: false, deviceScaleFactor: 1, ...options }, look);
  await c.settled(opened.page, 'open');
  return opened;
}
// (HQ in Wire: book-check.mjs hq()'s look)
const WIRE = '&renderer=wire';
const box = (page, selector) => page.locator(selector).first().boundingBox();
// An island's box: the tools' (bk-strip) or the bar's (bk-bar)
const islandOf = (page, island) => page.$eval(`#book .${island}`, el => el.getBoundingClientRect().toJSON());
// An island's keys shown, each its name and box
const controlsOf = (page, island) =>
  page.$$eval(`#book .${island} button`, all =>
    all
      .filter(b => b.getClientRects().length)
      .map(b => ({ name: b.getAttribute('aria-label'), ...b.getBoundingClientRect().toJSON() })),
  );
const spineLeft = page =>
  page.evaluate(() => Math.round(document.querySelector('#book [role=separator]').getBoundingClientRect().left));
// The mean lightness (0-255) of a box on the screen, read from a screenshot of it
async function meanLight(page, clip) {
  const { data } = await shotPixels(page, clip);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  return Math.round(sum / (data.length / 4));
}
