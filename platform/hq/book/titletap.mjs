// book-check.mjs's story of a page's title looking editable where it shows (shell/ink/bookunitcards.js, booktitle.js,
// bookcontrols.js), on journal.mjs's My journal: on an iPad mini with touch, on its side and upright, on a phone by
// finger (no pen ever, so a finger draws; a home-screen app's blur at the top), and on a desktop, the book opens on
// Calls 20 / 20 with a pencil by the page's title in its head. The page count tapped opens the page list, its title
// field with a pencil by it, and tapped again closes it, for good. The title in the page's head tapped opens the list
// with the field to write in (the keyboard's, on a touch screen too); on the phone, by one finger's tap by the pencil,
// where a fingertip aimed at it lands (a finger's 44 px round it, the pencil itself some 8 px across); Enter saves it,
// read in the page's head and in the page count's label. (the phone)
import assert from 'node:assert/strict';
import { DESKTOP, MINI, UPRIGHT, until } from './kit.mjs';
import { SIZES } from './bookmarks.mjs';
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
    "a page's title looks editable, and one tap on its pencil opens it to write in, on a phone": browser =>
      tapped(browser, c, PHONE, 'phone', { hasTouch: true, isMobile: true, pen: false }, { pencil: true, init: sat }),
    "a page's title looks editable, and the page count tapped again closes its list, on a desktop": browser =>
      tapped(browser, c, DESKTOP, 'desktop', mouse),
  };
}

// The board's iPhone, and its home-screen app's blurred strip at the top (style.css's standalone --sat), set as HQ loads
const { sat: SAT, width, height } = SIZES.phone;
export const PHONE = { width, height };
export const sat = `document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--sat', '${SAT}px'))`;

// pencil: the page's head tapped on its pencil, not its middle; init: bookjournal.mjs onJournal's
const tapped = (browser, c, viewport, name, options, { pencil = false, init } = {}) =>
  onJournal(browser, c, { viewport, name, options, story: 'titletap', init }, (p, { press }) =>
    walk(p, c, name, press, pencil),
  );

async function walk(p, c, name, press, pencil) {
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
  if (pencil) await p.touchscreen.tap(...(await reach(head.locator('svg'))));
  else await press(head);
  await list.waitFor({ timeout: 10_000 });
  await until(() => field.evaluate(el => el === document.activeElement), `${name}: the title to write in`);
  await c.shot(`titletap-${name}-writing`, p);
  await field.fill('Fly sketch');
  await field.press('Enter');
  await until(async () => !(await list.count()), `${name}: Enter closes the list`);
  await landed(p, 'calls', 'Fly sketch', `${CALLS} / ${CALLS}`, `${name}: the title changed in the page's head`);
  assert.match(await where.getAttribute('aria-label'), /Fly sketch/, `${name}: and in the page count's label`);
}

// Where a fingertip aimed at the pencil lands: a little right of it and below, within a finger's 44 px of its middle
// (past the title's own line and the pencil's edge, so it's the touch area round them that takes it)
async function reach(pencil) {
  const b = await pencil.boundingBox();
  return [b.x + b.width / 2 + 14, b.y + b.height / 2 + 16];
}
