// book-check.mjs's stories of the book as an object on a desktop, with a mouse (shell/ink/book.js, bookui.js,
// pair.js's card; Ink's folder): one object under a strong shadow, its controls
// floating over its paper with the book's own tooltips; the cover's edge let go where it was dragged, never sliding
// back first; the book opening straight onto its page, no cover, in well under a second (a crossfade with reduced
// motion); and the "Draw from your phone" card whole at the book's widest and narrowest; on a laptop-height window,
// every control whole (a second column). Each asserts what the board sees: boxes, pixels, words. (the short window)
import assert from 'node:assert/strict';
import { shutBook } from './bookchrome.mjs';
import { DESKTOP, MINI } from './bookkit.mjs';

// Laptops' windows under their browser's bars: a 768 px screen's, a 13-inch's with its bookmarks and Dock, and one
// with its developer tools docked below, the one short enough for the stack's second column
const SHORT = [
  { width: 1366, height: 650 },
  { width: 1280, height: 600 },
  { width: 1280, height: 480 },
];

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode), settle }
export function frameStories(c) {
  return {
    'the book as one object: a strong shadow on HQ beside it, its controls floating over its paper, no column':
      browser => oneObject(browser, c),
    "the cover's edge let go stays where it was let go: no slide back to where it began": browser => letGo(browser, c),
    'opening the book: straight onto its page, no cover, in well under a second; reduced motion, a crossfade':
      browser => opening(browser, c),
    '"Draw from your phone" whole at any book width: its code field and Join never clipped': browser =>
      pairCard(browser, c),
    "a laptop-height window: every control in the book's islands whole, Undo and Redo at their foot among them":
      browser => shortWindow(browser, c),
    "a hardcover: the black board round the pages at the head, the foot and the outer edge beside HQ's page; upright, the page fills the screen":
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
    // the controls: small islands over the paper's right edge, no full-height column of their own
    const islands = await page.$$eval('#book nav [role=toolbar]', all =>
      all.map(el => el.getBoundingClientRect().toJSON()).filter(r => r.width),
    );
    assert.ok(islands.length >= 3, `${islands.length} islands of controls`);
    for (const r of islands) {
      assert.ok(r.left >= paper.x && r.right <= paper.x + paper.width, `an island off the paper: ${JSON.stringify(r)}`);
      assert.ok(r.height < DESKTOP.height * 0.6, `an island ${Math.round(r.height)} px tall, a column`);
    }
    // ...in one stack, a second column only for a short window (shortWindow)
    const lefts = new Set((await stackOf(page)).map(r => Math.round(r.left)));
    assert.equal(lefts.size, 1, `the stack in ${lefts.size} columns at ${DESKTOP.width} × ${DESKTOP.height}`);
    // the shadow: HQ's page darker just beside the book than a little further off, on the same row
    const near = await meanLight(page, { x: spine.x - 8, y: 300, width: 6, height: 300 }),
      far = await meanLight(page, { x: spine.x - 70, y: 300, width: 6, height: 300 });
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
    // (no coordinator in dev mode: a code of the store's shape, and its stream kept open)
    await page.route(/\/api\/pair$/, r => r.fulfill({ json: { pair: 'p1', key: 'k', side: 'a', code: '915183' } }));
    await page.route(/\/api\/pair\/live/, () => {});
    // (the phone with the book's controls)
    await page.locator('#book').getByRole('button', { name: 'Draw from your phone' }).click();
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
// A laptop-height window: the stack too tall for one column goes on in a second, so every control in it and in the
// pages' row is whole in the window and on the paper, no island over another, Undo and Redo (the book's own island, at
// the stack's foot) among them
async function shortWindow(browser, c) {
  for (const viewport of SHORT) {
    const { page, errors, done } = await onDesk(browser, c, {}, viewport);
    const at = `${viewport.width} × ${viewport.height}`;
    try {
      const paper = await box(page, '#book section > div'),
        islands = await page.$$eval('#book nav [role=toolbar]', all =>
          all.map(el => el.getBoundingClientRect().toJSON()).filter(r => r.width),
        ),
        // (the faces scroll in their island: theirs is the island's box)
        controls = await page.$$eval('#book nav [role=toolbar] button', all =>
          all
            .filter(b => b.getClientRects().length && !b.matches('.bk-face'))
            .map(b => ({ name: b.getAttribute('aria-label'), ...b.getBoundingClientRect().toJSON() })),
        );
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
      for (const name of ['Undo', 'Redo'])
        assert.ok(
          controls.some(r => r.name === name),
          `${at}: no ${name}`,
        );
      if (viewport === SHORT[0]) await c.shot('book-frame-short', page);
      assert.deepEqual(errors, []);
    } finally {
      await done();
    }
  }
}
// The pairing card on the paper, its QR, its digits, its field and Join inside it, none cut off
async function whole(page, when) {
  const card = page.getByRole('region', { name: 'Another screen' }),
    field = card.getByRole('textbox', { name: 'A code from the other screen' }),
    join = card.getByRole('button', { name: 'Join' });
  await field.waitFor({ timeout: 3000 });
  const paper = await box(page, '#book section > div'),
    k = await card.boundingBox(),
    f = await field.boundingBox(),
    j = await join.boundingBox();
  const inside = (a, b) =>
    a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
  assert.ok(inside(k, paper), `${when}: the card ${JSON.stringify(k)} off the paper ${JSON.stringify(paper)}`);
  assert.ok(
    inside(f, k) && inside(j, k),
    `${when}: the field ${JSON.stringify(f)} or Join ${JSON.stringify(j)} cut off`,
  );
  assert.ok(f.width >= 90, `${when}: a field ${f.width} px wide`);
  assert.ok(j.x >= f.x + f.width, `${when}: Join over the field`);
  assert.ok(await card.getByRole('img', { name: 'A code to scan' }).isVisible(), `${when}: the QR shows`);
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
// The boxes of the islands' stack that show, one column or two
const stackOf = page =>
  page.$$eval('#book nav .bk-islands [role=toolbar]', all =>
    all.map(el => el.getBoundingClientRect().toJSON()).filter(r => r.width),
  );
const spineLeft = page =>
  page.evaluate(() => Math.round(document.querySelector('#book [role=separator]').getBoundingClientRect().left));
// The mean lightness (0-255) of a box on the screen, read from a screenshot of it
async function meanLight(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
        g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, cv.width, cv.height);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return Math.round(sum / (data.length / 4));
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
}
