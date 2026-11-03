// book-check.mjs's stories of the book's chrome on an iPad mini under Safari's blurred strip at the top
// (shell/ink/bookui.js, bookcontrols.js, bookzoom.js, booksearch.js, bookhead.js, bookpages.js; Ink's folder): the two
// islands of use at the book's open width and its narrowest (islands.mjs; what they hold: bar.mjs); the
// overview opens from the bar, with Search in it, nothing under the strip, a page that went stamped, and its Search
// opening a find (the Shelf has its own window: shelfwindow.mjs); and the pages keep one name each from the moment
// they show, a call's saying who it was with and when, with no blank page the board didn't make. Each asserts what the
// board sees: the buttons' names, the controls' words. (the islands' checks and the blur)
import assert from 'node:assert/strict';
import { errorsOf, openPage, until } from '../../../shared/browser/browser.mjs';
import { MINI, OVERVIEW } from './kit.mjs';
import { blurred, islandsSeen, islandsUsable } from './islands.mjs';
import { press } from './bar.mjs';

// a home-screen app's blurred strip at the top (style.css's standalone --sat: 48 px under the status bar)
const SAT_PX = 72;

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function chromeStories(c) {
  return {
    "the book's islands under Safari's top strip, at the book's open width and its narrowest: of use, clear of each other, nothing under the strip":
      browser => islandsOnly(browser, c),
    'the overview from the bar: Search in it, nothing under the strip; a find opens its page': browser =>
      overview(browser, c),
    "the pages' names stay put: a titled page's, an untitled one's from its first moment, written on or not": browser =>
      names(browser, c),
  };
}

// The book put away: its pull tab tapped
export async function shutBook(page) {
  await page.locator('#book .bk-lip').click();
}
// ---- the stories

async function islandsOnly(browser, c) {
  const { page, errors, done } = await onMini(browser, c);
  try {
    islandsUsable(await islandsSeen(page), 'at its open width');
    await c.shot('chrome-islands', page);
    // the cover's edge dragged right to the book's narrowest
    const edge = await page.locator('#book [role=separator]').boundingBox();
    await page.mouse.move(edge.x + 3, 450);
    await page.mouse.down();
    await page.mouse.move(MINI.width - 345, 450, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await c.settled(page, 'open');
    islandsUsable(await islandsSeen(page), 'at its narrowest');
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
    assert.ok(await far.getByRole('searchbox', { name: 'Search the book' }).isVisible(), 'Search in the overview');
    islandsUsable(await islandsSeen(page), 'in the overview');
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
  await blurred(context, { sat: SAT_PX });
  await page.goto(`${c.base}/?intro=0`);
  // (the newest page's groups drawn.)
  await page.waitForSelector('#book .bk-unit', { state: 'attached', timeout: 30_000 });
  await c.settled(page, 'open');
  return { page, errors, done: () => context.close() };
}
export const button = (page, name, exact = false) => page.locator('#book').getByRole('button', { name, exact });
