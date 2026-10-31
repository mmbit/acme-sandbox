// book-check.mjs's stories of an agent's ask about one thing on a page (hq ask --at --spot: shell/ink/bookaskspot.js,
// bookasks.js), on the played Notebook seeded as dev mode's (mock/notebook.json: Moss's ask on the Shop book's Asks
// page, its scrap the shop's hero with the headline ringed, mock/ask-spot-1.jpg):
//   - a desktop, a mouse: the scrap, its card and where it is ("shop page · section#hero > h1"); a click there opens
//     the shop's preview in HQ's viewer, where review mode scrolls to the headline and flashes it, the glow gone after
//     about a second; with reduced motion, a still outline instead.
//   - an iPad mini sideways, a finger: the same, tapped, the book that lay over the viewer (its Over) put away first.
// Each time nothing of HQ's page covers the headline (the book's sheets above the viewer's frame included).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { open } from './booknotebook.mjs';
import { DESKTOP, MINI, until } from './bookkit.mjs';

// the seed's Shop book, its Asks page and Moss's ask there
const SHOP_BOOK = 30,
  ASKS = 950,
  ASK = 950;
const SHOP = 'https://shop.preview.company.test',
  SPOT = { url: `${SHOP}/#hero`, el: { selector: 'section#hero > h1', text: 'Made to last' } };
const repo = path => new URL(`../../${path}`, import.meta.url);

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn, shots, reviewJs
export function notebookSpotStories(c) {
  return {
    "an ask's spot on a desktop: its scrap says where the thing is, a click opens the preview there, the thing flashed, a still outline with reduced motion":
      browser => onDesktop(browser, c),
    "an ask's spot on an iPad mini: tapped, the preview opens there, the thing flashed": browser => onMini(browser, c),
  };
}

async function onDesktop(browser, c) {
  const { page, errors, done } = await open(browser, c, DESKTOP, {});
  try {
    const spot = await atTheAsk(page, c);
    await c.shot('ask-spot-scrap-desktop', page);
    await spot.click();
    await flashed(page, c, 'glow', 'ask-spot-flash-desktop');
    // with reduced motion: the same spot, a still outline
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(a => import('/shell/ink/bookaskspot.js').then(m => m.openSpot(a)), SPOT);
    await flashed(page, c, 'still', 'ask-spot-still-desktop');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

async function onMini(browser, c) {
  const { page, errors, done } = await open(browser, c, MINI, { hasTouch: true });
  try {
    const spot = await atTheAsk(page, c);
    await c.shot('ask-spot-scrap-ipad-mini', page);
    await spot.tap();
    await flashed(page, c, 'glow', 'ask-spot-flash-ipad-mini');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// The book at the Shop book's Asks page: the ask's scrap, its card and where its thing is → the spot's button
async function atTheAsk(page, c) {
  await served(page, c);
  await page.evaluate(at => import('/shell/ink/book.js').then(m => m.openAt(at)), { notebook: SHOP_BOOK, page: ASKS });
  const slip = page.locator(`#book .ask-slip[data-ask="${ASK}"]`);
  await slip.waitFor({ timeout: 30_000 });
  await slip.scrollIntoViewIfNeeded();
  assert.match(await slip.innerText(), /Moss asks/);
  const spot = slip.locator('.ask-spot');
  assert.match(await spot.innerText(), /shop page · section#hero > h1/);
  return spot;
}

// The shop's page in HQ's viewer flashed at the headline (how: 'glow' or 'still'), then the flash gone
async function flashed(page, c, how, name) {
  const frame = await until(() => page.frames().find(f => f.url().startsWith(SHOP)), 'the shop open in the viewer');
  const glow = await until(
    () => frame.evaluate(() => document.querySelector('[data-flash]')?.dataset.flash).catch(() => null),
    'the headline flashed',
  );
  assert.equal(glow, how);
  await c.shot(name, page);
  const over = await frame.evaluate(() => {
    const g = document.querySelector('[data-flash]').getBoundingClientRect(),
      h = document.querySelector('#hero h1').getBoundingClientRect();
    return g.left <= h.left && g.right >= h.right && g.top <= h.top && g.bottom >= h.bottom && h.top >= 0;
  });
  assert.ok(over, 'the flash is round the headline, on the screen');
  await inTheOpen(page, frame);
  await until(
    () => frame.evaluate(() => !document.querySelector('[data-flash]')),
    'the flash gone after a moment',
    10_000,
  );
}

// The headline unobscured on HQ's page: at its middle and near both ends, HQ's topmost element is the viewer's frame
async function inTheOpen(page, frame) {
  const headline = await frame.locator('#hero h1').boundingBox(),
    iframe = await frame.frameElement();
  const covers = await page.evaluate(
    ({ box, el }) =>
      [0.1, 0.5, 0.9]
        .map(at => document.elementFromPoint(box.x + box.width * at, box.y + box.height / 2))
        .filter(top => top !== el)
        .map(top => top?.getAttribute('class') || top?.tagName || 'nothing'),
    { box: headline, el: iframe },
  );
  assert.deepEqual(covers, [], `the headline is clear of HQ's page, not under ${covers.join(', ')}`);
}

// The seeded scrap's picture, and the shop's preview with review mode in it, as HQ's viewer opens it
async function served(page, c) {
  const context = page.context(),
    picture = await readFile(new URL('./mock/ask-spot-1.jpg', import.meta.url)),
    shop = await readFile(new URL('./mock/ask-shop.html', import.meta.url)),
    font = await readFile(repo('kits/brand/fonts/bricolage-grotesque.woff2'));
  await context.route(/\/api\/notebooks\/pictures\?file=ask-spot-1\.jpg$/, r =>
    r.fulfill({ contentType: 'image/jpeg', body: picture }),
  );
  await context.route(/\/api\/preview\/link$/, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  await context.route(`${SHOP}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, c.reviewJs)) return;
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    if (path.startsWith('/fonts/')) return r.fulfill({ contentType: 'font/woff2', body: font });
    return r.fulfill({ contentType: 'text/html', body: shop });
  });
}
