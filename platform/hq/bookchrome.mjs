// book-check.mjs's stories of the book's chrome on an iPad mini (shell/ink/bookui.js, bookcontrols.js, bookzoom.js,
// booksearch.js, bookhead.js, bookpages.js; Ink's folder): the column holds the
// faces, the tools, Undo and Redo and the book's own controls, and nothing else; nothing of the book sits under Safari's blurred strip at the
// top; the page arrows clear the column at any width; the overview opens from the foot, with Search in it, the phone
// with the book's controls and nothing to draw with, only its own button left in the foot, a page that went stamped and
// the Shelf a tap away, its Search saying what it searches there; and the pages keep one
// name each from the moment they show, a call's saying who it was with and when, with no blank page the board didn't
// make. Each asserts what the board sees: the buttons' names, boxes, the controls' words.
import assert from 'node:assert/strict';
import { errorsOf, openPage, until } from '../../shared/browser/browser.mjs';

const MINI = { width: 1133, height: 744 };
// a home-screen app's blurred strip at the top (style.css's standalone --sat: 48 px under the status bar)
const SAT_PX = 72;
// what the column may hold: the tools, then Undo and Redo with the book's own controls
// (no faces: the sheets went with pages sent whole.)
const TOOLS = ['Select', 'Pen', 'Highlighter', 'Eraser', /^Shapes/, 'Type', 'Move the page', 'Colour and width'],
  // (and the strip's zoom and cog, bookstrip.js, the pin among the book's controls, pinsummon.js, and Tips under it,
  // booktips.js)
  CONTROLS = ['Undo', 'Redo', 'Zoom out', 'Zoom in', 'Preferences on this device', 'Pin a note on HQ', 'Tips'];

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function chromeStories(c) {
  return {
    "the book's column: only the tools and Undo and Redo; nothing under Safari's top strip; the foot clear of it at any width":
      browser => column(browser, c),
    "the overview from the foot: Search in it, no tools, the foot only its own button, pressed; the Shelf's Search naming your notebooks":
      browser => overview(browser, c),
    'the shelf opens a notebook with a zoom on desktop': browser => shelfZoom(browser, c, { width: 1440, height: 900 }),
    'the shelf opens a notebook with a zoom on a phone': browser => shelfZoom(browser, c, { width: 390, height: 844 }),
    'the shelf opens a notebook with reduced motion': browser => shelfZoom(browser, c, MINI, true),
    "the pages' names stay put: a titled page's, an untitled one's from its first moment, written on or not": browser =>
      names(browser, c),
  };
}

// The book put away: its pull tab tapped
export async function shutBook(page) {
  await page.locator('#book .bk-lip').click();
}

// ---- the stories

async function column(browser, c) {
  const { page, errors, done } = await onMini(browser, c);
  try {
    const names = await columnNames(page);
    const allowed = name => CONTROLS.includes(name) || TOOLS.some(t => (t.test ? t.test(name) : t === name));
    assert.deepEqual(
      names.filter(name => !allowed(name)),
      [],
      `the column holds only tools and the book's controls: ${names.join(', ')}`,
    );
    assert.ok(names.includes('Select') && names.includes('Undo') && names.includes('Redo'), names.join(', '));
    await clearOfTheStrip(page, 'open');
    await c.shot('chrome-column', page);
    await footClear(page, 'at its open width');
    // the cover's edge dragged right to the book's narrowest
    const edge = await page.locator('#book [role=separator]').boundingBox();
    await page.mouse.move(edge.x + 3, 450);
    await page.mouse.down();
    await page.mouse.move(MINI.width - 345, 450, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await c.settled(page, 'open');
    await footClear(page, 'at its narrowest');
    await clearOfTheStrip(page, 'at its narrowest');
    await c.shot('chrome-narrow', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function overview(browser, c) {
  const { page, errors, done } = await onMini(browser, c);
  try {
    const foot = page.locator('#book nav [role=toolbar][aria-orientation=horizontal]'),
      over = foot.getByRole('button', { name: /^The overview/ });
    assert.equal(
      await foot.getByRole('button').first().getAttribute('aria-label'),
      await over.getAttribute('aria-label'),
      'the overview at the foot’s left end',
    );
    await over.click();
    await page.waitForTimeout(c.settle);
    const far = page.getByRole('list', { name: 'The overview' });
    assert.ok(await far.isVisible(), 'the overview opened');
    assert.equal(await over.getAttribute('aria-pressed'), 'true');
    const shown = await foot
      .getByRole('button')
      .evaluateAll(all => all.filter(b => b.getBoundingClientRect().width).map(b => b.getAttribute('aria-label')));
    assert.deepEqual(shown, [await over.getAttribute('aria-label')], `the foot shows only the overview: ${shown}`);
    // Search in its head, nothing to draw with
    assert.ok(await far.getByRole('searchbox', { name: 'Search the book' }).isVisible(), 'Search in the overview');
    await nothingToDraw(page, 'in the overview');
    await clearOfTheStrip(page, 'in the overview');
    await c.shot('chrome-overview', page);
    // the notebook's pages: Cover ideas, sent yesterday, stamped
    const pages = await far
      .locator('.bk-tile[data-id] .bk-tile-open')
      .evaluateAll(all => all.map(f => f.getAttribute('aria-label')));
    assert.ok(pages.includes('Cover ideas, sent'), `a page that went is stamped: ${pages}`);
    assert.equal(await far.locator('.bk-stamp').count(), pages.filter(w => w.endsWith(', sent')).length);
    // the Shelf: My Notebook first
    await far.getByRole('button', { name: /^The Shelf/ }).click();
    await page.waitForTimeout(c.settle);
    assert.match(await far.locator('.bk-book .bk-tile-open').first().getAttribute('aria-label'), /^My Notebook, /);
    await nothingToDraw(page, 'on the Shelf');
    await c.shot('chrome-shelf', page);
    await far.getByRole('searchbox', { name: 'Search your notebooks' }).fill('warmer');
    const find = far.locator('.bk-found button').first();
    await find.waitFor({ timeout: 3000 });
    await c.shot('chrome-search', page);
    await find.click();
    await page.waitForTimeout(c.settle);
    assert.ok(!(await far.isVisible()), 'a find opens its page');
    assert.equal(await over.getAttribute('aria-pressed'), 'false');
    assert.ok(await foot.getByRole('button', { name: /^The notebook's pages/ }).isVisible(), "the page's name back");
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A notebook opens from the Shelf by zoom, and its archive action still moves it into the Archive; the overview's
// button on the Shelf zooms back to the page too.
async function shelfZoom(browser, c, viewport, reduced = false) {
  const seed = namedNotebook();
  seed.notebooks.push({ id: 2, kind: 'call', name: 'Call with Ansel', created: new Date().toISOString() });
  const context = await c.hqIn(browser, viewport, {
    notebooks: seed,
    deviceScaleFactor: 1,
    hasTouch: viewport.width < 500,
    isMobile: viewport.width < 500,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  const page = await context.newPage(),
    label = reduced ? 'reduced' : viewport.width < 500 ? 'phone' : 'desktop';
  try {
    await page.goto(`${c.base}/?intro=0&renderer=wire`);
    await until(page, '#loading.gone');
    if (viewport.width < 500) await page.locator('#book .bk-lip').tap();
    await c.settled(page, viewport.width < 500 ? 'spread' : 'open');
    await page
      .locator('#book')
      .getByRole('button', { name: /^The overview/ })
      .click();
    await page.waitForTimeout(c.settle);
    const far = page.getByRole('list', { name: 'The overview' });
    const outward = await shelfTransition(page, far.getByRole('button', { name: /^The Shelf/ }));
    await page.waitForTimeout(c.settle);
    await shelfArchive(page, far, c, label, viewport);
    const inward = await shelfTransition(page, far.getByRole('button', { name: /^My Notebook,/ }));
    assert.equal(inward.leaf, false, 'opening a notebook never turns a leaf on the Shelf');
    assert.equal(outward.leaf, false, 'closing to the Shelf uses a zoom');
    assert.equal(inward.duration, outward.duration, 'opening and closing use the same duration');
    assert.equal(inward.easing, outward.easing, 'opening and closing use the same easing');
    if (reduced) assert.deepEqual(inward.scales, [], 'reduced motion only fades');
    else assert.deepEqual(inward.scales, [...outward.scales].reverse(), 'the same zoom scales in opposite directions');
    await page.waitForTimeout(c.settle);
    assert.ok(await far.locator('.bk-tile[data-id="1"]').isVisible(), 'the notebook opens to its pages');
    await c.shot(`shelf-open-${label}`, page);
    await shelfTransition(page, far.getByRole('button', { name: /^The Shelf/ }));
    await page.waitForTimeout(c.settle);
    const overview = page.locator('#book').getByRole('button', { name: /^The overview/ }),
      home = await shelfTransition(page, overview);
    assert.equal(home.leaf, false, "the overview's button on the Shelf zooms back to the page, no leaf");
    await page.waitForTimeout(c.settle);
    assert.ok(await far.isHidden(), 'back on the page');
  } finally {
    await context.close();
  }
}

// The tile's box archives the notebook, which then appears on the Archive tab.
async function shelfArchive(page, far, c, label, viewport) {
  const archive = far.getByRole('button', { name: 'Archive: Call with Ansel', exact: true });
  if (viewport.width >= 500) await far.locator('.bk-book[data-book="2"]').hover();
  await c.shot(`shelf-${label}`, page);
  await archive.click();
  await page.waitForTimeout(c.settle);
  await far.getByRole('tab', { name: /^Archive/ }).click();
  await page.waitForTimeout(c.settle);
  assert.ok(await far.getByRole('button', { name: /^Call with Ansel,/ }).isVisible());
  await far.getByRole('tab', { name: /^Shelf/ }).click();
  await page.waitForTimeout(c.settle);
}

// Read the transition while it is on screen, including a leaf if the Shelf incorrectly turns one.
async function shelfTransition(page, control) {
  await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
  const watched = page.waitForFunction(
    () => {
      const picture = document.querySelector('#book .bk-turn-picture'),
        animation = picture?.getAnimations()[0],
        leaf = document.querySelector('#book .bk-turn-leaf');
      if (!animation && !leaf) return false;
      const animations = document.querySelector('#book .bk-paper').getAnimations({ subtree: true });
      const scales = animations.flatMap(a =>
        a.effect.getKeyframes().flatMap(k => {
          const match = /^scale\(([^)]+)\)$/.exec(k.transform ?? '');
          return match ? [Number(match[1])] : [];
        }),
      );
      const timing = animation?.effect.getTiming();
      return { leaf: !!leaf, scales, duration: timing?.duration, easing: timing?.easing };
    },
    null,
    { timeout: 30_000 },
  );
  await control.click();
  const transition = await watched;
  return transition.jsonValue();
}

// (My Notebook: a page sent yesterday with its title, and today's untitled one)
export function namedNotebook() {
  const day = 86_400_000,
    at = ms => new Date(ms).toISOString();
  return {
    notebooks: [{ id: 1, kind: 'mine', name: 'My Notebook', created: at(Date.now() - day), updated: at(Date.now()) }],
    pages: [
      {
        id: 1,
        notebook: 1,
        pos: 0,
        label: 'Cover ideas',
        send_at: Date.now() - day / 2,
        created: at(Date.now() - day),
      },
      { id: 2, notebook: 1, pos: 1, created: at(Date.now() - 60_000) },
    ].map(p => ({ updated: p.created, w: 1200, h: 1600, ...p })),
  };
}

async function names(browser, c) {
  const context = await c.hqIn(browser, MINI, { notebooks: namedNotebook() });
  const page = await context.newPage(),
    errors = errorsOf(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await until(page, '#loading.gone');
    await c.settled(page, 'open');
    const where = () => button(page, /^The notebook's pages/).getAttribute('aria-label');
    assert.equal(await where(), "The notebook's pages: Untitled page, 2 of 2", 'the newest page, untitled');
    await c.shot('chrome-names', page);
    await button(page, 'New page', true).click();
    await page.waitForTimeout(c.settle);
    assert.equal(await where(), "The notebook's pages: Untitled page, 3 of 3");
    // written on, it keeps its name
    const desk = await page.locator('#book .bk-desk').boundingBox();
    await page.mouse.move(desk.x + 120, desk.y + 200);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(desk.x + 120 + i * 12, desk.y + 200 + 8 * Math.sin(i));
    await page.mouse.up();
    await page.waitForTimeout(c.settle);
    assert.equal(await where(), "The notebook's pages: Untitled page, 3 of 3");
    // the overview names them the same, the oldest first
    await button(page, /^The overview/).click();
    await page.waitForTimeout(c.settle);
    const tiles = await page
      .getByRole('list', { name: 'The overview' })
      .locator('.bk-tile[data-id] .bk-tile-open')
      .evaluateAll(all => all.map(f => f.getAttribute('aria-label')));
    assert.deepEqual(tiles, ['Cover ideas, sent', 'Untitled page', 'Untitled page']);
    await c.shot('chrome-names-overview', page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// ---- what the board sees

// HQ in dev mode held like an iPad mini in landscape, the book open, Safari's strip set as style.css says tests do
async function onMini(browser, c) {
  const { context, page, errors } = await openPage(browser, { viewport: MINI, hasTouch: true });
  await context.addInitScript(px => {
    const set = () => document.documentElement.style.setProperty('--sat', `${px}px`);
    document.addEventListener('DOMContentLoaded', set);
  }, SAT_PX);
  await page.goto(`${c.base}/?intro=0`);
  // (the newest page's groups drawn.)
  await page.waitForSelector('#book .bk-clip', { state: 'attached', timeout: 30_000 });
  await c.settled(page, 'open');
  return { page, errors, done: () => context.close() };
}
export const button = (page, name, exact = false) => page.locator('#book').getByRole('button', { name, exact });
// The names of the buttons in the column's islands that show
// The overview or the Shelf: the phone with the book's controls, and no tools, Undo, Redo or dog-ear, with nothing to
// draw on
async function nothingToDraw(page, where) {
  const names = await columnNames(page);
  assert.ok(names.includes('Draw from your phone'), `the phone with the controls ${where}: ${names}`);
  const inHead = page.locator('#book .bk-far-head').getByRole('button', { name: 'Draw from your phone' });
  assert.equal(await inHead.count(), 0, `no phone in Search ${where}`);
  assert.deepEqual(
    names.filter(name => TOOLS.some(t => (t.test ? t.test(name) : t === name)) || /^(Undo|Redo)$/.test(name)),
    [],
    `no tools, Undo or Redo ${where}`,
  );
  assert.ok(!(await page.locator('#book .bk-dogear').isVisible()), `no dog-ear ${where}`);
}
const columnNames = page =>
  page
    .locator('#book [role=toolbar][aria-orientation=vertical] button')
    .evaluateAll(all => all.filter(b => b.getBoundingClientRect().width).map(b => b.getAttribute('aria-label')));
// Every visible control, field and send stamp starts below the strip
async function clearOfTheStrip(page, when) {
  const under = await page.evaluate(() =>
    [...document.querySelectorAll('#book button, #book input, #book [role=toolbar], #book .bk-send-stamp')]
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width && r.height && r.bottom > 0 && getComputedStyle(el).visibility !== 'hidden';
      })
      .filter(el => el.getBoundingClientRect().top < parseFloat(getComputedStyle(el).getPropertyValue('--sat')))
      .map(el => el.getAttribute('aria-label') || el.className),
  );
  assert.deepEqual(under, [], `${when}: under Safari's strip (${SAT_PX} px)`);
}
// The foot's row clear of every island in the column
async function footClear(page, when) {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('#book nav [role=toolbar]')]
      .map(el => ({
        across: el.getAttribute('aria-orientation') === 'horizontal',
        r: el.getBoundingClientRect().toJSON(),
      }))
      .filter(({ r }) => r.width),
  );
  const foot = boxes.find(b => b.across).r;
  for (const { r } of boxes.filter(b => !b.across)) {
    const apart = foot.right <= r.left || r.right <= foot.left || foot.bottom <= r.top || r.bottom <= foot.top;
    assert.ok(apart, `${when}: the foot ${JSON.stringify(foot)} over the column's ${JSON.stringify(r)}`);
  }
}
