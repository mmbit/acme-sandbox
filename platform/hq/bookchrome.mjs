// book-check.mjs's stories of the book's chrome on an iPad mini (shell/ink/bookui.js, bookcontrols.js, bookzoom.js,
// booksearch.js, bookhead.js, bookpages.js; Ink's folder): the column holds the
// faces, the tools, Undo and Redo and the book's own controls, and nothing else; nothing of the book sits under Safari's blurred strip at the
// top; the page arrows clear the column at any width; the overview opens from the foot, with Search in it and
// nothing to draw with, only its own button left in the foot, a page that went stamped and
// the Shelf a tap away, its Search saying what it searches there; and the pages keep one
// name each from the moment they show, a call's saying who it was with and when, with no blank page the board didn't
// make. Each asserts what the board sees: the buttons' names, boxes, the controls' words.
import assert from 'node:assert/strict';
import { errorsOf, openPage, until } from '../../shared/browser/browser.mjs';
import { DESKTOP, MINI } from './bookkit.mjs';
import { press } from './bookbar.mjs';

// a home-screen app's blurred strip at the top (style.css's standalone --sat: 48 px under the status bar)
const SAT_PX = 72;
// the tool rail at the foot, left to right: the tools, then Undo and Redo (bookstrip.js, the board's call 170)
const RAIL = ['Select', 'Pen', 'Marker', 'Eraser', /^Shapes/, 'Text', 'Undo', 'Redo'],
  // what the column over the paper's right edge may hold
  CONTROLS = ['Send', 'Tips', 'Invite'],
  OVERVIEW = "The overview: the notebook's pages, and the Shelf";

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function chromeStories(c) {
  return {
    "the book's column: only the tools and Undo and Redo; nothing under Safari's top strip; the foot clear of it at any width":
      browser => column(browser, c),
    "the overview from the foot: Search in it, no tools, the foot only its own button, pressed; the Shelf's Search naming your notebooks":
      browser => overview(browser, c),
    'the Shelf on a desktop: a notebook opens by zooming into its tile and back out to it; Archive moves one to the Archive':
      browser => shelfZoom(browser, c, DESKTOP),
    'the Shelf on a phone: a notebook opens by zooming into its tile and back out to it; Archive moves one to the Archive':
      browser => shelfZoom(browser, c, { width: 390, height: 844 }),
    'the Shelf with reduced motion: a notebook opens with a fade, no zoom; Archive moves one to the Archive': browser =>
      shelfZoom(browser, c, MINI, true),
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
    const names = await columnNames(page),
      rail = await page
        .locator('#book [data-island=tools] button')
        .evaluateAll(all => all.filter(b => b.getBoundingClientRect().width).map(b => b.getAttribute('aria-label')));
    assert.deepEqual(
      names.filter(name => !CONTROLS.includes(name)),
      [],
      `the column holds only the book's own controls: ${names.join(', ')}`,
    );
    assert.equal(rail.length, RAIL.length, `the rail: ${rail.join(', ')}`);
    rail.forEach((name, i) => assert.ok(RAIL[i].test?.(name) ?? RAIL[i] === name, `the rail: ${rail.join(', ')}`));
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

// (overview and names, in headless WebKit, fail with two or three page views at once (.bk-dogear, .bk-desk) once a turn
// has swung: the harness's known fault, a swing that stays upright and never finishes there, on main too; Chromium
// passes.)
async function overview(browser, c) {
  const { page, errors, done } = await onMini(browser, c);
  try {
    const foot = page.locator('#book nav [data-island=pages]'),
      over = foot.getByRole('button', { name: /^The overview/ });
    // (from More where the rail has folded it away: WebKit's iPad mini rail is tighter.)
    await press(page, OVERVIEW);
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
    // the Shelf: My journal first
    await far.getByRole('button', { name: /^The Shelf/ }).click();
    await page.waitForTimeout(c.settle);
    assert.match(await far.locator('.bk-book .bk-tile-open').first().getAttribute('aria-label'), /^My journal, /);
    await nothingToDraw(page, 'on the Shelf');
    await c.shot('chrome-shelf', page);
    await far.getByRole('searchbox', { name: 'Search your notebooks' }).fill('warmer');
    const find = far.locator('.bk-found button').first();
    await find.waitFor({ timeout: 3000 });
    await c.shot('chrome-search', page);
    await find.click();
    // (its notebook read first, another's: a moment more than a step. A wait that runs out isn't the failure: the
    // assertion under it is, and says what failed.)
    await far.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    assert.ok(!(await far.isVisible()), 'a find opens its page');
    assert.equal(await over.getAttribute('aria-pressed'), 'false');
    assert.ok(await foot.getByRole('button', { name: /^The notebook's pages/ }).isVisible(), "the page's name back");
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A notebook opens from the Shelf by zooming into its tile (the point that stays put as the view grows is inside it),
// and leaving it draws back out to that tile; never a leaf turned. With reduced motion it fades, nothing grows. Its
// Archive box moves a notebook into the Archive; the overview's button on the Shelf zooms back to the page too.
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
    const mine = far.locator('.bk-book[data-book="1"]'),
      outward = await shelfTransition(page, far.getByRole('button', { name: /^The Shelf/ }));
    await page.waitForTimeout(c.settle);
    const tile = await mine.boundingBox();
    await shelfArchive(page, far, c, label, viewport);
    const inward = await shelfTransition(page, far.getByRole('button', { name: /^My journal,/ }));
    zoomedRound(tile, { inward, outward, reduced });
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

// The book's own menu archives the notebook, which then appears in the Archive.
async function shelfArchive(page, far, c, label, viewport) {
  if (viewport.width >= 500) await far.locator('.bk-book[data-book="2"]').hover();
  await far.getByRole('button', { name: 'More: Call with Ansel', exact: true }).click();
  await c.shot(`shelf-${label}`, page);
  await far.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await page.waitForTimeout(c.settle);
  await far.getByRole('button', { name: /^Archive/ }).click();
  await page.waitForTimeout(c.settle);
  assert.ok(await far.getByRole('button', { name: /^Call with Ansel,/ }).isVisible());
  await far.getByRole('button', { name: 'My shelf', exact: true }).click();
  await page.waitForTimeout(c.settle);
}

// The step to or from the Shelf as the board sees it: whether a leaf turns, and where the view zooms round (the point
// on the screen the outgoing view's picture grows or shrinks about, read from its box halfway through its animation,
// seeked there: a loaded machine's WebKit may draw no frame between its first and its end; null if it never grows or
// shrinks)
async function shelfTransition(page, control) {
  await page.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
  await page.evaluate(() => {
    const seen = (window.__shelfStep = { leaf: false, still: null, began: false, over: false });
    const watch = () => {
      const picture = document.querySelector('#book .bk-turn-picture'),
        leaf = document.querySelector('#book .bk-turn-leaf');
      seen.leaf ||= !!leaf;
      if (picture || leaf) seen.began = true;
      else if (seen.began) return void (seen.over = true);
      const going = picture?.getAnimations()[0];
      if (going && !seen.still) {
        const now = going.currentTime;
        going.currentTime = going.effect.getTiming().duration / 2;
        const p = picture.parentElement.getBoundingClientRect(),
          r = picture.getBoundingClientRect(),
          k = r.width / p.width;
        going.currentTime = now;
        if (Math.abs(1 - k) > 0.01)
          seen.still = { x: (r.left - k * p.left) / (1 - k), y: (r.top - k * p.top) / (1 - k) };
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await control.click();
  await page.waitForFunction(() => window.__shelfStep.over, null, { timeout: 30_000 });
  return page.evaluate(() => {
    const { leaf, still } = window.__shelfStep;
    return { leaf, still };
  });
}
// Into the notebook's tile and back out to it, never a leaf; with reduced motion nothing grows or shrinks
function zoomedRound(tile, { inward, outward, reduced }) {
  assert.equal(inward.leaf, false, 'opening a notebook never turns a leaf on the Shelf');
  assert.equal(outward.leaf, false, 'closing to the Shelf uses a zoom');
  if (reduced) return assert.deepEqual([inward.still, outward.still], [null, null], 'reduced motion only fades');
  for (const [way, { still }] of Object.entries({ into: inward, 'back out to': outward }))
    assert.ok(
      still && inside(still, tile),
      `the view zooms ${way} the notebook's tile ${JSON.stringify(tile)}: round ${JSON.stringify(still)}`,
    );
}
const inside = (pt, box) => pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height;

// (My journal: a page sent yesterday with its title, and today's untitled one)
export function namedNotebook() {
  const day = 86_400_000,
    at = ms => new Date(ms).toISOString();
  return {
    notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: at(Date.now() - day), updated: at(Date.now()) }],
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

// (in headless WebKit: the never-finishing swing, as overview's note says)
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
    // (New page and the overview from More where the rail has folded them away.)
    await press(page, 'New page');
    await button(page, "The notebook's pages: Untitled page, 3 of 3", true).waitFor({ state: 'attached' });
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
    await press(page, OVERVIEW);
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
  await page.waitForSelector('#book .bk-unit', { state: 'attached', timeout: 30_000 });
  await c.settled(page, 'open');
  return { page, errors, done: () => context.close() };
}
export const button = (page, name, exact = false) => page.locator('#book').getByRole('button', { name, exact });
// The names of the book's own buttons on the rail (Send, Tips, invites) that show
// The overview or the Shelf: no tools, Undo, Redo or dog-ear, with nothing to draw on
async function nothingToDraw(page, where) {
  assert.ok(!(await page.locator('#book [data-island=tools]').isVisible()), `no tools, Undo or Redo ${where}`);
  assert.ok(!(await page.locator('#book .bk-dogear').isVisible()), `no dog-ear ${where}`);
}
const columnNames = page =>
  page
    .locator('#book .bk-column :is([data-island=send], [data-island=book]) button')
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
  for (const { r: foot } of boxes.filter(b => b.across))
    for (const { r } of boxes.filter(b => !b.across)) {
      const apart = foot.right <= r.left || r.right <= foot.left || foot.bottom <= r.top || r.bottom <= foot.top;
      assert.ok(apart, `${when}: the foot ${JSON.stringify(foot)} over the column's ${JSON.stringify(r)}`);
    }
}
