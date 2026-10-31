// book-check.mjs's tips story (shell/booktips.js, booktipslist.js): the Tips control among the notebook's controls
// brings up a real book in the middle of the screen, on an iPad mini, a phone and a desktop. It comes up shut, a hard
// cover, which swings open by itself onto two-page spreads: the title inside the cover and the index on the right,
// listing every tip by its chapter, then a spread a tip (its chapter, title and words on the left, the Ink deck's
// picture or motion study of it on the right, every one served). A turn is a leaf printed on both sides going over the spine; nothing waits on one (two keys in quick
// succession land two spreads on). An index line turns to its tip, Contents and Home back to the index, and back from
// the index the cover closes. On a phone the book is one page wide, a spread's two pages one above the other. Nowhere
// does it say "ring": it's "circle". Escape or a tap outside put it away, leaving nothing behind.
// With reduced motion every film holds still on its poster.
import assert from 'node:assert/strict';
import { mockBrand } from './serve.mjs';
import { DESKTOP, MINI } from './bookkit.mjs';

const SCREENS = {
  mini: { viewport: MINI, more: {}, mode: 'open' },
  phone: { viewport: { width: 390, height: 844 }, more: {}, mode: 'spread' },
  desktop: { viewport: DESKTOP, more: { deviceScaleFactor: 1, hasTouch: false }, mode: 'open' },
};
const CONTROL = '#book .bk-tips';
// The book's name as HQ gets it here (none: no name over the title)
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
      await tips(page);
      await page.waitForSelector('.tb-book');
      await page.mouse.click(4, screen.viewport.height / 2);
      await gone(page, 'a tap outside it');
      c.noErrorsIn(errors);
    } finally {
      await context.close();
    }
  }
  await stillScenes(c);
}

// The Tips control, on the rail or, where the rail folds it away (an iPad mini), in More
async function tips(page) {
  if (await page.locator(CONTROL).isVisible()) return page.click(CONTROL);
  await page.click('#book .bk-more');
  await page.click('.bk-more-card [role="menuitem"]:has-text("Tips")');
}
// What leaves turn from now on: whether one was the cover, and the most sides one had (seen as they're put in: a turn
// may be over by the time a press returns)
const watchLeaves = page =>
  page.evaluate(() => {
    window.leaves = { cover: false, sides: 0 };
    new MutationObserver(() => {
      for (const leaf of document.querySelectorAll('.tb-leaf')) {
        window.leaves.cover ||= !!leaf.querySelector('.tb-side-front .tb-cover');
        window.leaves.sides = Math.max(window.leaves.sides, leaf.querySelectorAll('.tb-side').length);
      }
    }).observe(document.getElementById('book'), { childList: true, subtree: true });
  });
const count = page => page.textContent('.tb-count');
const at = page =>
  page.$eval('.tb-book', el =>
    el.classList.contains('tb-shut') ? -1 : +el.querySelector('.tb-spread:not([hidden])').dataset.n,
  );
// No turn under way: the book's pictures and leaves gone, nothing of it moving
const turnedOver = page =>
  page.waitForFunction(
    () =>
      !document.querySelector('.tb-leaf, [class*="tb-over-"]') &&
      !document.querySelector('.tb-book').getAnimations().length,
    null,
    { timeout: 30000 },
  );

// Up shut, its cover alone in the middle; the cover opening as a leaf onto the first spread, the title and the
// index, the book whole and in the middle; every tip a spread with its title, words and picture or film, each served
async function opened(c, page, name) {
  // (watched from before it's pressed: the cover's turn may be over by the time a press through More returns)
  await watchLeaves(page);
  await tips(page);
  await page.waitForSelector('.tb-book');
  assert.equal(await page.getAttribute(CONTROL, 'aria-pressed'), 'true', 'the control pressed');
  await turnedOver(page);
  assert.ok(await page.evaluate(() => window.leaves.cover), 'up shut, its cover turning open as a leaf');
  assert.equal(await at(page), 0, 'the cover opens by itself onto the first spread');
  assert.ok(!(await page.locator('.tb-cover').isVisible()), 'open: the cover away');
  if (NAME) assert.equal(await page.textContent('.tb-title .tb-logo text'), NAME, "on the title: the book's name");

  const spreads = await page.$$eval('.tb-spread:not([data-n="0"])', els =>
    els.map(el => ({
      title: el.querySelector('.tb-l h2')?.textContent,
      words: el.querySelector('.tb-words')?.textContent,
      kicker: el.querySelector('.tb-kicker')?.textContent,
      shot: !!el.querySelector('.tb-r .tb-shot :is(img, video)'),
    })),
  );
  const listed = await page.$$eval('.tb-index [data-to] span', els => els.map(el => el.textContent));
  assert.ok(spreads.length > 0, 'a tip a spread');
  assert.deepEqual(listed.toSorted(), spreads.map(s => s.title).toSorted(), 'the index lists every tip');
  for (const s of spreads)
    assert.ok(s.title && s.words && s.kicker && s.shot, `"${s.title}": its chapter, words, picture`);
  await served(page);
  const said = await page.$eval('.tb-book', el => el.textContent);
  assert.doesNotMatch(said, /\bring(s|ed|ing)?\b/i, 'circle, never ring');

  const box = await page.locator('.tb-spread:not([hidden])').boundingBox(),
    size = page.viewportSize();
  assert.ok(
    box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height,
    'whole on the screen',
  );
  assert.ok(
    Math.abs(box.x + box.width / 2 - size.width / 2) <= 1 && Math.abs(box.y + box.height / 2 - size.height / 2) <= 1,
    'in the middle of the screen',
  );
  const left = await page.locator('.tb-spread:not([hidden]) .tb-l').boundingBox(),
    right = await page.locator('.tb-spread:not([hidden]) .tb-r').boundingBox();
  if (name === 'phone')
    assert.ok(right.y >= left.y + left.height - 1, "a phone's book one page wide: the index under the title");
  else {
    assert.ok(left.x + left.width <= right.x + 1, 'a spread: the title on the left page, the index on the right');
    assert.ok(Math.abs(left.width - right.width) <= 1, 'two pages the same width');
  }
  await c.shot(`tips-open-${name}`, page);
}

// Turned by an index line, the keys (two quick ones go two on), the corner's ›, a swipe; Tab staying in the book
async function turned(c, page, name) {
  const n = await page.locator('.tb-index [data-to]').count();
  await watchLeaves(page);
  await page.click('.tb-index [data-to="3"]');
  assert.equal(await count(page), `3 / ${n}`, 'an index line turns to its tip');
  if (name !== 'phone')
    assert.equal(
      await page.evaluate(() => window.leaves.sides),
      2,
      'a leaf turning over the spine, printed on both sides',
    );
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await count(page), `5 / ${n}`, 'two quick keys, two spreads: no waiting on a turn');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await count(page), `4 / ${n}`, 'back a spread');
  for (let i = 0; i < 6; i++) await page.click('.tb-on');
  assert.equal(await count(page), `10 / ${n}`, 'six quick clicks on ›, six spreads on');
  await turnedOver(page);
  const box = await page.locator('.tb-spread:not([hidden])').boundingBox(),
    y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, y, { steps: 4 });
  await page.mouse.up();
  assert.equal(await count(page), `11 / ${n}`, 'a swipe to the left turns on');
  await turnedOver(page);
  await page.waitForFunction(
    () => document.querySelector('.tb-spread:not([hidden]) .tb-shot img')?.naturalWidth > 0,
    null,
    {
      timeout: 30000,
    },
  );
  await c.shot(`tips-tip-${name}`, page);
  await filmPlays(page);
  for (let i = 0; i < n + 6; i++) await page.keyboard.press('Tab');
  assert.ok(
    await page.evaluate(() => !!document.activeElement.closest('.tb-book')),
    'Tab goes round the book, never out',
  );
  await closedAgain(c, page, name);
}
// Every tip's picture, film and poster there to show
async function served(page) {
  const missing = await page.$$eval('.tb-shot :is(img, video)', async els => {
    const files = els.flatMap(el => [el.src, el.poster].filter(Boolean));
    const got = await Promise.all(files.map(f => fetch(f, { method: 'HEAD' })));
    return files.filter((f, i) => !got[i].ok || !/^(image|video)\//.test(got[i].headers.get('content-type')));
  });
  assert.deepEqual(missing, [], 'every picture, film and poster served');
}
// A film plays as its spread shows, the rest held (Playwright's Chromium can't decode H.264: what's checked is that
// it's set to play)
async function filmPlays(page) {
  const film = await page.$eval('.tb-spread:has(video)', el => el.dataset.n);
  await page.click('.tb-home');
  await page.click(`.tb-index [data-to="${film}"]`);
  assert.deepEqual(
    await page.$$eval('.tb-spread video', els =>
      els.filter(el => el.autoplay).map(el => el.closest('.tb-spread').dataset.n),
    ),
    [film],
    'the film on its spread playing, every other one held',
  );
}
// Contents and Home back to the index, and back from there the cover closing, in the middle; a tap opening it again
async function closedAgain(c, page, name) {
  await page.click('.tb-home');
  assert.equal(await at(page), 0, 'Contents: back to the index');
  await page.click('.tb-index [data-to="7"]');
  await page.keyboard.press('Home');
  assert.equal(await at(page), 0, 'Home: back to the index');
  await page.keyboard.press('ArrowLeft');
  await turnedOver(page);
  assert.ok(await page.locator('.tb-cover').isVisible(), 'back from the index the cover closes');
  const shut = await page.locator('.tb-cover').boundingBox(),
    size = page.viewportSize();
  assert.ok(Math.abs(shut.x + shut.width / 2 - size.width / 2) <= 2, 'shut, the cover in the middle');
  await c.shot(`tips-shut-${name}`, page);
  await page.click('.tb-cover');
  assert.equal(await at(page), 0, 'a tap on the cover opens it');
  await turnedOver(page);
}
async function gone(page, how) {
  await page.waitForSelector('.tb', { state: 'detached', timeout: 30000 }); // (its put-away's frames: late on a loaded machine)
  assert.equal(await page.getAttribute(CONTROL, 'aria-pressed'), 'false', `${how}: put away, the control up`);
}

// Reduced motion: the book fades in, its turns are crossfades, and a tip's film holds still on its poster
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
    await tips(page);
    await page.waitForSelector('.tb-book');
    await page.waitForFunction(() => document.querySelector('.tb-spread:not([hidden])'), null, { timeout: 30000 });
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.tb-leaf').count(), 0, 'no leaf turning: a crossfade');
    const film = await page.$eval('.tb-spread:has(video)', el => el.dataset.n);
    await page.keyboard.press('Home');
    await page.click(`.tb-index [data-to="${film}"]`);
    assert.equal(
      await page.$eval('.tb-spread:not([hidden]) video', v => v.paused && !v.autoplay && !!v.poster),
      true,
      'its film still, on its poster',
    );
    await c.shot('tips-still', page);
  } finally {
    await context.close();
  }
}
