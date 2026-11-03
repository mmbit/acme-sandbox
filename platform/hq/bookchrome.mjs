// book-check.mjs's stories of the book's chrome on an iPad mini (shell/ink/bookui.js, bookcontrols.js, bookzoom.js,
// booksearch.js, bookhead.js, bookpages.js; Ink's folder): the two islands hold the tools, the page's keys and the
// dots, and nothing else, the dots menu the book's own rows; nothing of the book sits under Safari's blurred strip at
// the top; the islands clear of each other at any width; the overview opens from the bar, with Search in it and
// nothing to draw with, only its own key left on the bar, a page that went stamped, and its Search opening a find
// (the Shelf has its own window: bookshelfwindow.mjs); and the pages keep one name each from the moment they show, a
// call's saying who it was with and when, with no blank page the board didn't make. Each asserts what the board sees:
// the buttons' names, boxes, the controls' words. (the islands)
import assert from 'node:assert/strict';
import { errorsOf, openPage, until } from '../../shared/browser/browser.mjs';
import { MINI, OVERVIEW, PREFERENCES } from './bookkit.mjs';
import { press } from './bookbar.mjs';

// a home-screen app's blurred strip at the top (style.css's standalone --sat: 48 px under the status bar)
const SAT_PX = 72;
// what each island may hold, in its order: the tools top to bottom (the pen and the marker one tool, the mic where the
// device records: bookpalette.js, bookvoice.js); the bar left to right (the overview and New page only where the paper
// is wide: bookbar.mjs); and the dots menu's rows, the book's own
const TOOLS = [/^(Pen|Marker)$/, /^Shapes/, 'Eraser', 'Select', 'Text', 'Voice note'],
  BAR = ['Undo', 'Redo', 'The page before', /^The notebook's pages/, 'The page after', OVERVIEW, 'New page', 'More'],
  ROWS = ['Tear off and send', PREFERENCES, 'Tips', 'Close notebook'];

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function chromeStories(c) {
  return {
    "the book's islands: only the tools, the page's keys and the dots, the book's own rows in the dots; nothing under Safari's top strip; the islands clear of each other at any width":
      browser => islandsOnly(browser, c),
    'the overview from the bar: Search in it, no tools, the bar only its own key, pressed; a find opens its page':
      browser => overview(browser, c),
    "the pages' names stay put: a titled page's, an untitled one's from its first moment, written on or not": browser =>
      names(browser, c),
  };
}

// The book put away: its pull tab tapped
export async function shutBook(page) {
  await page.locator('#book .bk-lip').click();
}
// A chapter's bookmark tapped (tap([x, y]): the mouse's click unless given), at the part of it that shows: where the
// page is the whole screen (upright) they lie folded at its left edge, and the first tap brings them out, the second
// picks the chapter (bookmarks.js)
export async function toChapter(page, chapter, tap = ([x, y]) => page.mouse.click(x, y)) {
  const tab = page.locator(`#book .bk-marks [data-chapter="${chapter}"]`),
    shows = async () => {
      const b = await tab.boundingBox();
      return [(Math.max(b.x, 0) + b.x + b.width) / 2, b.y + b.height / 2];
    };
  await tap(await shows());
  const out = () => page.evaluate(() => document.querySelector('#book .bk-marks').hasAttribute('data-out'));
  if (!(await out())) return;
  // (out over the margin: their slide over)
  await page.waitForTimeout(400);
  await tap(await shows());
}

// ---- the stories

async function islandsOnly(browser, c) {
  const { page, errors, done } = await onMini(browser, c);
  try {
    await holdsOnly(page, 'at its open width');
    assert.deepEqual(await menuRows(page), ROWS, "the dots menu: the book's own rows");
    await clearOfTheStrip(page, 'open');
    await c.shot('chrome-islands', page);
    await islandsApart(page, 'at its open width');
    // the cover's edge dragged right to the book's narrowest
    const edge = await page.locator('#book [role=separator]').boundingBox();
    await page.mouse.move(edge.x + 3, 450);
    await page.mouse.down();
    await page.mouse.move(MINI.width - 345, 450, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await c.settled(page, 'open');
    await holdsOnly(page, 'at its narrowest');
    await islandsApart(page, 'at its narrowest');
    await clearOfTheStrip(page, 'at its narrowest');
    await c.shot('chrome-narrow', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// (overview and names, in headless WebKit, fail with two or three page views at once (.bk-desk) once a turn
// has swung: the harness's known fault, a swing that stays upright and never finishes there, on main too; Chromium
// passes.)
async function overview(browser, c) {
  const { page, errors, done } = await onMini(browser, c);
  try {
    const bar = page.locator('#book .bk-bar'),
      over = bar.getByRole('button', { name: OVERVIEW, exact: true, includeHidden: true });
    await press(page, OVERVIEW);
    await page.waitForTimeout(c.settle);
    const far = page.getByRole('list', { name: 'The overview' });
    assert.ok(await far.isVisible(), 'the overview opened');
    assert.equal(await over.getAttribute('aria-pressed'), 'true');
    await barOnly(bar, [OVERVIEW]);
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
    await far.getByRole('searchbox', { name: 'Search the book' }).fill('warmer');
    const find = far.locator('.bk-found button').first();
    await find.waitFor({ timeout: 3000 });
    await c.shot('chrome-search', page);
    await find.click();
    // (its notebook read first, another's: a moment more than a step. A wait that runs out isn't the failure: the
    // assertion under it is, and says what failed.)
    await far.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    assert.ok(!(await far.isVisible()), 'a find opens its page');
    assert.equal(await over.getAttribute('aria-pressed'), 'false');
    assert.ok(await bar.getByRole('button', { name: /^The notebook's pages/ }).isVisible(), "the page's count back");
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

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
    // (New page and the overview from the dots menu where the bar has folded them away.)
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
// The overview's bar: only its own key (names), wherever its page showed it
async function barOnly(bar, names) {
  const shown = await shownNames(bar.locator('.bk-btn'));
  assert.deepEqual(shown, names, `the bar shows only the overview's key: ${shown}`);
}
// The overview or the Shelf: no tools, no Undo or Redo, and no dots with Tear off and send, with nothing to draw on
async function nothingToDraw(page, where) {
  const shown = await shownNames(page.locator('#book .bk-controls .bk-btn'));
  for (const name of ['Pen', 'Undo', 'Redo', 'More'])
    assert.ok(!shown.includes(name), `no ${name} ${where}: ${shown.join(', ')}`);
}
// Each island holds only its own controls, in their order (a key may be folded away: the bar's rare ones)
async function holdsOnly(page, when) {
  for (const [island, allowed] of [
    ['.bk-strip', TOOLS],
    ['.bk-bar', BAR],
  ]) {
    const names = await shownNames(page.locator(`#book ${island} .bk-btn`));
    let at = 0;
    for (const name of names) {
      while (at < allowed.length && !(allowed[at].test?.(name) ?? allowed[at] === name)) at++;
      assert.ok(at++ < allowed.length, `${when}: ${island} holds only its own, in order: ${names.join(', ')}`);
    }
  }
}
// The dots menu's rows, opened and put away again
async function menuRows(page) {
  const menu = page.locator('#book .bk-more-card');
  await page.locator('#book .bk-more').click();
  const rows = await menu.getByRole('menuitem').evaluateAll(all => all.map(b => b.textContent));
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  return rows;
}
// The labels of the buttons found that show (a hidden one keeps its slot unseen).
const shownNames = buttons =>
  buttons.evaluateAll(all =>
    all.filter(b => b.checkVisibility({ visibilityProperty: true })).map(b => b.getAttribute('aria-label')),
  );
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
// The bar clear of the tools' island
async function islandsApart(page, when) {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('#book nav [role=toolbar]')]
      .map(el => ({
        across: el.getAttribute('aria-orientation') === 'horizontal',
        r: el.getBoundingClientRect().toJSON(),
      }))
      .filter(({ r }) => r.width),
  );
  for (const { r: bar } of boxes.filter(b => b.across))
    for (const { r } of boxes.filter(b => !b.across)) {
      const apart = bar.right <= r.left || r.right <= bar.left || bar.bottom <= r.top || r.bottom <= bar.top;
      assert.ok(apart, `${when}: the bar ${JSON.stringify(bar)} over the tools' ${JSON.stringify(r)}`);
    }
}
