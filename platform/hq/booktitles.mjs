// book-check.mjs's story of the pages' titles (shell/ink/bookcontrols.js, booktitle.js): a title typed in the bar's
// card on a desktop, a phone and an iPad mini, saved and cancelled, and one from another screen, each read whole in the
// bar, the only place a page's title shows, with no date on the canvas. Touch opens the card on the shown page's row.
import assert from 'node:assert/strict';
import { errorsOf, until } from '../../shared/browser/browser.mjs';
import { button, namedNotebook } from './bookchrome.mjs';

// c: book-check.mjs's helpers: { base, hqIn(browser, viewport, more), settled(page, mode), shot }
export function titleStories(c) {
  return {
    'page titles: edit in the bar on desktop, phone and iPad mini, whole there, with no date on the canvas': browser =>
      titles(browser, c),
  };
}

async function titles(browser, c) {
  for (const [screen, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
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
      errors = errorsOf(page);
    page.setDefaultTimeout(10_000);
    try {
      await page.goto(`${c.base}/?intro=0&renderer=wire`);
      await until(page, '#loading.gone');
      if (touch) await page.locator('#book .bk-lip').click();
      await c.settled(page, touch ? 'spread' : 'open');
      await editTitle(page, c, screen, touch);
      context.notebook.route('/api/notebooks/pages/title', {}, { id: 2, title: 'Plans from another screen' });
      await namedBar(page, 'Plans from another screen');
      await blankCanvas(page, 'Plans from another screen');
      // (the bar the only place a page's title shows: there in words, whole)
      const name = page.locator('#book .bk-where span');
      assert.ok(
        await name.evaluate(el => el.scrollWidth <= el.clientWidth),
        `the title whole in the bar on the ${screen}: ${await name.evaluate(el => `${el.clientWidth} of ${el.scrollWidth} px`)}`,
      );
      await c.shot(`page-title-${screen}`, page);
      assert.deepEqual(errors, []);
    } catch (error) {
      await c.shot(`page-title-${screen}-failure`, page);
      throw error;
    } finally {
      await context.close();
    }
  }
}

// touch: a coarse pointer, where the card opens on the shown page's row (no keyboard over the pages) and a tap types
async function editTitle(page, c, screen, touch) {
  const name = page.locator('#book .bk-where');
  await name.click();
  const field = page.getByRole('textbox', { name: 'Page title' });
  if (touch) {
    assert.ok(await page.evaluate(() => document.activeElement?.hasAttribute('aria-current')));
    await field.tap();
  } else assert.ok(await field.evaluate(el => el === document.activeElement));
  await field.fill('Garden layout');
  await c.shot(`page-title-${screen}-editing`, page);
  await saveWithoutEcho(page, 'Garden layout');
  await name.click();
  assert.equal(await field.inputValue(), 'Garden layout');
  await field.fill('Cancelled title');
  await field.press('Escape');
  assert.ok((await name.textContent()).includes('Garden layout'));
  await button(page, /^The overview/).click();
  await page.getByRole('button', { name: 'Garden layout', exact: true }).click();
  await c.settled(page, 'open');
  assert.ok((await name.innerText()).includes('Garden layout'));
  await name.click();
  await field.fill('');
  await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await namedBar(page, 'Untitled page');
  await blankCanvas(page, 'Untitled page');
}
// A successful save must name the page for sight and speech before the event's group read returns.
async function saveWithoutEcho(page, title) {
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
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
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
