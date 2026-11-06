// book-check.mjs's story of the pages' titles (shell/ink/bookcontrols.js, booktitle.js, bookviewhead.js): a title
// written where it shows on the view, opened by Rename page in the dots menu, on a desktop, a phone and an iPad mini,
// saved by Enter and by a tap away, Escape sending nothing, a refused save said under the field, which stays, tried
// again by each tap away and let go by a tap on its note, an empty title Untitled page, and one from another screen,
// each read on the view (whole on the desktop) and in the count's label, with nothing written on a blank page; a save
// still out when its page turns or the overview opens, refused later on its own page and never on the view.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../../shared/browser/browser.mjs';
import { press } from './bar.mjs';
import { button, namedNotebook } from './chrome.mjs';
import { DESKTOP, MINI, OVERVIEW, nothingMoving } from './kit.mjs';

// the page's title on the view, and where it is on the bar (its label names the page)
const nameIn = page => page.locator('#book .bk-view-head .bk-page-title'),
  countIn = page => page.locator('#book .bk-bar .bk-where'),
  titleField = page => page.getByRole('textbox', { name: 'Page title' });

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport, more), settled(page, mode), shot }
export function titleStories(c) {
  return {
    'page titles: renamed from the dots menu where they show on desktop, phone and iPad mini, read on the view':
      browser => titles(browser, c),
    "a call page's longest title whole on the view on an iPad mini, upright and on its side": browser =>
      callTitle(browser, c),
  };
}

// A call page's longest title: the call's widest date and time, then a topic of the most characters it takes
// (ink/callnotes.ts TOPIC_MOST), whole in the page's head on an iPad mini: upright, the book as the spread, and on its
// side, the book open beside HQ's page at its own width
const LONGEST_CALL = '28 Sept, 22:55, iPad mini walkthrough';
async function callTitle(browser, c) {
  for (const [screen, viewport, mode] of [
    ['upright', { width: 744, height: 1133 }, 'spread'],
    ['side-on', MINI, 'open'],
  ]) {
    const context = await c.hqIn(browser, viewport, {
      notebooks: namedNotebook(),
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage(),
      errors = errorsOf(page);
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${c.base}/?intro=0&renderer=wire`);
      await until(page, '#loading.gone');
      // (on its side the book opens beside HQ's page by itself)
      if ((await page.evaluate(() => document.documentElement.dataset.book)) !== mode)
        await page.locator('#book .bk-lip').click();
      await c.settled(page, mode);
      context.notebook.route('/api/notebooks/pages/title', {}, { id: 2, title: LONGEST_CALL });
      await namedBar(page, LONGEST_CALL);
      await c.shot(`call-title-ipad-mini-${screen}`, page);
      await whole(nameIn(page), `a call page's longest title in the page's head on an iPad mini, ${screen}`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

async function titles(browser, c) {
  for (const [screen, viewport] of [
    ['desktop', DESKTOP],
    ['phone', { width: 360, height: 780 }],
    ['ipad-mini', { width: 744, height: 1133 }],
  ]) {
    const touch = screen !== 'desktop';
    const context = await c.hqIn(browser, viewport, {
      notebooks: namedNotebook(),
      hasTouch: touch,
      deviceScaleFactor: 1,
    });
    const page = await context.newPage(),
      errors = errorsOf(page),
      // (an upright iPad opens the book as the spread, as a phone does)
      mode = touch ? 'spread' : 'open';
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${c.base}/?intro=0&renderer=wire`);
      await until(page, '#loading.gone');
      if (touch) await page.locator('#book .bk-lip').click();
      await c.settled(page, mode);
      await editTitle(page, c, { screen, touch, mode, viewport });
      context.notebook.route('/api/notebooks/pages/title', {}, { id: 2, title: 'Plans from another screen' });
      await namedBar(page, 'Plans from another screen');
      await blankCanvas(page, 'Plans from another screen');
      // (the page's head shows its title, whole on the desktop; a phone's narrow page, where a long one trails off.)
      if (screen === 'desktop') await whole(nameIn(page), "the title in the page's head on the desktop");
      await c.shot(`page-title-${screen}`, page);
      await pageGoes(page, c, { touch, mode });
      assert.deepEqual(errors, []);
    } catch (error) {
      await c.shot(`page-title-${screen}-failure`, page);
      throw error;
    } finally {
      await context.close();
    }
  }
}

// s: { screen, touch, mode, viewport }
async function editTitle(page, c, s) {
  const sent = [];
  page.on('request', r => r.url().includes('/api/notebooks/pages/title') && sent.push(r.postDataJSON()));
  await inPlace(page, c, s);
  await savedOrKept(page, c, s, sent);
  await refused(page, c, s);
  await emptied(page, s);
}
// The title opens where it shows, and Enter saves it
async function inPlace(page, c, { screen, touch }) {
  const field = titleField(page);
  // The title opens where it shows, on the view, with no form or Save button; the bar's count stays.
  await open(page, touch);
  assert.ok(await field.evaluate(el => !!el.closest('.bk-view-head')), 'the title written where it shows');
  assert.match(await countIn(page).innerText(), /^\d+ \/ \d+$/, 'the count on the bar while it is written');
  assert.equal(await page.getByRole('button', { name: /Save/ }).count(), 0, 'no Save button');
  // Enter saves
  await write(field, 'Garden layout', touch);
  await whole(field, `the title being written on the ${screen}`);
  await c.shot(`page-title-${screen}-editing`, page);
  await saveWithoutEcho(page, () => field.press('Enter'), 'Garden layout');
  assert.ok(!(await field.isVisible()), 'the name back after Enter');
}
// Escape keeps the title and a tap away saves it; the title opened and left sends nothing
async function savedOrKept(page, c, { touch, mode, viewport }, sent) {
  const name = nameIn(page),
    field = titleField(page);
  // Escape keeps the title, and sends nothing: the title route marks a title as the board's
  await open(page, touch);
  assert.equal(await field.inputValue(), 'Garden layout');
  await write(field, 'Cancelled title', touch);
  const before = sent.length;
  await field.press('Escape');
  await namedBar(page, 'Garden layout');
  assert.equal(sent.length, before, 'Escape sends no title');
  // A tap away saves
  await open(page, touch);
  await write(field, 'Planting plan', touch);
  await tapAway(page, touch, viewport);
  await namedBar(page, 'Planting plan');
  assert.deepEqual(sent.at(-1), { id: 2, title: 'Planting plan' });
  // Opening the title and leaving it sends nothing
  await open(page, touch);
  await page.keyboard.press('Escape');
  assert.equal(sent.length, before + 1, 'an unchanged title sends nothing');
  await press(page, OVERVIEW);
  await tileIn(page, 'Planting plan').click();
  await c.settled(page, mode);
  assert.equal(await name.innerText(), 'Planting plan');
}
// A refused save, tried again and let go
async function refused(page, c, { screen, touch, viewport }) {
  const field = titleField(page),
    error = page.locator('#book .bk-title [role="status"]');
  let sent = 0;
  // A refused save says so under the title, which keeps what was written, the field left open
  await page.route('**/api/notebooks/pages/title', r => {
    sent += 1;
    return r.fulfill({ status: 409, json: { error: 'That title could not be saved.' } });
  });
  await open(page, touch);
  await write(field, 'Refused title', touch);
  await refusedBy(page, () => field.press('Enter'));
  assert.equal(await error.locator('span').first().innerText(), 'That title could not be saved.');
  assert.equal(await field.inputValue(), 'Refused title');
  assert.ok(await error.isVisible(), 'the refusal shown');
  await c.shot(`page-title-${screen}-refused`, page);
  // A tap away tries again, refused too, and so does the next, once each
  for (const n of [2, 3]) {
    await refusedBy(page, () => tapAway(page, touch, viewport));
    assert.equal(sent, n, 'each tap away sends the title once');
    assert.ok(await error.isVisible(), 'still saying so');
    assert.ok(await field.isVisible(), 'the field still open');
  }
  // A tap on the note lets it go, by touch as by a mouse
  if (touch) await error.tap();
  else await error.click();
  await namedBar(page, 'Planting plan');
  assert.equal(await field.count(), 0);
  assert.equal(sent, 3, 'letting it go sends nothing');
  // Escape lets it go too once refused, the focus taken on by Tab from the field (which tries again, as a tap away does)
  if (!touch) {
    await open(page, touch);
    await write(field, 'Refused title', touch);
    await refusedBy(page, () => field.press('Enter'));
    await refusedBy(page, () => field.press('Tab'));
    assert.equal(sent, 5, 'the focus moved on by Tab tries again');
    await page.keyboard.press('Escape');
    await namedBar(page, 'Planting plan');
    assert.equal(await field.count(), 0, 'Escape lets it go');
    assert.equal(sent, 5, 'Escape sends nothing');
  }
  await page.unroute('**/api/notebooks/pages/title');
}
// An empty title leaves the page Untitled page
async function emptied(page, { touch }) {
  const field = titleField(page);
  await open(page, touch);
  await write(field, '', touch);
  await field.press('Enter');
  await namedBar(page, 'Untitled page');
  await blankCanvas(page, 'Untitled page');
}
// A title's save still out when its page goes, by a turn or the overview: the field goes with it at once, nothing is
// written to the page shown after, and the refusal that comes later is said on its own page, never in the bar
async function pageGoes(page, c, { touch, mode }) {
  const field = titleField(page),
    title = 'Plans from another screen';
  for (const [leave, back] of [
    ['The page before', () => button(page, 'The page after').click()],
    [OVERVIEW, () => tileIn(page, title).click()],
  ]) {
    let refuse;
    const held = new Promise(resolve => (refuse = resolve)),
      sent = [],
      words = `Refused after ${leave === 'The page before' ? 'the turn' : 'the overview'}.`;
    await page.route('**/api/notebooks/pages/title', async r => {
      sent.push(r.request().postDataJSON());
      await held;
      await r.fulfill({ status: 409, json: { error: words } });
    });
    await open(page, touch);
    await write(field, 'Meant for page two', touch);
    await field.press('Enter');
    await until(page, '#book .bk-title input[readonly]');
    await press(page, leave);
    assert.equal(await field.count(), 0, 'the title goes with its page');
    if (leave === 'The page before') await namedBar(page, 'Cover ideas');
    // (the page landed first, and a frame drawn since: a key hidden as the overview opens loses the focus only at the
    // engine's next rendering update. Where the focus is then is the board's.)
    await nothingMoving(page);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => (window.__focused = document.activeElement));
    const answered = page.waitForResponse('**/api/notebooks/pages/title');
    refuse();
    await answered;
    await page.locator('#book .bk-refusal', { hasText: words }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#book .bk-title').count(), 0, 'no field or note back on the view');
    const focus = await page.evaluate(() => {
      const named = el => (el ? `${el.tagName.toLowerCase()}.${el.className}` : 'none');
      return document.activeElement === window.__focused
        ? null
        : `${named(window.__focused)} → ${named(document.activeElement)}`;
    });
    assert.equal(focus, null, `the focus left where it was, after ${leave}`);
    assert.deepEqual(sent, [{ id: 2, title: 'Meant for page two' }]);
    await page.unroute('**/api/notebooks/pages/title');
    await back();
    await c.settled(page, mode);
    await namedBar(page, title);
  }
}
// A tap on the paper above the bar
async function tapAway(page, touch, viewport) {
  const r = await page.locator('#book .bk-island[data-island="pages"]').boundingBox(),
    x = r.x + r.width / 2,
    y = viewport.height * 0.35;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}
// The title's save, refused: answered, and the field written in again
async function refusedBy(page, save) {
  const answered = page.waitForResponse('**/api/notebooks/pages/title');
  await save();
  await answered;
  await until(page, '#book .bk-title input[aria-invalid="true"]:not([readonly])');
}
// Rename page from the dots menu: the title has the focus, all of it chosen
async function open(page, touch) {
  const dots = page.locator('#book .bk-more'),
    rename = page.locator('#book .bk-more-card').getByRole('menuitem', { name: 'Rename page', exact: true });
  await (touch ? dots.tap() : dots.click());
  await (touch ? rename.tap() : rename.click());
  const field = titleField(page);
  await field.waitFor();
  assert.ok(await field.evaluate(el => el === document.activeElement && el.selectionEnd === el.value.length));
}
async function write(field, text, touch) {
  if (touch) await field.tap();
  await field.fill(text);
}
async function whole(el, what) {
  assert.ok(
    await el.evaluate(el => el.scrollWidth <= el.clientWidth),
    `${what}, whole: ${await el.evaluate(el => `${el.clientWidth} of ${el.scrollWidth} px`)}`,
  );
}
// A successful save must name the page for sight and speech before the event's group read returns.
async function saveWithoutEcho(page, save, title) {
  let release;
  const echo = new Promise(resolve => (release = resolve));
  const groups = '**/api/notebooks/pages/groups?*';
  const held = async route => {
    const url = new URL(route.request().url());
    await echo;
    await route.fulfill({ json: page.context().notebook.route(url.pathname, url.searchParams) });
  };
  await page.route(groups, held);
  try {
    await save();
    await namedBar(page, title);
    await blankCanvas(page, title);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
}
// A page's tile in the overview, by its title
const tileIn = (page, title) =>
  page.getByRole('list', { name: 'The overview' }).getByRole('button', { name: title, exact: true });
// This fixture's open page is blank: named title, no words on it at all, the title on the view
async function blankCanvas(page, title) {
  const canvas = page.locator('#book .bk-page:not([hidden])');
  assert.ok(await canvas.isVisible());
  assert.equal(await canvas.getAttribute('aria-label'), title);
  assert.equal((await canvas.textContent()).trim(), '', 'nothing written on the blank canvas');
}

// The page named title: on the view, no field over it, and in the label of its count on the bar
const namedBar = (page, title) =>
  page.waitForFunction(
    title =>
      !document.querySelector('#book .bk-view-head .bk-title') &&
      document.querySelector('#book .bk-view-head .bk-page-title')?.innerText === title &&
      document.querySelector('#book .bk-bar .bk-where').getAttribute('aria-label').includes(title),
    title,
    { timeout: 10_000, polling: 100 },
  );
