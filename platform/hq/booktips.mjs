// book-check.mjs's tips story (shell/booktips.js, booktipslist.js): the Tips control among the book's controls opens a
// small book over the screen, on an iPad mini, a phone (its book spread) and a desktop. It opens on its cover, the
// book's name from the company's brand (brand.yaml names: book) with its flowing line, which swings open onto the
// contents: every tip listed by its part, a page each with its scene, title and words. A contents line, the arrow keys,
// a swipe and the arrows turn its pages, each at once (two keys in quick succession land two pages on: nothing waits
// for a turn). Escape or a tap outside it put it away, leaving nothing behind. With reduced motion every scene holds
// still.
import assert from 'node:assert/strict';
import { mockBrand } from './serve.mjs';

const SCREENS = {
  mini: { viewport: { width: 1133, height: 744 }, more: {}, mode: 'open' },
  phone: { viewport: { width: 390, height: 844 }, more: {}, mode: 'spread' },
  desktop: { viewport: { width: 1440, height: 900 }, more: { deviceScaleFactor: 1, hasTouch: false }, mode: 'open' },
};
const CONTROL = '#book .bk-tips';
// The book's name as HQ gets it here (none: Tips on the cover)
const NAME = (await mockBrand()).brand.names?.book ?? 'Tips';

// c: book-check's { browser, hqIn, base, settled, shot, noErrorsIn }
export async function tipsStory(c) {
  for (const [name, screen] of Object.entries(SCREENS)) {
    const context = await c.hqIn(c.browser, screen.viewport, screen.more),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`${c.base}/?intro=0`);
      await page.waitForSelector('#loading.gone');
      if (name === 'phone') {
        await c.settled(page, 'folded');
        await page.click('#book .bk-lip');
      }
      await c.settled(page, screen.mode);
      await opened(c, page, name);
      await turned(page);
      await page.keyboard.press('Escape');
      await gone(page, 'Escape');
      await page.click(CONTROL);
      await page.waitForSelector('.tb-book');
      await page.mouse.click(8, screen.viewport.height / 2);
      await gone(page, 'a tap outside it');
      c.noErrorsIn(errors);
    } finally {
      await context.close();
    }
  }
  await stillScenes(c);
}

// Opened: the cover first, then the contents listing every tip, each tip a page with its scene
async function opened(c, page, name) {
  await page.click(CONTROL);
  await page.waitForSelector('.tb-cover-face .tb-logo');
  assert.equal(await page.getAttribute(CONTROL, 'aria-pressed'), 'true', 'the control pressed');
  assert.equal(await page.textContent('.tb-cover-face .tb-logo text'), NAME, "the cover: the book's name");
  assert.ok(await page.locator('.tb-cover-face .tb-logo path').count(), 'its flowing line');
  await c.shot(`tips-cover-${name}`, page);
  await page.waitForSelector('.tb-cover.tb-open', { state: 'attached', timeout: 3000 });
  const leaves = await page.$$eval('.tb-leaf', els =>
    els.slice(1).map(el => ({
      title: el.querySelector('h3')?.textContent,
      words: el.querySelector('.tb-words')?.textContent,
      scene: !!el.querySelector('svg.tb-scene'),
    })),
  );
  const listed = await page.$$eval('.tb-contents [data-to]', els => els.map(el => el.textContent));
  assert.ok(leaves.length > 0, 'a tip a page');
  assert.deepEqual(listed.toSorted(), leaves.map(l => l.title).toSorted(), 'the contents list every tip');
  for (const l of leaves) assert.ok(l.title && l.words && l.scene, `"${l.title}": its title, words and scene`);
  const box = await page.locator('.tb-book').boundingBox(),
    size = page.viewportSize();
  assert.ok(
    box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height,
    'whole on the screen',
  );
  await c.shot(`tips-contents-${name}`, page);
}
const count = page => page.textContent('.tb-count');
// Turned by a contents line, the keys (two quick ones go two on), a swipe, and back home
async function turned(page) {
  const n = await page.locator('.tb-contents [data-to]').count();
  await page.click('.tb-contents [data-to="3"]');
  assert.equal(await count(page), `3 / ${n}`, 'a contents line turns to its tip');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await count(page), `5 / ${n}`, 'two quick keys, two pages: no waiting on the turn');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await count(page), `4 / ${n}`, 'back a page');
  const box = await page.locator('.tb-book').boundingBox(),
    y = box.y + box.height * 0.6;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, y, { steps: 4 });
  await page.mouse.up();
  assert.equal(await count(page), `5 / ${n}`, 'a swipe left turns on');
  assert.equal(
    await page.$$eval('.tb-leaf:not([inert]) svg.tb-scene', s => s.length === 1 && !s[0].animationsPaused()),
    true,
    "the page's scene plays",
  );
  await page.keyboard.press('Home');
  assert.equal(await count(page), 'Contents', 'Home: the contents');
  for (let i = 0; i < n + 3; i++) await page.keyboard.press('Tab');
  assert.ok(
    await page.evaluate(() => !!document.activeElement.closest('.tb-book')),
    'Tab goes round the book, never out',
  );
}
async function gone(page, how) {
  await page.waitForSelector('.tb', { state: 'detached', timeout: 2000 });
  assert.equal(await page.getAttribute(CONTROL, 'aria-pressed'), 'false', `${how}: put away, the control up`);
}

// Reduced motion: the book fades in, its cover already open, and the page's scene holds still at its end
async function stillScenes(c) {
  const context = await c.hqIn(c.browser, SCREENS.desktop.viewport, {
      ...SCREENS.desktop.more,
      reducedMotion: 'reduce',
    }),
    page = await context.newPage();
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#loading.gone');
    await c.settled(page, 'open');
    await page.click(CONTROL);
    await page.waitForSelector('.tb-cover.tb-open', { state: 'attached' });
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.$eval('.tb-leaf:not([inert]) svg.tb-scene', s => s.animationsPaused()), true, 'still');
    await c.shot('tips-still', page);
  } finally {
    await context.close();
  }
}
