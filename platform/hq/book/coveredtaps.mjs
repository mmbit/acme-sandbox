// book-check.mjs's story of what floats over the book's spread on the iPad mini taking taps however late it came, not
// left inert with HQ's page the spread covers (bookcover.js coverPage). Upright, a call's floating layer gone
// (its last part away) as the book opens as the spread, then back with a part (the call made small, a hand raised):
// the part takes a tap. And a picture opened large (a modal dialog) as the book turns to the spread (the iPad turned
// upright): its close button takes the tap, and closes it. Run it in WebKit too (--webkit: the turn is Chromium's,
// whose window resizes).
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, until } from './kit.mjs';
import { restsAsLoaded, watchedPage } from './start.mjs';

// c: book-check.mjs's played store and helpers
export function coveredTapsStories(c) {
  return {
    'over the spread, what floats in later takes taps: a small call back after the book covered HQ, a picture opened large as the iPad turns upright':
      browser => coveredTaps(browser, c),
  };
}

async function coveredTaps(browser, c) {
  await floatsBackOver(browser, c);
  if (browser.browserType().name() === 'chromium') await turnsUnderAPicture(browser, c);
}

// The small call's layer shut as the spread covers HQ, then shown again with a part in it
async function floatsBackOver(browser, c) {
  const context = await c.hqIn(browser, UPRIGHT, { hasTouch: true, deviceScaleFactor: 1, pen: false });
  const { page, errors } = await watchedPage(context);
  try {
    await restsAsLoaded(page, c, UPRIGHT);
    // (a part shown and gone: the layer is there, shut)
    await page.evaluate(() =>
      import('/shell/floating.js').then(({ floating }) => {
        const part = floating().appendChild(document.createElement('div'));
        part.textContent = 'a card';
        part.remove();
      }),
    );
    await until(
      () => page.evaluate(() => !document.querySelector('#floating:popover-open')),
      'the layer shut with its parts gone',
    );
    await page.locator('#book .bk-lip').evaluate(lip => lip.click());
    await c.settled(page, 'spread');
    await page.evaluate(() =>
      import('/shell/floating.js').then(({ floating }) => {
        const part = floating().appendChild(document.createElement('button'));
        part.className = 'covered-taps-part';
        part.textContent = 'the small call';
        part.style.cssText = 'position:fixed;left:40px;bottom:120px;width:160px;height:64px';
        part.onclick = () => (part.dataset.tapped = '1');
      }),
    );
    await takesTap(page, '.covered-taps-part', 'the small call shown over the spread after it covered HQ');
    assert.equal(await page.locator('.covered-taps-part').getAttribute('data-tapped'), '1', 'the part took no tap');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// The book opened upright (the spread, remembered for upright), the iPad turned on its side (the book beside HQ), a
// picture opened large, and the iPad turned upright again: the book the spread once more, the picture's close button
// still takes the tap
async function turnsUnderAPicture(browser, c) {
  const context = await c.hqIn(browser, UPRIGHT, { hasTouch: true, deviceScaleFactor: 1, pen: false });
  const { page, errors } = await watchedPage(context);
  try {
    await restsAsLoaded(page, c, UPRIGHT);
    await page.locator('#book .bk-lip').evaluate(lip => lip.click());
    await c.settled(page, 'spread');
    await page.setViewportSize(MINI);
    await c.settled(page, 'open');
    const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"/>')}`;
    await page.evaluate(src => import('/shell/zoom.js').then(({ zoom }) => zoom(src, 'a sketch')), picture);
    await page.setViewportSize(UPRIGHT);
    await c.settled(page, 'spread');
    await takesTap(page, 'dialog.zoom .zoom-close', 'a picture opened large as the iPad turned upright');
    await until(() => page.evaluate(() => !document.querySelector('dialog.zoom')), 'the picture closed by its button');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// The control is what a tap at its middle reaches, nothing inert over or round it, and it's tapped there
async function takesTap(page, selector, what) {
  const hit = await page.evaluate(s => {
    const el = document.querySelector(s),
      b = el.getBoundingClientRect(),
      at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    const inert = [...document.querySelectorAll('[inert]')].filter(i => i.contains(el)).map(i => i.id || i.className);
    return { reached: at === el || el.contains(at), at: at && (at.id || at.className || at.localName), inert };
  }, selector);
  assert.deepEqual(hit.inert, [], `${what}: inert under ${hit.inert.join(', ')}`);
  assert.ok(hit.reached, `${what}: a tap on it reaches ${hit.at}`);
  const box = await page.locator(selector).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}
