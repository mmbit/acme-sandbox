// book-check.mjs's story of the rail at the paper's right edge (shell/ink/bookui.js, bookstrip.js, bookcontrols.js):
// on a phone and an iPad mini both ways and a desktop with the notebook wide and narrow, every control the page has on
// one vertical column at the paper's right edge, nothing scrolling and nothing floating over the page; the tools
// first, the pen one tool (the marker beside it only where the rail has room), each 40 px wide or more; the page's
// scroll area ending left of the rail, so no control sits over what's written; the cog's and the pen's cards whole on
// the screen beside it. Press and slide: a press on Select slid down to Text picks Text the moment it lifts, with no
// hold (the mouse, and in Chromium a finger). Run with --webkit for the same in the iPad's engine.
// (the rail at the right edge)
import assert from 'node:assert/strict';
import { freePage } from './bookmouse.mjs';
import { touchOf, until } from './bookkit.mjs';

const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'phone-sideways', viewport: { width: 844, height: 390 }, touch: true },
  { name: 'mini-upright', viewport: { width: 744, height: 1133 }, touch: true },
  { name: 'mini-sideways', viewport: { width: 1133, height: 744 }, touch: true },
  { name: 'desktop-wide', viewport: { width: 1920, height: 1080 }, touch: false },
  { name: 'desktop-narrow', viewport: { width: 1920, height: 1080 }, touch: false, narrow: 420 },
];
// the rail's tools, top to bottom (the ink not in use, Marker, only where the rail is roomy)
const TOOLS = ['Select', 'Pen', 'Eraser', /^Shapes/, 'Text', 'Undo', 'Redo'];
// a slide's lift picks its tool this soon (ms)
const PICK_MS = 100;

// c: book-check.mjs's played store and helpers
export function barStories(c) {
  return {
    "the rail: every control on one column at the paper's right edge at every size, no scrolling, clear of the page, one pen; press and slide picks with no hold":
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
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#book .bk-lip', { timeout: 30_000 });
    await opened(page);
    if (size.narrow) await narrowed(page, size.narrow);
    await fitted(page);
    await c.shot(`book-rail-${size.name}`, page);
    await fits(page);
    await cards(page, c, size);
    await slides(page, size, browser);
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
// The book at rest and its rail fitted to it (data-fit, a frame after it resizes; on a loaded machine, frames come
// late), nothing in the column past its foot
const fitted = page =>
  until(
    () =>
      page.evaluate(() => {
        const column = document.querySelector('#book .bk-column');
        return (
          !document.querySelector('#book.bk-swinging') &&
          !!column?.dataset.fit &&
          column.scrollHeight <= column.clientHeight + 1
        );
      }),
    'the book at rest, its rail fitted',
  );

// A control on the rail pressed: on the rail, or from More's card where the rail has folded it away (also
// bookbookmarks.mjs's)
export async function press(page, name) {
  const own = page.locator('#book .bk-column').getByRole('button', { name, exact: true });
  if (await own.isVisible()) return own.click();
  await page.locator('#book .bk-column').getByRole('button', { name: 'More', exact: true }).click();
  await page.locator('#book .bk-more-card').getByRole('menuitem', { name, exact: true }).click();
}

// The cog's preferences and the pen's card (the pen in use pressed again) open beside the rail, whole on the screen
async function cards(page, c, size) {
  for (const [name, selector] of [
    ['Preferences on this device', '.bk-prefs'],
    ['Pen', '.bk-palette'],
  ]) {
    await press(page, name);
    const card = page.locator(`#book ${selector}`);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    await c.shot(`book-rail-${size.name}-${selector.slice(4)}`, page);
    const [b, rail] = [await card.boundingBox(), await page.locator('#book .bk-column').boundingBox()],
      view = page.viewportSize();
    assert.ok(
      b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height,
      `${name}'s card on the screen: ${JSON.stringify(b)}`,
    );
    assert.ok(b.x + b.width <= rail.x + 1, `${name}'s card beside the rail, left of it`);
    const mine = await card.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    assert.ok(mine, `${name}'s card on top, nothing over it`);
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });
  }
}

// Where the rail and the page are, and what's on the rail (the screen's px)
const measured = page =>
  page.evaluate(() => {
    const box = el => el && el.getBoundingClientRect().toJSON(),
      column = document.querySelector('#book .bk-column');
    return {
      fit: column.dataset.fit,
      paper: box(document.querySelector('#book .bk-paper')),
      desk: box(document.querySelector('#book .bk-pages .bk-desk')),
      column: box(column),
      scrolls: column.scrollHeight > column.clientHeight + 1 || column.scrollWidth > column.clientWidth + 1,
      buttons: [...column.querySelectorAll('.bk-btn')]
        .filter(b => b.getBoundingClientRect().width)
        .map(b => ({ name: b.getAttribute('aria-label'), ...box(b) })),
      // (the overview's own tools are in its head)
      floating: [...document.querySelectorAll('#book .bk-island')]
        .filter(el => el.getBoundingClientRect().width && !el.closest('.bk-column, .bk-far-head'))
        .map(el => el.dataset.island),
    };
  });

// Every control on the column, one above the other, whole on the screen and 40 px wide or more; the column at the
// paper's right edge, scrolling nothing; the tools first in their order, the pen one tool; the page's scroll area
// ending left of it; no control anywhere else over the page
async function fits(page) {
  const m = await measured(page),
    view = page.viewportSize(),
    names = m.buttons.map(b => b.name),
    mid = r => (r.left + r.right) / 2;
  assert.ok(!m.scrolls, `the rail scrolls nothing (${m.fit})`);
  assert.ok(
    Math.abs(m.column.right - Math.min(m.paper.right, view.width)) < 1.5,
    `the rail at the paper's right edge: ${m.column.right} ${m.paper.right}`,
  );
  for (const b of m.buttons) {
    assert.ok(Math.abs(mid(b) - mid(m.column)) < 2, `${b.name} on the rail's one column: ${mid(b)} ${mid(m.column)}`);
    assert.ok(b.width >= 40 && b.height >= 36, `${b.name} big enough to tap: ${b.width}x${b.height}`);
    assert.ok(b.top >= 0 && b.bottom <= view.height && b.right <= view.width, `${b.name} on the screen`);
  }
  m.buttons.slice(1).forEach((b, i) => assert.ok(b.top >= m.buttons[i].bottom - 1, `${b.name} under the one above`));
  const tools = names.filter(n => n !== 'Marker' && TOOLS.some(t => t.test?.(n) ?? t === n));
  assert.equal(tools.length, TOOLS.length, `the rail's tools: ${names.join(', ')}`);
  tools.forEach((n, i) => assert.ok(TOOLS[i].test?.(n) ?? TOOLS[i] === n, `the rail's tools: ${names.join(', ')}`));
  assert.ok(
    m.fit === 'roomy' || !names.includes('Marker'),
    `one pen: the marker shows only where it's roomy (${m.fit})`,
  );
  assert.ok(m.desk.right <= m.column.left + 1, `the page ends left of the rail: ${m.desk.right} ${m.column.left}`);
  assert.deepEqual(m.floating, [], 'no island of controls floats over the page');
}

// A press on Select slid down the rail to Text, then let go: Text in use within PICK_MS of the lift, with no hold
// before the slide; by the mouse everywhere, and by a finger in Chromium on a touch screen. Then a plain tap on the
// pen picks it.
async function slides(page, size, browser) {
  const rail = page.locator('#book [data-island=tools]'),
    at = async name => {
      const b = await rail.getByRole('button', { name, exact: true }).boundingBox();
      return [b.x + b.width / 2, b.y + b.height / 2];
    },
    pressed = () => rail.locator('[aria-pressed=true]').getAttribute('aria-label');
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
  const [select, text] = [await at('Select'), await at('Text')];
  await watch();
  await page.mouse.move(...select);
  await page.mouse.down();
  await page.mouse.move(...text, { steps: 8 });
  await page.mouse.up();
  await picked('the mouse');
  // a tap picks at once
  await rail.getByRole('button', { name: 'Pen', exact: true }).click();
  await until(async () => (await pressed()) === 'Pen', 'the pen picked by a tap', 2000);
  if (!size.touch || browser.browserType().name() !== 'chromium') return;
  const touch = touchOf(await page.context().newCDPSession(page));
  await watch();
  await touch.down([select]);
  // (drifting a little left of the rail as it goes: the tool level with the finger)
  await touch.move([[text[0] - 30, text[1]]], 8);
  await until(
    async () => ((await page.locator('#bk-tip').textContent()) ?? '').startsWith('Text'),
    "Text's name shown under the finger",
    2000,
  );
  await touch.up();
  await picked('a finger');
}
