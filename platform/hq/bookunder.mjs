// book-check.mjs's story of what the Notebook uncovers as it's lifted off HQ's page (shell/ink/book.js's table,
// bookswing.js): one flat colour beside the page, the screen's whole height, the left side's own (HQ's ground, or an
// artifact's page's in HQ's viewer as its review mode tells it, else HQ's dark backdrop), and the page dissolving into
// that same colour; the book's one shadow on it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { seen, tabAt } from './bookopen.mjs';
import { pixelsIn } from './bookkit.mjs';

const MINI = { width: 1133, height: 744 };

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode), settle }
export function underStories(c) {
  return {
    "the Notebook lifted off: the strip under it is the left side's own colour, HQ's or an artifact's, the screen's whole height, the book's one shadow on it":
      browser => liftedOff(browser, c),
  };
}

// Lifted off by its tab over HQ's page, then over an artifact in HQ's viewer: what it uncovers beside the page is one
// flat colour from the screen's top to its bottom, the left side's own (HQ's ground; the artifact's page's, as its
// review mode tells HQ, else HQ's dark backdrop), and the page dissolving fades into that same colour
async function liftedOff(browser, c) {
  const { page, errors, done } = await c.hq(browser, MINI);
  try {
    const hq = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await stripUnder(page, c, hq, 'swing-lifted-hq');
    await artifactServed(page);
    await page.evaluate(url => import('/shell/desk.js').then(desk => desk.openLink(url)), `${ARTIFACT}/`);
    // (review mode's hello tells HQ the page's colour, Linux WebKit's frame often later than the book's lift; where none
    // comes in time, HQ's dark backdrop, the viewer's own: only Chromium must hear it)
    const told = await page
      .waitForFunction(() => document.getElementById('viewer').dataset.ground, null, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (page.context().browser().browserType().name() === 'chromium') assert.ok(told, "the artifact's colour told");
    const backdrop = await page.evaluate(() => getComputedStyle(document.getElementById('viewer')).backgroundColor);
    await stripUnder(page, c, told ? 'rgb(47, 111, 79)' : backdrop, 'swing-lifted-artifact');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
// The open book pulled up by its tab and held: the strip it uncovers (between HQ's page and the book's outer edge, the
// screen's whole height) is the colour given, and so is what HQ's page fades into; then let down
async function stripUnder(page, c, colour, name) {
  const tab = await tabAt(page);
  await page.mouse.move(tab.x, tab.y);
  await page.mouse.down();
  await page.mouse.move(tab.x + 280, tab.y, { steps: 6 });
  // (lifted off the page: the tab well clear of it)
  await page.waitForFunction(
    () =>
      document.querySelector('#book .bk-lip').getBoundingClientRect().left >
      document.body.getBoundingClientRect().right + 60,
    null,
    { timeout: 60_000 },
  );
  const held = await seen(page),
    clip = { x: held.page + 6, y: 0, width: Math.min(40, held.tabLeft - held.page - 12), height: MINI.height };
  await c.shot(name, page);
  assert.ok(clip.width > 8, `the strip uncovered: HQ's page to ${held.page}, the tab at ${held.tabLeft}`);
  assert.deepEqual(await coloursIn(page, clip), [colour], `the strip under the lifted book: ${JSON.stringify(clip)}`);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    colour,
    'HQ fades into it',
  );
  assert.equal(held.shadow, 1, "the book's own shadow while it's lifted");
  // (lowered again before it's let go, so it lands open)
  await page.mouse.move(tab.x, tab.y, { steps: 6 });
  await page.waitForTimeout(500);
  await page.mouse.up();
  await c.settled(page, 'open');
}
// The colours in a box of the screen, as rgb() (within a step or two of each other, one)
async function coloursIn(page, clip) {
  const seen = [];
  for (const px of await pixelsIn(page, clip))
    if (!seen.some(s => s.every((v, k) => Math.abs(v - px[k]) <= 2))) seen.push(px);
  return seen.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
}
// An artifact with a coloured page, review mode running in it: HQ's viewer opens it
const ARTIFACT = 'https://lift.preview.test';
async function artifactServed(page) {
  const context = page.context(),
    base = new URL(page.url()).origin,
    reviewJs = await readFile(new URL('../../shared/review/review.js', import.meta.url), 'utf8');
  await context.route(/\/api\/preview\/link$/, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  await context.route(`${ARTIFACT}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, reviewJs.replace('{{HQ_ORIGIN}}', base))) return;
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Plums</title><body style="margin: 0; background: #2f6f4f; color: #fff">
        <h1 style="margin: 24px">Plum jam</h1><script src="/__review/review.js"></script>`,
    });
  });
}
