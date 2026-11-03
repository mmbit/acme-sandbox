// book-check.mjs's story of a page's title looking editable where it shows (shell/ink/bookunitcards.js, booktitle.js,
// bookcontrols.js), on journal.mjs's My journal: on an iPad mini with touch, on its side and upright, and on a
// desktop, the book opens on the last call's page (20 / 20) with a pencil by the page's title in its head. The page
// count tapped opens the page list, its title field with a pencil by it, and tapped again closes it, for good. The title
// in the page's head tapped opens the list with the field to write in (the keyboard's, on a touch screen too); Enter
// saves it, read in the page's head and in the page count's label.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, UPRIGHT, until } from './kit.mjs';
import { CALLS, landed, onJournal } from './journal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function titleTapStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    "a page's title looks editable, and the page count tapped again closes its list, on an iPad mini on its side":
      browser => tapped(browser, c, MINI, 'mini', touch),
    "a page's title looks editable, and the page count tapped again closes its list, on an iPad mini upright":
      browser => tapped(browser, c, UPRIGHT, 'mini-upright', touch),
    "a page's title looks editable, and the page count tapped again closes its list, on a desktop": browser =>
      tapped(browser, c, DESKTOP, 'desktop', mouse),
  };
}

const tapped = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'titletap' }, (p, { press }) => walk(p, c, name, press));

async function walk(p, c, name, press) {
  const where = p.locator('#book .bk-where'),
    list = p.locator('#book .bk-pages-menu'),
    field = p.getByRole('textbox', { name: 'Page title' }),
    head = p.locator('#book .bk-page:not([hidden]) .bk-title-tap');
  await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
  assert.ok(await head.locator('svg').isVisible(), `${name}: a pencil by the title in the page's head`);
  // the page count tapped: the list, its title with a pencil; tapped again, closed, and still closed a moment on
  await press(where);
  await list.waitFor();
  assert.ok(await p.locator('#book .bk-title-pencil').isVisible(), `${name}: a pencil by the list's title`);
  await c.shot(`titletap-${name}-list`, p);
  await press(where);
  await until(async () => !(await list.count()), `${name}: the page count tapped again closes the list`);
  await p.waitForTimeout(600);
  assert.equal(await list.count(), 0, `${name}: the list stays closed`);
  assert.equal(await where.getAttribute('aria-expanded'), 'false');
  // the title in the page's head tapped: the list with the title to write in, saved by Enter
  await press(head);
  await list.waitFor();
  await until(() => field.evaluate(el => el === document.activeElement), `${name}: the title to write in`);
  await c.shot(`titletap-${name}-writing`, p);
  await field.fill('Fly sketch');
  await field.press('Enter');
  await until(async () => !(await list.count()), `${name}: Enter closes the list`);
  await landed(p, 'calls', 'Fly sketch', `${CALLS} / ${CALLS}`, `${name}: the title changed in the page's head`);
  assert.match(await where.getAttribute('aria-label'), /Fly sketch/, `${name}: and in the page count's label`);
}
