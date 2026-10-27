// book-check.mjs's stories of the book's chrome on an iPad mini (shell/bookui.js, bookcontrols.js, bookzoom.js,
// booksearch.js, bookhead.js, bookpages.js): the column holds the faces, the tools and Undo and Redo, and nothing else;
// nothing of the book sits under Safari's blurred strip at the top; the page arrows clear the column at any width; the
// overview opens from the foot, with Search and the phone in it, only its own button left in the foot and a page that
// went ticked; and the pages keep one name each from the moment they show, a call's saying who it was with and when,
// with no blank page the board didn't make. Each asserts what the board sees: the buttons' names, boxes, the controls'
// words.
import assert from 'node:assert/strict';
import { errorsOf, openPage, until } from '../../shared/browser/browser.mjs';

const MINI = { width: 1133, height: 744 };
// a home-screen app's blurred strip at the top (style.css's standalone --sat: 48 px under the status bar)
const SAT_PX = 72;
// what the column may hold: the faces ("For Juno", an invited person's book), then the tools, then Undo and Redo
const FACES = /^For |’s book$/,
  TOOLS = ['Select', 'Pen', 'Highlighter', 'Eraser', /^Shapes/, 'Type', 'Move the page', 'Colour and width'];

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport), settled(page, mode), shot, settle }
export function chromeStories(c) {
  return {
    "the book's column: only the faces, the tools and Undo and Redo; nothing under Safari's top strip; the foot clear of it at any width":
      browser => column(browser, c),
    'the overview from the foot: Search and the phone in it, the foot only its own button, pressed': browser =>
      overview(browser, c),
    "the pages' names stay put: a call's who and when, a free page's from its first moment, no blank page beside them":
      browser => names(browser, c),
  };
}

// The book put away: its spine dragged to the screen's edge, its paper too narrow to stay open (no button for it)
export async function foldBySpine(page) {
  const spine = await page.locator('#book [role=separator]').boundingBox(),
    x = spine.x + spine.width / 2,
    y = (page.viewportSize().height * 2) / 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(page.viewportSize().width - 10, y, { steps: 3 });
  await page.mouse.up();
}

// ---- the stories

async function column(browser, c) {
  const { page, errors, done } = await onMini(browser, c);
  try {
    const names = await columnNames(page);
    const allowed = name =>
      FACES.test(name) || ['Undo', 'Redo'].includes(name) || TOOLS.some(t => (t.test ? t.test(name) : t === name));
    assert.deepEqual(
      names.filter(name => !allowed(name)),
      [],
      `the column holds only faces, tools, Undo and Redo: ${names.join(', ')}`,
    );
    assert.ok(names.includes('Select') && names.includes('Undo') && names.includes('Redo'), names.join(', '));
    await clearOfTheStrip(page, 'open');
    await c.shot('chrome-column', page);
    await footClear(page, 'at its open width');
    // the spine dragged right to the book's narrowest that stays open, held a moment so it's no flick
    const spine = await page.locator('#book [role=separator]').boundingBox();
    await page.mouse.move(spine.x + 3, 450);
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
    // Search and the phone in its head; the thumbnails plain paper
    const field = far.getByRole('searchbox', { name: 'Search the book' });
    assert.ok(await field.isVisible(), 'Search in the overview');
    assert.ok(await far.getByRole('button', { name: 'Draw from your phone' }).isVisible(), 'the phone in the overview');
    const dots = await far
      .locator('.bk-frame canvas')
      .evaluateAll(all => all.map(el => getComputedStyle(el).backgroundImage));
    assert.ok(dots.length && dots.every(d => d === 'none'), `the thumbnails' paper: ${dots}`);
    await clearOfTheStrip(page, 'in the overview');
    await c.shot('chrome-overview', page);
    // the week: Moss's sheet, sent yesterday, ticked
    await far.getByRole('button', { name: 'The week' }).click();
    await page.waitForTimeout(c.settle);
    const week = await far.locator('.bk-frame').evaluateAll(all => all.map(f => f.getAttribute('aria-label')));
    assert.ok(week.includes('For Moss, sent'), `a page that went is ticked: ${week}`);
    assert.equal(await far.locator('.bk-frame-went').count(), week.filter(w => w.endsWith(', sent')).length);
    await c.shot('chrome-week', page);
    await field.fill('tear');
    const find = far.locator('.bk-found button').first();
    await find.waitFor({ timeout: 3000 });
    await c.shot('chrome-search', page);
    await find.click();
    await page.waitForTimeout(c.settle);
    assert.ok(!(await far.isVisible()), 'a find opens its page');
    assert.equal(await over.getAttribute('aria-pressed'), 'false');
    assert.ok(await foot.getByRole('button', { name: /^The day's pages/ }).isVisible(), "the page's name back");
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function names(browser, c) {
  const context = await c.hqIn(browser, MINI),
    { before } = await callDays(context);
  const page = await context.newPage(),
    errors = errorsOf(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await until(page, '#loading.gone');
    await c.settled(page, 'open');
    const where = () => button(page, /^The day's pages/).getAttribute('aria-label');
    assert.equal(
      await where(),
      "The day's pages: Call with Juno, 00:34",
      'the call’s page alone, no blank one counted',
    );
    await c.shot('chrome-call-name', page);
    await button(page, 'New page', true).click();
    await page.waitForTimeout(c.settle);
    assert.equal(await where(), "The day's pages: Free page, 2 of 2");
    // written on, it keeps its name
    const desk = await page.locator('#book .bk-desk').boundingBox();
    await page.mouse.move(desk.x + 120, desk.y + 200);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(desk.x + 120 + i * 12, desk.y + 200 + 8 * Math.sin(i));
    await page.mouse.up();
    await page.waitForTimeout(c.settle);
    assert.equal(await where(), "The day's pages: Free page, 2 of 2");
    // the overview names them the same, and another day's call with its day
    await button(page, /^The overview/).click();
    await page.waitForTimeout(c.settle);
    const frames = () =>
      page
        .getByRole('list', { name: 'The overview' })
        .locator('.bk-frame')
        .evaluateAll(all => all.map(f => f.getAttribute('aria-label')));
    assert.deepEqual(await frames(), ['Call with Juno, 00:34', 'Free page']);
    await page.locator('#book [data-day-go]').first().click();
    await page.waitForTimeout(c.settle);
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(before));
    assert.deepEqual(await frames(), [`Call with Wren, ${weekday} 10:05, sent`]);
    await c.shot('chrome-names-overview', page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// The store's book played for a context: today with only a call's page (Juno's, at 00:34), and two days ago another's
// (Wren's, at 10:05, sent). HQ's mock clock is UTC. { today, before }
async function callDays(context) {
  const today = new Date().toISOString().slice(0, 10),
    before = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const call = (id, day, agent, started) => ({
    ...{ id, day, kind: 'call', owner: null, url: null, call: id, label: '', w: 900, h: 700 },
    ...{ agent, started, strokes: 0, pictures: 0 },
  });
  const days = {
    [today]: [call(901, today, 'juno', `${today}T00:34:00Z`)],
    [before]: [{ ...call(902, before, 'wren', `${before}T10:05:00Z`), went: true }],
  };
  await context.route(/\/api\/book(\?.*)?$/, r => {
    const day = new URL(r.request().url()).searchParams.get('day') || today;
    return r.fulfill({
      json: { day, today, days: Object.keys(days).map(d => ({ day: d, pages: 1 })), pages: days[day] ?? [] },
    });
  });
  await context.route(/\/api\/book\/page\?id=90\d/, r => {
    const id = +new URL(r.request().url()).searchParams.get('id');
    const page = Object.values(days)
      .flat()
      .find(p => p.id === id);
    return r.fulfill({ json: { ...page, ink: [], scraps: [], texts: [] } });
  });
  return { today, before };
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
  await page.waitForSelector('#book [aria-label^="For "]', { state: 'attached', timeout: 30_000 });
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
