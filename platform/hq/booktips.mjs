// book-check.mjs's tips story (shell/booktips.js, booktipslist.js): the Tips control among the book's controls opens a
// small book in the middle of the screen, on an iPad mini, a phone (its book spread) and a desktop. It opens flat, no
// cover and no turning pages: the contents on the left page, under the book's name from the company's brand (brand.yaml
// names: book) with its flowing line, every tip listed by its part, and the first tip on the right, its scene, title
// and words. A contents line, the arrow keys, a swipe and the arrows change the right page, each at once (two keys in
// quick succession land two tips on: nothing waits for an animation), the contents marking the tip shown. On a phone the
// pages take turns: the contents first, a tip on its own, and Contents back. Escape or a tap outside it put it away,
// leaving nothing behind. With reduced motion every scene holds still. (the open book)
import assert from 'node:assert/strict';
import { mockBrand } from './serve.mjs';

const SCREENS = {
  mini: { viewport: { width: 1133, height: 744 }, more: {}, mode: 'open' },
  phone: { viewport: { width: 390, height: 844 }, more: {}, mode: 'spread' },
  desktop: { viewport: { width: 1440, height: 900 }, more: { deviceScaleFactor: 1, hasTouch: false }, mode: 'open' },
};
const CONTROL = '#book .bk-tips';
// The book's name as HQ gets it here (none: no name over the contents)
const NAME = (await mockBrand()).brand.names?.book;

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
      await turned(c, page, name);
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

// Opened: whole and in the middle of the screen, the contents listing every tip on the left, the first tip on the right
// (a phone's: the contents alone), each tip with its scene
async function opened(c, page, name) {
  await page.click(CONTROL);
  await page.waitForSelector('.tb-book');
  assert.equal(await page.getAttribute(CONTROL, 'aria-pressed'), 'true', 'the control pressed');
  if (NAME)
    assert.equal(await page.textContent('.tb-contents .tb-logo text'), NAME, "over the contents: the book's name");
  const leaves = await page.$$eval('.tb-leaf', els =>
    els.map(el => ({
      title: el.querySelector('h3')?.textContent,
      words: el.querySelector('.tb-words')?.textContent,
      scene: !!el.querySelector('svg.tb-scene'),
    })),
  );
  const listed = await page.$$eval('.tb-contents [data-to]', els => els.map(el => el.textContent));
  assert.ok(leaves.length > 0, 'a tip a page');
  assert.deepEqual(listed.toSorted(), leaves.map(l => l.title).toSorted(), 'the contents list every tip');
  for (const l of leaves) assert.ok(l.title && l.words && l.scene, `"${l.title}": its title, words and scene`);
  // (once it has come up from the button)
  await page.waitForFunction(() => !document.querySelector('.tb-book').getAnimations().length, null, {
    timeout: 30000,
  });
  const box = await page.locator('.tb-book').boundingBox(),
    size = page.viewportSize();
  assert.ok(
    box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height,
    'whole on the screen',
  );
  assert.ok(
    Math.abs(box.x + box.width / 2 - size.width / 2) <= 1 && Math.abs(box.y + box.height / 2 - size.height / 2) <= 1,
    'in the middle of the screen',
  );
  const contents = await page.locator('.tb-contents').boundingBox(),
    tip = await page.locator('.tb-tip').boundingBox();
  if (name === 'phone') assert.equal(tip, null, "a phone's book: the contents first, alone");
  else {
    assert.ok(contents.x + contents.width <= tip.x + 1, 'the contents on the left page, the tip on the right');
    assert.equal(await count(page), `1 / ${leaves.length}`, 'open at the first tip');
  }
  await c.shot(`tips-open-${name}`, page);
}
const count = page => page.textContent('.tb-count');
const marked = page => page.$eval('.tb-contents [aria-current]', el => +el.dataset.to + 1);
// Changed by a contents line, the keys (two quick ones go two on), a swipe, and back to the contents
async function turned(c, page, name) {
  const n = await page.locator('.tb-contents [data-to]').count();
  await page.click('.tb-contents [data-to="2"]');
  assert.equal(await count(page), `3 / ${n}`, 'a contents line opens its tip');
  if (name === 'phone')
    assert.equal(await page.locator('.tb-contents').boundingBox(), null, "a phone's book: the tip on its own page");
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await count(page), `5 / ${n}`, 'two quick keys, two tips: no waiting on a fade');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await count(page), `4 / ${n}`, 'back a tip');
  assert.equal(await marked(page), 4, 'the contents mark the tip shown');
  for (let i = 0; i < 6; i++) await page.click('.tb-on');
  assert.equal(await count(page), `10 / ${n}`, 'six quick clicks on Next, six tips on');
  const box = await page.locator('.tb-tip').boundingBox(),
    y = box.y + box.height * 0.6;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 4 });
  await page.mouse.up();
  assert.equal(await count(page), `11 / ${n}`, 'a swipe left goes on');
  assert.equal(
    await page.$$eval('.tb-leaf:not([hidden]) svg.tb-scene', s => s.length === 1 && !s[0].animationsPaused()),
    true,
    "the tip's scene plays",
  );
  await c.shot(`tips-tip-${name}`, page);
  if (name === 'phone') {
    await page.click('.tb-home');
    assert.ok(await page.locator('.tb-contents').boundingBox(), 'Contents: back to the contents');
  }
  for (let i = 0; i < n + 3; i++) await page.keyboard.press('Tab');
  assert.ok(
    await page.evaluate(() => !!document.activeElement.closest('.tb-book')),
    'Tab goes round the book, never out',
  );
}
async function gone(page, how) {
  await page.waitForSelector('.tb', { state: 'detached', timeout: 30000 }); // (its put-away's frames: late on a loaded machine)
  assert.equal(await page.getAttribute(CONTROL, 'aria-pressed'), 'false', `${how}: put away, the control up`);
}

// Reduced motion: the book fades in, and the tip's scene holds still at its end
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
    await page.waitForSelector('.tb-book');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.$eval('.tb-leaf:not([hidden]) svg.tb-scene', s => s.animationsPaused()), true, 'still');
    await c.shot('tips-still', page);
  } finally {
    await context.close();
  }
}
