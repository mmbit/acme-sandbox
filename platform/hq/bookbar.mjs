// book-check.mjs's stories of the tool rail and the page bar at the paper's foot (shell/ink/bookstrip.js, bookui.js,
// bookcontrols.js; the board, call 170): on a phone, an iPad mini upright and on its side, and a desktop with the
// notebook wide and narrow, every tool on one row that fits, nothing scrolling, each 40 px or more to the touch; the
// rail centred over the bar, the bar right at the paper's foot with the page's name whole; --bk-foot the lane's height,
// and the page's scroll area ending above it, so no tool sits over what's written. Press and slide: a press on Select
// slid to Text picks Text the moment it lifts, with no hold (the mouse, and in Chromium a finger); the pin and
// Tips in the lane as well, nothing floating over the page. Run with --webkit for the same in the iPad's engine.
import assert from 'node:assert/strict';
import { freePage } from './bookmouse.mjs';
import { until } from './bookkit.mjs';
import { touchOf } from './bookstrip.mjs';

const SIZES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'mini-upright', viewport: { width: 744, height: 1133 }, touch: true },
  { name: 'mini-sideways', viewport: { width: 1133, height: 744 }, touch: true },
  { name: 'desktop-wide', viewport: { width: 1920, height: 1080 }, touch: false },
  { name: 'desktop-narrow', viewport: { width: 1920, height: 1080 }, touch: false, narrow: 420 },
];
// the rail, left to right
const RAIL = ['Select', 'Pen', 'Marker', 'Eraser', /^Shapes/, 'Text', 'Undo', 'Redo'];
// a slide's lift picks its tool this soon (ms)
const PICK_MS = 100;

// c: book-check.mjs's played store and helpers
export function barStories(c) {
  return {
    'the tool rail and the page bar: one row that fits at every size, no scrolling, clear of the page, the name whole; press and slide picks with no hold':
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
    await settledFoot(page);
    await c.shot(`book-rail-${size.name}`, page);
    await fits(page);
    await clearOfThePage(page);
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
  // (the book comes to rest at its new width, and the lane fitted to it, a frame after)
  await until(
    () =>
      page.evaluate(() => {
        const lane = document.querySelector('#book .bk-lane'),
          foot = getComputedStyle(document.querySelector('#book')).getPropertyValue('--bk-foot');
        return !document.querySelector('#book.bk-swinging') && parseFloat(foot) === lane.offsetHeight;
      }),
    'the book at rest, narrowed',
  );
  await page.waitForTimeout(300);
}

// The lane fitted to the book at rest (a frame after it resizes; on a loaded machine, frames come late)
const settledFoot = page =>
  until(
    () =>
      page.evaluate(() => {
        const lane = document.querySelector('#book .bk-lane'),
          foot = getComputedStyle(document.querySelector('#book')).getPropertyValue('--bk-foot');
        return !document.querySelector('#book.bk-swinging') && parseFloat(foot) === lane.offsetHeight;
      }),
    'the lane fitted, --bk-foot its height',
  );

// The cog's preferences and the pen's card (the pen in use pressed again) open over the rail, whole on the screen
async function cards(page, c, size) {
  for (const [name, selector] of [
    ['Preferences on this device', '.bk-prefs'],
    ['Pen', '.bk-palette'],
  ]) {
    await page.locator('#book .bk-lane').getByRole('button', { name, exact: true }).click();
    const card = page.locator(`#book ${selector}`);
    await card.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    await c.shot(`book-rail-${size.name}-${selector.slice(4)}`, page);
    const [b, rail] = [await card.boundingBox(), await page.locator('#book [data-island=tools]').boundingBox()],
      view = page.viewportSize();
    assert.ok(
      b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width,
      `${name}'s card on the screen: ${JSON.stringify(b)}`,
    );
    assert.ok(b.y + b.height <= rail.y, `${name}'s card over the rail`);
    const mine = await card.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    assert.ok(mine, `${name}'s card on top, nothing over it`);
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached', timeout: 5000 });
  }
}

// Where the lane's parts are, and what's in them (the screen's px)
const measured = page =>
  page.evaluate(() => {
    const box = el => el && el.getBoundingClientRect().toJSON(),
      rail = document.querySelector('#book [data-island=tools]'),
      bar = document.querySelector('#book [data-island=pages]'),
      name = bar.querySelector('.bk-where');
    return {
      paper: box(document.querySelector('#book .bk-paper')),
      rail: box(rail),
      railScrolls: rail.scrollWidth > rail.clientWidth + 1 || rail.scrollHeight > rail.clientHeight + 1,
      tools: [...rail.querySelectorAll('.bk-btn')]
        .filter(b => b.getBoundingClientRect().width)
        .map(b => ({ name: b.getAttribute('aria-label'), ...box(b) })),
      bar: box(bar),
      buttons: [...bar.querySelectorAll('.bk-btn')].filter(b => b.getBoundingClientRect().width).map(box),
      name: name && {
        text: name.textContent,
        whole: [...name.children].every(el => el.scrollWidth <= el.clientWidth + 1),
      },
      lane: box(document.querySelector('#book .bk-lane')),
      // (the book's own controls, the pin and Tips, in the lane beside the rail or a line of their own)
      own: [...document.querySelectorAll('#book .bk-islands .bk-btn')]
        .filter(b => b.getBoundingClientRect().width)
        .map(b => ({ name: b.getAttribute('aria-label'), ...box(b) })),
      floating: [...document.querySelectorAll('#book .bk-island')]
        .filter(el => el.getBoundingClientRect().width && !el.closest('.bk-lane, .bk-far-head'))
        .map(el => el.dataset.island),
    };
  });

// Every tool on the rail in its order, whole on the screen and on the paper, 40 px or more each, nothing scrolling; the
// rail centred over the bar, the bar at the paper's foot, its name whole; the pin and Tips in the lane too (no Send: the dog-ear's), and
// no control anywhere else over the page
async function fits(page) {
  const m = await measured(page);
  const view = page.viewportSize(),
    names = m.tools.map(t => t.name);
  assert.equal(names.length, RAIL.length, `the rail's tools: ${names.join(', ')}`);
  names.forEach((n, i) => assert.ok(RAIL[i].test?.(n) ?? RAIL[i] === n, `the rail's tools: ${names.join(', ')}`));
  assert.ok(!m.railScrolls, 'the rail scrolls nothing');
  for (const t of m.tools) {
    assert.ok(t.width >= 40 && t.height >= 40, `${t.name} 40 px or more: ${t.width}x${t.height}`);
    assert.ok(t.left >= m.paper.left && t.right <= Math.min(m.paper.right, view.width), `${t.name} on the paper`);
    assert.ok(t.top >= 0 && t.bottom <= view.height, `${t.name} on the screen`);
  }
  assert.ok(m.rail.bottom <= m.bar.top, 'the rail over the bar');
  const mid = r => (r.left + r.right) / 2;
  // (centred, or nearly where the book's islands beside it need more than half the room left of it)
  assert.ok(Math.abs(mid(m.rail) - mid(m.paper)) < 12, `the rail centred on the paper: ${mid(m.rail)} ${mid(m.paper)}`);
  assert.ok(
    Math.abs(m.bar.bottom - m.paper.bottom) < 1.5,
    `the bar at the paper's foot: ${m.bar.bottom} ${m.paper.bottom}`,
  );
  assert.ok(m.bar.left >= m.paper.left && m.bar.right <= m.paper.right, 'the bar on the paper');
  assert.ok(m.name?.whole, `the page's name whole: ${JSON.stringify(m.name)}`);
  for (const b of m.buttons) assert.ok(b.height >= 36 && b.top >= m.bar.top, 'the bar one row of whole buttons');
  // (--bk-foot is the lane's height once the book's at rest: settledFoot)
  assert.ok(Math.abs(m.lane.bottom - m.paper.bottom) < 1.5, "the lane at the paper's foot");
  assert.ok(
    !m.own.some(b => b.name === 'Send'),
    `no Send key: the page goes by its dog-ear (${m.own.map(b => b.name)})`,
  );
  for (const b of m.own) {
    assert.ok(b.width >= 40 && b.height >= 40, `${b.name} 40 px or more: ${b.width}x${b.height}`);
    assert.ok(b.top >= m.lane.top && b.bottom <= m.bar.top, `${b.name} in the lane, over the bar`);
    assert.ok(b.left >= m.paper.left && b.right <= Math.min(m.paper.right, view.width), `${b.name} on the paper`);
  }
  assert.deepEqual(m.floating, [], 'no island of controls floats over the page');
}

// The page's scroll area (the element under the paper that scrolls) ends at or above the lane
async function clearOfThePage(page) {
  const { lane, scroll } = await page.evaluate(() => {
    const paper = document.querySelector('#book .bk-paper'),
      scroller = [...paper.querySelectorAll('*')].find(el => /auto|scroll/.test(getComputedStyle(el).overflowY));
    return {
      lane: document.querySelector('#book .bk-lane').getBoundingClientRect().toJSON(),
      scroll: scroller && { cls: scroller.className, ...scroller.getBoundingClientRect().toJSON() },
    };
  });
  assert.ok(scroll, "the page's scroll area found under the paper");
  assert.ok(
    scroll.bottom <= lane.top + 1,
    `the page's scroll area ends above the lane: ${JSON.stringify([scroll, lane])}`,
  );
}

// A press on Select slid along to Text, then let go: Text in use within PICK_MS of the lift, with no hold before the
// slide; by the mouse everywhere, and by a finger in Chromium on a touch screen. Then a plain tap on the pen picks it.
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
  // (drifting a little above the rail as it goes: the tool level with the finger)
  await touch.move([[text[0], text[1] - 30]], 8);
  await until(
    async () => ((await page.locator('#bk-tip').textContent()) ?? '').startsWith('Text'),
    "Text's name shown under the finger",
    2000,
  );
  await touch.up();
  await picked('a finger');
}
