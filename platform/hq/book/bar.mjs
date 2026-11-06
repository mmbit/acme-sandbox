// book-check.mjs's story of the book's two islands over its paper (shell/ink/bookui.js, bookstrip.js,
// bookcontrols.js, bookrail.js): on a phone (under a home-screen app's blurred strip) and an iPad mini both ways and a
// desktop with the notebook wide and narrow. On the page the bar along the foot, the overview at its left, the page's
// arrows and where it is ("3 / 12") in its very middle, its dots at its right, New page in the dots menu at every size,
// every row of which does what it says; on an opened scrap the tools upright at the paper's right, centred, in their
// order with one pen, Undo and Redo after them, and well under half a phone's height, the bar put away.
// The bar's spacing smaller inward: its margin at its ends the largest, then the room each
// side of a rule, alike at every rule, then the gap between two keys, alike in every group. No island scrolls or
// leaves the screen, each key is 44 px to the touch, nothing pressable sits above --sat, and what's written ends left
// of the tools. Undo, Redo and the page's keys never move. A tool's card opens left of the tools and
// the bar's above the bar, whole. Press and slide: a press on the pen slid down to Text picks Text the moment it lifts,
// with no hold (the mouse, and a finger). No long press: a tool held picks it and opens nothing. Run with
// --webkit for the same in the iPad's engine. (the blur set by islands.mjs) (at rest once its slide is over)
import assert from 'node:assert/strict';
import { freePage } from './mouse.mjs';
import { OVERVIEW, PREFERENCES, closeScrap, nothingMoving, openScrap, openScrapInMiddle, say, until } from './kit.mjs';
import { hands, mouseOf } from './hands.mjs';
import { fits, historyStays, keysOf } from './barfits.mjs';
import { blurred } from './islands.mjs';
import { watchedPage } from './start.mjs';

// (sat: a home-screen app's blurred strip at the top, px: style.css's --sat)
const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true, sat: 47 },
  { name: 'phone-sideways', viewport: { width: 844, height: 390 }, touch: true },
  { name: 'mini-upright', viewport: { width: 744, height: 1133 }, touch: true },
  { name: 'mini-sideways', viewport: { width: 1133, height: 744 }, touch: true },
  { name: 'desktop-wide', viewport: { width: 1920, height: 1080 }, touch: false },
  { name: 'desktop-narrow', viewport: { width: 1920, height: 1080 }, touch: false, narrow: 420 },
];
// the dots menu's rows: New page, then its own (bookui.js), Rename page first of the page's, Give a copy last of them
// (bookgive.js), no Close notebook (the pull tab closes the book).
const GIVE = say('givePage'),
  ROWS = ['New page', 'Rename page', 'Tear off and send', 'Archive this page', GIVE, PREFERENCES, 'Tips'];
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
  const context = await c.hqIn(browser, size.viewport, { hasTouch: size.touch, deviceScaleFactor: 1 });
  if (size.sat) await blurred(context, size);
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-lip', { timeout: 30_000 });
    await opened(page);
    if (size.narrow) await narrowed(page, size.narrow);
    await atRest(page);
    await c.shot(`book-islands-${size.name}`, page);
    await fits(page, false);
    await spaced(page);
    await keysStay(page, size);
    await cards(page, c, size, false);
    // (the tools on an opened scrap)
    const mouse = mouseOf(page);
    await openScrapInMiddle(page, mouse);
    await atRest(page);
    await c.shot(`book-islands-${size.name}-scrap`, page);
    await fits(page, true);
    await historyStays(page, size);
    await cards(page, c, size, true);
    await slides(page, size);
    await noHold(page);
    await closeScrap(page, mouse);
    await atRest(page);
    await menuRows(page, c, size);
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
  await page.locator('#book .bk-bar .bk-btn').first().waitFor({ state: 'visible', timeout: 30_000 });
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
// The book at rest, its swing over, its slide too (book.js glide: the cover's edge let go slides the book to its new
// width, the leaf laid out wide enough for both till it lands) and both islands laid out (on a loaded machine, frames
// come late: WebKit's slide was still under way a second after the cover's edge was let go), and nothing on it moving
// still (the bar and Undo's pill sliding back in from the overview.)
const atRest = async page => {
  await until(
    () =>
      page.evaluate(
        () =>
          !document.querySelector('#book.bk-swinging') &&
          ['.bk-edge', '.bk-leaf', '.bk-lip'].every(
            s => !document.querySelector(`#book ${s}`).getAnimations().length,
          ) &&
          // (the tools only on an opened scrap)
          [document.querySelector('#book[data-scrap-open]') ? '.bk-strip' : '.bk-bar'].every(
            s => document.querySelector(`#book ${s}`).getBoundingClientRect().width,
          ),
      ),
    'the book at rest, its islands laid out',
  );
  await nothingMoving(page);
};

// A control of the book's pressed: on its islands, or from the dots menu where the bar has folded it away (the book's
// other checks' too)
export async function press(page, name) {
  const own = page.locator('#book .bk-controls').getByRole('button', { name, exact: true });
  if (await own.isVisible()) return own.click();
  await page.locator('#book .bk-more').click();
  await page.locator('#book .bk-more-card').getByRole('menuitem', { name, exact: true }).click();
}

// ---- the bar's spacing

// The bar's spacing, smaller inward: its margin at either end the largest; then the room each side of a rule (the
// overview's, the page's arrows'), alike at every rule, so the parts sit apart alike on both sides of the middle; then
// the gap between two keys, alike in every group (the Ink README, The book's frame)
async function spaced(page) {
  const { outer, rules, keys } = await page.evaluate(barGaps),
    alike = list => Math.max(...list) - Math.min(...list) <= 0.5,
    said = JSON.stringify({ outer, rules, keys });
  assert.ok(alike(keys), `the gaps between the bar's keys alike in every group: ${said}`);
  assert.ok(alike(rules), `the room each side of the bar's rules alike: ${said}`);
  assert.ok(
    Math.max(...keys) < Math.min(...rules) && Math.max(...rules) < Math.min(...outer),
    `the bar's spacing smaller inward (its ends, then its rules, then its keys): ${said}`,
  );
}
// (in the page) The gaps along the bar (px, a tenth's precision): at its two ends (outer), between a key and a rule
// (rules) and between two keys (keys). A rule is a part's or group's drawn edge.
function barGaps() {
  const bar = document.querySelector('#book .bk-bar'),
    shows = el => el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0,
    stops = [...bar.querySelectorAll('.bk-btn')].filter(shows).map(b => {
      const r = b.getBoundingClientRect();
      return { kind: 'key', left: r.left, right: r.right };
    });
  for (const el of bar.querySelectorAll('*')) {
    if (el.closest('.bk-btn') || !shows(el)) continue;
    const r = el.getBoundingClientRect(),
      cs = getComputedStyle(el),
      [l, rr] = [parseFloat(cs.borderLeftWidth), parseFloat(cs.borderRightWidth)];
    if (l) stops.push({ kind: 'rule', left: r.left, right: r.left + l });
    if (rr) stops.push({ kind: 'rule', left: r.right - rr, right: r.right });
  }
  stops.sort((a, b) => a.left - b.left);
  const r = bar.getBoundingClientRect(),
    tenth = n => Math.round(n * 10) / 10,
    gaps = { outer: [tenth(stops[0].left - r.left), tenth(r.right - stops.at(-1).right)], rules: [], keys: [] };
  for (let i = 1; i < stops.length; i++)
    gaps[stops[i - 1].kind === 'key' && stops[i].kind === 'key' ? 'keys' : 'rules'].push(
      tenth(stops[i].left - stops[i - 1].right),
    );
  return gaps;
}

// ---- what stays where it was

// The page's keys never move, so a tap does what the board meant: where they were at rest with each card open; and in
// the overview no bar (it's all the pages already), its page's tile bringing the page back with them where they were
async function keysStay(page, size) {
  const rest = await keysOf(page),
    stays = async state => assert.deepEqual(await keysOf(page), rest, `${size.name}, ${state}: the page's keys moved`);
  for (const [name, opened, selector] of [
    [PREFERENCES, () => press(page, PREFERENCES), '.bk-prefs'],
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
      .map(b => b.getAttribute('aria-label')),
  }));
  assert.deepEqual(far, { tools: false, bar: [] }, 'the overview: no bar, no All pages');
  await page.locator('#book .bk-tile[aria-current="page"] .bk-tile-open').first().click();
  await until(() => page.evaluate(() => !document.querySelector('#book[data-far]')), 'the page back');
  await atRest(page);
  await stays('back from the overview');
}
// ---- the cards

// The preferences on the page and the pen's card (the pen in use pressed again) on an opened scrap (scrap) whole on the
// screen and on top: the pen's left of the tools, the preferences above the bar
async function cards(page, c, size, scrap) {
  for (const [name, selector, side] of scrap
    ? [['Pen', '.bk-palette', 'left of the tools']]
    : [[PREFERENCES, '.bk-prefs', 'above the bar']]) {
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

// The dots menu's rows, New page first; each row does what it says: New page, the tear's targets, the card that gives
// a copy, the preferences and the tips book; and the pull tab, in reach at every size, folds the book.
async function menuRows(page, c, size) {
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
  assert.deepEqual(rows, ROWS, "the dots menu's rows");
  const card = await menu.boundingBox(),
    view = page.viewportSize();
  assert.ok(
    card.x >= 0 && card.y >= 0 && card.x + card.width <= view.width && card.y + card.height <= view.height,
    `the dots menu whole on the screen: ${JSON.stringify(card)}`,
  );
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached', timeout: 5000 });
  const where = () => page.locator('#book .bk-where').textContent(),
    [, n] = (await where()).match(/\/ (\d+)$/);
  // (a blank page is New page's own: a line on it first)
  await written(page);
  await picked('New page');
  await until(
    async () => (await where()) === `${+n + 1} / ${+n + 1}`,
    () => `New page making page ${+n + 1}`,
  );
  for (const [name, shows, gone] of [
    ['Tear off and send', '#book .bk-share:not([hidden])', '#book .bk-share:not([hidden])'],
    [GIVE, '#book .bk-give', '#book .bk-give'],
    [PREFERENCES, '#book .bk-prefs', '#book .bk-prefs'],
    ['Tips', '.tb-book', '.tb'],
  ]) {
    await picked(name);
    await page.locator(shows).waitFor({ state: 'visible', timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.locator(gone).waitFor({ state: 'detached', timeout: 10_000 });
  }
  await page.locator('#book .bk-lip').click();
  await until(
    () => page.evaluate(() => ['folded', 'shut'].includes(document.documentElement.dataset.book)),
    'the pull tab folding the book',
  );
}

// A line with the mouse across a new scrap's middle, the pen in hand: a click on the grid opens the scrap, drawn on, and
// Klaar puts it down
async function written(page) {
  const mouse = mouseOf(page),
    desk = await page.locator('#book .bk-desk').boundingBox(),
    { sheet } = await openScrap(page, mouse, undefined, [desk.x + 60, desk.y + 160]),
    [x, y] = [sheet.x + sheet.width * 0.2, sheet.y + sheet.height * 0.5];
  // (the pen picked on the opened scrap's tools)
  await page.locator('#book [data-island=tools]').getByRole('button', { name: 'Pen', exact: true }).click();
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + i * 10, y + 8 * Math.sin(i / 2));
  await page.mouse.up();
  await closeScrap(page, mouse);
}

// ---- the tools picked

// A press on the pen slid down the tools to Text, then let go: Text in use within PICK_MS of the lift, with no hold
// before the slide; by the mouse everywhere, and by a finger on a touch screen. Then a plain tap on the
// pen picks it.
async function slides(page, size) {
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
  if (!size.touch) return;
  const { touch } = await hands(page);
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

// No long press on the tools: the eraser held well past a long press picks it and opens no card.
async function noHold(page) {
  const eraser = page.locator('#book [data-island=tools] [data-mode=eraser]'),
    cards = page.locator('#book .bk-palette');
  await eraser.click({ delay: 900 });
  await until(async () => (await eraser.getAttribute('aria-pressed')) === 'true', 'the eraser picked by a held press');
  assert.equal(await cards.count(), 0, 'a held tool opens no card');
}
