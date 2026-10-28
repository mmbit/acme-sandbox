// book-check.mjs's stories of the book's chrome on an iPad mini (shell/ink/bookui.js, bookcontrols.js, bookzoom.js,
// booksearch.js, bookhead.js, bookpages.js; Ink's folder): the column holds the
// faces, the tools and Undo and Redo, and nothing else; nothing of the book sits under Safari's blurred strip at the
// top; the page arrows clear the column at any width; the overview opens from the foot, with Search and the phone in
// it, only its own button left in the foot, a page that went stamped and the Shelf a tap away; and the pages keep one
// name each from the moment they show, a call's saying who it was with and when, with no blank page the board didn't
// make. Each asserts what the board sees: the buttons' names, boxes, the controls' words.
import assert from 'node:assert/strict';
import { errorsOf, openPage, until } from '../../shared/browser/browser.mjs';

const MINI = { width: 1133, height: 744 };
// a home-screen app's blurred strip at the top (style.css's standalone --sat: 48 px under the status bar)
const SAT_PX = 72;
// what the column may hold: the faces ("For Juno", an invited person's book), then the tools, then Undo and Redo
// (no faces: the sheets went with pages sent whole.)
const TOOLS = ['Select', 'Pen', 'Highlighter', 'Eraser', /^Shapes/, 'Type', 'Move the page', 'Colour and width'],
  // (and the strip's zoom and cog, bookstrip.js, and the pin among the book's controls, pinsummon.js.)
  CONTROLS = ['Undo', 'Redo', 'Zoom out', 'Zoom in', 'Preferences on this device', 'Pin a note on HQ'];

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function chromeStories(c) {
  return {
    "the book's column: only the tools and Undo and Redo; nothing under Safari's top strip; the foot clear of it at any width":
      browser => column(browser, c),
    'the overview from the foot: Search and the phone in it, the foot only its own button, pressed': browser =>
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
    // Search and the phone in its head
    const field = far.getByRole('searchbox', { name: 'Search the book' });
    assert.ok(await field.isVisible(), 'Search in the overview');
    assert.ok(await far.getByRole('button', { name: 'Draw from your phone' }).isVisible(), 'the phone in the overview');
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
    await c.shot('chrome-shelf', page);
    await field.fill('warmer');
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

// (My Notebook: a page sent yesterday with its title, and today's untitled one;
// a call's page is a call notebook's, #20753)
function namedNotebook() {
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
const button = (page, name, exact = false) => page.locator('#book').getByRole('button', { name, exact });
// The names of the buttons in the column's islands that show
const columnNames = page =>
  page
    .locator('#book [role=toolbar][aria-orientation=vertical] button')
    .evaluateAll(all => all.filter(b => b.getBoundingClientRect().width).map(b => b.getAttribute('aria-label')));
// Every control, field and heading of the book that shows starts below the strip
async function clearOfTheStrip(page, when) {
  const under = await page.evaluate(() =>
    [...document.querySelectorAll('#book button, #book input, #book [role=toolbar], #book .bk-title')]
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
