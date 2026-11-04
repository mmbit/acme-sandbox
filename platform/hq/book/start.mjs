// Where book-check.mjs's stories start: a page of HQ watched for errors, HQ loaded, the book come to rest open, and the
// book open on a touch screen with a pen. c: book-check's { hqIn, base, settled }
import { MINI, heard } from './kit.mjs';
import { hands } from './hands.mjs';
import { shapeOf } from '../shell/ink/booklayout.js';

// A new page in context, its errors kept as they come
export async function watchedPage(context) {
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return { page, errors };
}

// The book spread w CSS px wide beside HQ's page in context at viewport, as the board last pulled it out (none: as it
// opens)
export async function bookWide(context, viewport, w) {
  if (w)
    await context.addInitScript(
      ([key, w]) => localStorage.setItem(key, JSON.stringify({ mode: 'open', book: w })),
      [`hq.book.${shapeOf(viewport.width, viewport.height)}`, w],
    );
}
// No microphone in context: on a loaded machine a line's first move can come after the hold, and a press held still
// with a microphone is a voice note (bookinput.js)
export const noMicrophone = context =>
  context.addInitScript(() => (navigator.mediaDevices.enumerateDevices = async () => []));

// HQ's page loaded in context, its errors kept; query: more of the address after ?intro=0
export async function hqLoaded(c, context, query = '') {
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0${query}`);
  await page.waitForSelector('#loading.gone');
  return { page, errors };
}

// The book come to rest open as HQ loads: in landscape at its desk, held upright folded and its lip opening it as the
// spread over HQ (the lip's own click, in the page)
export async function restsOpen(page, c, viewport) {
  if (viewport.width > viewport.height) {
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
  } else {
    await c.settled(page, 'folded');
    await page.evaluate(() => document.querySelector('#book .bk-lip').click());
    await c.settled(page, 'spread');
  }
}

// HQ loaded and the book come to rest as it lands: open beside HQ on a screen on its side, folded on one held upright.
// Whether it's on its side
export async function restsAsLoaded(page, c, viewport) {
  await page.goto(`${c.base}/?intro=0`);
  const sideways = viewport.width > viewport.height;
  await c.settled(page, sideways ? 'open' : 'folded');
  return sideways;
}

// The book open on a touch screen with a pen, the microphone's stand-in listening, in either engine; more: the
// context's own options
export async function bookOnTouch(browser, c, viewport = MINI, more = {}) {
  // (at 1x by default, so a screenshot's px are the screen's: colourIn)
  const context = await c.hqIn(browser, viewport, { hasTouch: true, deviceScaleFactor: 1, ...more });
  const { page, errors } = await watchedPage(context);
  await heard(page);
  await page.goto(`${c.base}/?intro=0`);
  await restsOpen(page, c, viewport);
  return { context, page, errors };
}

// The iPad mini as a touch screen with a pen in either engine (hands.mjs), the book open: upright (viewport UPRIGHT) it
// starts folded, and its lip opens it as the spread over HQ; more: the context's own options.
export async function mini(browser, c, { viewport = MINI, ...more } = {}) {
  const { context, page, errors } = await bookOnTouch(browser, c, viewport, more);
  return { page, ...(await hands(page)), errors, done: () => context.close() };
}
