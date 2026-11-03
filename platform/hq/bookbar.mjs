// book-check.mjs's story of the book's two islands over its paper (shell/ink/bookui.js, bookstrip.js,
// bookcontrols.js, bookrail.js): on a phone (under a home-screen app's blurred strip) and an iPad mini both ways and a
// desktop with the notebook wide and narrow. The tools upright at the paper's right, centred in the room above the bar,
// in their order with one pen, and well under half a phone's height; the bar along the foot, Undo and Redo at its left,
// the page's arrows and where it is ("3 / 12") in its very middle, its dots at its right. The overview and New page on
// the bar where the paper is 460 px wide or more, else in the dots menu, every row of which does what it says. No
// island scrolls or leaves the screen, each key is 44 px to the touch, nothing pressable sits above --sat, and what's
// written ends left of the tools. Undo, Redo and the page's keys never move. A tool's card opens left of the tools and
// the bar's above the bar, whole. Press and slide: a press on the pen slid down to Text picks Text the moment it lifts,
// with no hold (the mouse, and in Chromium a finger). No long press: a tool held picks it and opens nothing. Run with
// --webkit for the same in the iPad's engine. (the islands: board, call 190.)
import assert from 'node:assert/strict';
import { freePage } from './bookmouse.mjs';
import { OVERVIEW, PREFERENCES, touchOf, until } from './bookkit.mjs';
import { fits } from './bookbarfits.mjs';

// (sat: a home-screen app's blurred strip at the top, px: style.css's --sat)
const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true, sat: 47 },
  { name: 'phone-sideways', viewport: { width: 844, height: 390 }, touch: true },
  { name: 'mini-upright', viewport: { width: 744, height: 1133 }, touch: true },
  { name: 'mini-sideways', viewport: { width: 1133, height: 744 }, touch: true },
  { name: 'desktop-wide', viewport: { width: 1920, height: 1080 }, touch: false },
  { name: 'desktop-narrow', viewport: { width: 1920, height: 1080 }, touch: false, narrow: 420 },
];
// the dots menu's own rows, after the page's keys folded into it on a narrow paper (bookui.js)
const ROWS = ['Tear off and send', PREFERENCES, 'Tips', 'Close notebook'];
// a slide's lift picks its tool this soon (ms)
const PICK_MS = 100;

// c: book-check.mjs's played store and helpers
export function barStories(c) {
  return {
    "the islands: the tools at the paper's right and the bar along its foot at every size, the page's count in the bar's middle, the rest in its dots, none scrolling; press and slide picks with no hold":
      async browser => {
        for (const size of SIZES)
          try {
            await atSize(browser, c, size);
          } catch (e) {
            e.message = `${size.name}: ${e.message}`;
            throw e;
          }
      },
  };
}

async function atSize(browser, c, size) {
  freePage(c);
  const context = await c.hqIn(browser, size.viewport, { hasTouch: size.touch, deviceScaleFactor: 1 }),
    page = await context.newPage(),
    errors = [];
  if (size.sat)
    await context.addInitScript(px => {
      document.addEventListener('DOMContentLoaded', () =>
        document.documentElement.style.setProperty('--sat', `${px}px`),
      );
    }, size.sat);
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-lip', { timeout: 30_000 });
    await opened(page);
    if (size.narrow) await narrowed(page, size.narrow);
    await atRest(page);
    await c.shot(`book-islands-${size.name}`, page);
    const wide = await fits(page, size);
    await keysStay(page, size);
    await cards(page, c, size);
    await slides(page, size, browser);
    await noHold(page);
    await menuRows(page, c, size, wide);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// The book open: tapped open by its pull tab where it opens folded (a phone's)
async function opened(page) {
  const state = () => page.evaluate(() => document.documentElement.dataset.book);
  await page.waitForTimeout(800);
  if (!['open', 'spread'].includes(await state())) await page.locator('#book .bk-lip').click();
  await until(async () => ['open', 'spread'].includes(await state()), 'the book open');
  await page.locator('#book [data-island=tools] .bk-btn').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(800);
}
// The cover's edge dragged until the notebook is about this wide
async function narrowed(page, width) {
  const edge = await page.locator('#book [role=separator]').boundingBox(),
    view = page.viewportSize();
  await page.mouse.move(edge.x + edge.width / 2, view.height / 2);
  await page.mouse.down();
  await page.mouse.move(view.width - width, view.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}
// The book at rest, its swing over and both islands laid out (on a loaded machine, frames come late)
const atRest = page =>
  until(
    () =>
      page.evaluate(
        () =>
          !document.querySelector('#book.bk-swinging') &&
          ['.bk-strip', '.bk-bar'].every(s => document.querySelector(`#book ${s}`).getBoundingClientRect().width),
      ),
    'the book at rest, its islands laid out',
  );

// A control of the book's pressed: on its islands, or from the dots menu where the bar has folded it away (the book's
// other checks' too)
export async function press(page, name) {
  const own = page.locator('#book .bk-controls').getByRole('button', { name, exact: true });
  if (await own.isVisible()) return own.click();
  await page.locator('#book .bk-more').click();
  await page.locator('#book .bk-more-card').getByRole('menuitem', { name, exact: true }).click();
}

// ---- what stays where it was

// Undo, Redo and the page's keys (the bar's left and middle), where they are on the screen (px)
const keysOf = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('#book .bk-bar :is(.bk-bar-start, .bk-bar-middle) .bk-btn')].map(b => {
      const r = b.getBoundingClientRect();
      return [b.className.split(' ').find(n => n !== 'bk-btn') ?? '', ...[r.x, r.y, r.width, r.height].map(Math.round)];
    }),
  );
// Undo, Redo and the page's keys never move, so a tap does what the board meant: where they were at rest with another
// tool in use and with each card open; and in the overview the bar only its own key, pressed, which brings the page
// back with them where they were
async function keysStay(page, size) {
  const rest = await keysOf(page),
    stays = async state =>
      assert.deepEqual(await keysOf(page), rest, `${size.name}, ${state}: Undo, Redo and the page's keys moved`);
  const tools = page.locator('#book [data-island=tools]');
  for (const name of ['Eraser', 'Text', 'Pen']) {
    await tools.getByRole('button', { name, exact: true }).click();
    await stays(`${name} in use`);
  }
  for (const [name, opened, selector] of [
    [PREFERENCES, () => press(page, PREFERENCES), '.bk-prefs'],
    ['Pen', () => press(page, 'Pen'), '.bk-palette'],
    ['the pages', () => page.locator('#book .bk-where').click(), '.bk-pages-menu'],
    ['More', () => press(page, 'More'), '.bk-more-card'],
  ]) {
    await opened();
    await page.locator(`#book ${selector}`).waitFor({ state: 'visible', timeout: 5000 });
    await stays(`${name}'s card open`);
    await page.keyboard.press('Escape');
    await page.locator(`#book ${selector}`).waitFor({ state: 'detached', timeout: 5000 });
  }
  await press(page, OVERVIEW);
  await page.locator('#book[data-far]').waitFor({ state: 'attached', timeout: 5000 });
  const far = await page.evaluate(() => ({
    tools: document.querySelector('#book .bk-strip').checkVisibility(),
    bar: [...document.querySelectorAll('#book .bk-bar .bk-btn')]
      .filter(b => b.checkVisibility({ visibilityProperty: true }))
      .map(b => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]),
  }));
  assert.deepEqual(far, { tools: false, bar: [[OVERVIEW, 'true']] }, 'the overview: its own key alone, pressed');
  await press(page, OVERVIEW);
  await until(() => page.evaluate(() => !document.querySelector('#book[data-far]')), 'the page back');
  await atRest(page);
  await stays('back from the overview');
}

// ---- the cards

// The preferences and the pen's card (the pen in use pressed again) whole on the screen and on top: the pen's left of
// the tools, the preferences above the bar
async function cards(page, c, size) {
  for (const [name, selector, side] of [
    [PREFERENCES, '.bk-prefs', 'above the bar'],
    ['Pen', '.bk-palette', 'left of the tools'],
  ]) {
    await press(page, name);
    const card = page.locator(`#book ${selector}`);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    await c.shot(`book-islands-${size.name}-${selector.slice(4)}`, page);
    const [b, strip, bar] = [
        await card.boundingBox(),
        await page.locator('#book .bk-strip').boundingBox(),
        await page.locator('#book .bk-bar').boundingBox(),
      ],
      view = page.viewportSize();
    assert.ok(
      b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height,
      `${name}'s card on the screen: ${JSON.stringify(b)}`,
    );
    const beside = side === 'above the bar' ? b.y + b.height <= bar.y + 1 : b.x + b.width <= strip.x + 1;
    assert.ok(beside, `${name}'s card ${side}: ${JSON.stringify({ card: b, strip, bar })}`);
    const mine = await card.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    assert.ok(mine, `${name}'s card on top, nothing over it`);
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });
  }
}

// ---- the dots menu

// The dots menu's rows, the page's keys first where the bar has no room for them; each row does what it says: the
// overview, New page, the tear's targets, the preferences, the tips book, and Close notebook folding the book (last).
async function menuRows(page, c, size, wide) {
  const dots = page.locator('#book .bk-more'),
    menu = page.locator('#book .bk-more-card'),
    row = name => menu.getByRole('menuitem', { name, exact: true }),
    picked = async name => {
      await dots.click();
      await row(name).click();
      await menu.waitFor({ state: 'detached', timeout: 5000 });
    };
  await dots.click();
  await menu.waitFor({ timeout: 5000 });
  await c.shot(`book-islands-${size.name}-more`, page);
  const rows = await menu.getByRole('menuitem').evaluateAll(all => all.map(b => b.textContent));
  assert.deepEqual(rows, [...(wide ? [] : [OVERVIEW, 'New page']), ...ROWS], "the dots menu's rows");
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  if (!wide) {
    await picked(OVERVIEW);
    await page.locator('#book[data-far]').waitFor({ state: 'attached', timeout: 5000 });
    await press(page, OVERVIEW);
    await until(() => page.evaluate(() => !document.querySelector('#book[data-far]')), 'the page back');
    const where = () => page.locator('#book .bk-where').textContent(),
      [, n] = (await where()).match(/\/ (\d+)$/);
    // (a blank page is New page's own: a line on it first)
    await written(page);
    await picked('New page');
    await until(
      async () => (await where()) === `${+n + 1} / ${+n + 1}`,
      () => `New page making page ${+n + 1}`,
    );
  }
  for (const [name, shows, gone] of [
    ['Tear off and send', '#book .bk-share:not([hidden])', '#book .bk-share:not([hidden])'],
    [PREFERENCES, '#book .bk-prefs', '#book .bk-prefs'],
    ['Tips', '.tb-book', '.tb'],
  ]) {
    await picked(name);
    await page.locator(shows).waitFor({ state: 'visible', timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.locator(gone).waitFor({ state: 'detached', timeout: 10_000 });
  }
  await picked('Close notebook');
  await until(
    () => page.evaluate(() => ['folded', 'shut'].includes(document.documentElement.dataset.book)),
    'Close notebook folding the book',
  );
}

// A line with the mouse across the page's middle, the pen in hand
async function written(page) {
  await page.locator('#book [data-island=tools]').getByRole('button', { name: 'Pen', exact: true }).click();
  const desk = await page.locator('#book .bk-paper').first().boundingBox(),
    [x, y] = [desk.x + desk.width * 0.2, desk.y + desk.height * 0.5];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + i * 10, y + 8 * Math.sin(i / 2));
  await page.mouse.up();
  await page.waitForTimeout(600);
}

// ---- the tools picked

// A press on the pen slid down the tools to Text, then let go: Text in use within PICK_MS of the lift, with no hold
// before the slide; by the mouse everywhere, and by a finger in Chromium on a touch screen. Then a plain tap on the
// pen picks it.
async function slides(page, size, browser) {
  const tools = page.locator('#book [data-island=tools]'),
    at = async name => {
      const b = await tools.getByRole('button', { name, exact: true }).boundingBox();
      return [b.x + b.width / 2, b.y + b.height / 2];
    },
    pressed = () => tools.locator('[aria-pressed=true]').getAttribute('aria-label');
  const watch = () =>
    page.evaluate(() => {
      const text = document.querySelector('#book [data-island=tools] [data-mode=text]');
      window.__slid = { up: 0, picked: 0 };
      addEventListener('pointerup', () => (window.__slid.up = performance.now()), { capture: true, once: true });
      new MutationObserver((_, o) => {
        if (text.getAttribute('aria-pressed') !== 'true') return;
        window.__slid.picked = performance.now();
        o.disconnect();
      }).observe(text, { attributeFilter: ['aria-pressed'] });
    });
  const picked = async how => {
    await until(async () => (await pressed()) === 'Text', `Text picked by ${how}'s slide`, 2000);
    const t = await page.evaluate(() => window.__slid);
    assert.ok(t.picked - t.up < PICK_MS, `${how}: Text in use ${Math.round(t.picked - t.up)} ms after the lift`);
  };
  const [pen, text] = [await at('Pen'), await at('Text')];
  await watch();
  await page.mouse.move(...pen);
  await page.mouse.down();
  await page.mouse.move(...text, { steps: 8 });
  await page.mouse.up();
  await picked('the mouse');
  // a tap picks at once
  await tools.getByRole('button', { name: 'Pen', exact: true }).click();
  await until(async () => (await pressed()) === 'Pen', 'the pen picked by a tap', 2000);
  if (!size.touch || browser.browserType().name() !== 'chromium') return;
  const touch = touchOf(await page.context().newCDPSession(page));
  await watch();
  await touch.down([pen]);
  // (drifting a little left of the island as it goes: the tool level with the finger)
  await touch.move([[text[0] - 30, text[1]]], 8);
  await until(
    async () => ((await page.locator('#bk-tip').textContent()) ?? '').startsWith('Text'),
    "Text's name shown under the finger",
    2000,
  );
  await touch.up();
  await picked('a finger');
}

// No long press on the tools (board, the Ink 1.1 deck: "One rail, no scrolling"): the eraser held well past a long
// press picks it and opens no card.
async function noHold(page) {
  const eraser = page.locator('#book [data-island=tools] [data-mode=eraser]'),
    cards = page.locator('#book .bk-palette');
  await eraser.click({ delay: 900 });
  await until(async () => (await eraser.getAttribute('aria-pressed')) === 'true', 'the eraser picked by a held press');
  assert.equal(await cards.count(), 0, 'a held tool opens no card');
}
