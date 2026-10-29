// book-check.mjs's story of the pages' titles (shell/ink/bookcontrols.js, booktitle.js): a title written in place of
// the page's name in the bar on a desktop, a phone and an iPad mini, saved by Enter and by a tap away, Escape sending
// nothing, a refused save said over the field, tried again by each tap away and let go by a tap on its note, an empty
// title Untitled page, and one from another screen, each read in the bar (whole on the desktop), the only place a
// page's title shows, with no date on the canvas; a save still out when its page turns or the overview opens, refused
// later on its own page and never in the bar. Touch opens the pages with the shown page's row focused (no keyboard
// over them); a tap on the title writes.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../shared/browser/browser.mjs';
import { button, namedNotebook } from './bookchrome.mjs';
import { DESKTOP } from './bookkit.mjs';

const nameIn = page => page.locator('#book .bk-where'),
  titleField = page => page.getByRole('textbox', { name: 'Page title' });

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport, more), settled(page, mode), shot }
export function titleStories(c) {
  return {
    'page titles: written in place in the bar on desktop, phone and iPad mini, with no date on the canvas': browser =>
      titles(browser, c),
  };
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
      // (the bar the only place a page's title shows: there in words, whole on the desktop; a phone's and an upright
      // iPad mini's one slim row has only a narrow book's paper, where a long one trails off.)
      if (screen === 'desktop') await whole(nameIn(page).locator('span'), 'the title in the bar on the desktop');
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
}
// The title opens in the name's place, and Enter saves it
async function inPlace(page, c, { screen, touch }) {
  const name = nameIn(page),
    field = titleField(page);
  // The title opens in the name's place, in the bar's row, with no form or Save button; the pages above it.
  await open(page, touch);
  assert.ok(await field.evaluate(el => !!el.closest('[data-island="pages"]')), 'the title written in the bar');
  assert.ok(!(await name.isVisible()), 'its name gone while it is written');
  assert.equal(await page.getByRole('button', { name: /Save/ }).count(), 0, 'no Save button');
  // Enter saves
  await write(field, 'Garden layout', touch);
  await whole(field, `the title being written on the ${screen}`);
  await c.shot(`page-title-${screen}-editing`, page);
  await saveWithoutEcho(page, () => field.press('Enter'), 'Garden layout');
  assert.ok(!(await field.isVisible()), 'the name back after Enter');
}
// Escape keeps the title and a tap away saves it; the pages opened and left send nothing
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
  // Opening the pages and leaving them sends nothing
  await open(page, touch);
  await page.keyboard.press('Escape');
  assert.equal(sent.length, before + 1, 'an unchanged title sends nothing');
  await button(page, /^The overview/).click();
  await page.getByRole('button', { name: 'Planting plan', exact: true }).click();
  await c.settled(page, mode);
  assert.ok((await name.innerText()).includes('Planting plan'));
}
// A refused save, then an empty title
async function refused(page, c, { screen, touch, viewport }) {
  const field = titleField(page),
    error = page.locator('#book .bk-title [role="status"]');
  let sent = 0;
  // A refused save says so over the title, which keeps what was written
  await page.route('**/api/notebooks/pages/title', r => {
    sent += 1;
    return r.fulfill({ status: 400, json: { error: 'That title could not be saved.' } });
  });
  await open(page, touch);
  await write(field, 'Refused title', touch);
  await refusedBy(page, () => field.press('Enter'));
  assert.equal(await error.locator('span').first().innerText(), 'That title could not be saved.');
  assert.equal(await field.inputValue(), 'Refused title');
  assert.equal(await field.getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#book .bk-pages-menu').count(), 0, 'the pages put away, the title left saying so');
  await c.shot(`page-title-${screen}-refused`, page);
  // A tap away tries again, refused too, and so does the next, once each
  for (const n of [2, 3]) {
    await refusedBy(page, () => tapAway(page, touch, viewport));
    assert.equal(sent, n, 'each tap away sends the title once');
    assert.ok(await error.isVisible(), 'still saying so');
  }
  // A tap on the note lets it go, by touch as by a mouse
  if (touch) await error.tap();
  else await error.click();
  await namedBar(page, 'Planting plan');
  assert.equal(await field.count(), 0);
  assert.equal(sent, 3, 'letting it go sends nothing');
  // Escape lets it go too, once Tab has taken the focus on from the field (and saved, refused)
  if (!touch) {
    await open(page, touch);
    await write(field, 'Refused title', touch);
    await refusedBy(page, () => field.press('Tab'));
    assert.ok(!(await field.evaluate(el => el === document.activeElement)), 'the focus gone from the field');
    await page.keyboard.press('Escape');
    await namedBar(page, 'Planting plan');
    assert.equal(await field.count(), 0, 'Escape lets it go');
    assert.equal(sent, 4, 'Escape sends nothing');
  }
  await page.unroute('**/api/notebooks/pages/title');
  // An empty title leaves the page Untitled page
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
    [/^The overview/, () => page.getByRole('button', { name: title, exact: true }).click()],
  ]) {
    let refuse;
    const held = new Promise(resolve => (refuse = resolve)),
      sent = [],
      words = `Refused after ${leave === 'The page before' ? 'the turn' : 'the overview'}.`;
    await page.route('**/api/notebooks/pages/title', async r => {
      sent.push(r.request().postDataJSON());
      await held;
      await r.fulfill({ status: 400, json: { error: words } });
    });
    await open(page, touch);
    await write(field, 'Meant for page two', touch);
    await field.press('Enter');
    await until(page, '#book .bk-title input[readonly]');
    await button(page, leave).click();
    assert.equal(await field.count(), 0, 'the title goes with its page');
    assert.equal(await page.locator('#book .bk-where.bk-titling').count(), 0, 'the name shown');
    if (leave === 'The page before') await namedBar(page, 'Cover ideas');
    await page.evaluate(() => (window.__focused = document.activeElement));
    const answered = page.waitForResponse('**/api/notebooks/pages/title');
    refuse();
    await answered;
    await page.locator('#book .bk-refusal', { hasText: words }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('#book .bk-title').count(), 0, 'no title or note back in the bar');
    assert.ok(await page.evaluate(() => document.activeElement === window.__focused), 'the focus left where it was');
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
// The pages opened by the page's name: on a desktop the title has the focus, all of it chosen; on a touch screen the
// shown page's row has it
async function open(page, touch) {
  await nameIn(page).click();
  const field = titleField(page);
  await field.waitFor();
  if (touch) assert.ok(await page.evaluate(() => document.activeElement?.hasAttribute('aria-current')));
  else assert.ok(await field.evaluate(el => el === document.activeElement && el.selectionEnd === el.value.length));
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
// This fixture's open page is blank. Any visible canvas text, whatever its class, would cover the writing space.
async function blankCanvas(page, title) {
  const canvas = page.locator('#book .bk-page:not([hidden])');
  assert.ok(await canvas.isVisible());
  assert.equal(await canvas.getAttribute('aria-label'), title);
  assert.equal((await canvas.innerText()).trim(), '', 'no title or date on the blank canvas');
}

const namedBar = (page, title) =>
  page.waitForFunction(title => document.querySelector('#book .bk-where').innerText.includes(title), title, {
    timeout: 10_000,
    polling: 100,
  });
