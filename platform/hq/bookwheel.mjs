// book-check.mjs's stories of the tool strip and the wheel on a desktop (shell/ink/bookstrip.js, bookpan.js): the
// strip beside Undo's at the paper's right edge, the tool's name fading a moment after it's picked, Ctrl and the wheel
// stepping through the tools, and the wheel and a trackpad's pinch (a wheel with ctrlKey, but no key down) zooming
// with the tool kept. (the board, 28 Oct)
import assert from 'node:assert/strict';
import { paperBox } from './bookmouse.mjs';
import { desk, now, pressed } from './bookstrip.mjs';
import { until } from './bookkit.mjs';

// c: book-check.mjs's played store and helpers
export function wheelStories(c) {
  return {
    "controls with a mouse: the strip beside Undo's, its tool's name fading; Ctrl and the wheel step through tools, the wheel and a pinch zoom":
      browser => wheel(browser, c),
  };
}

async function wheel(browser, c) {
  const { page, errors, done } = await desk(browser, c);
  try {
    const paper = await paperBox(page),
      strip = await page.locator('#book .bk-strip [data-island=tools]').boundingBox(),
      undo = await page.locator('#book [data-island=book]').boundingBox();
    assert.ok(strip.x + strip.width <= undo.x && undo.x - (strip.x + strip.width) < 16, 'the strip beside Undo');
    assert.ok(paper.x + paper.width - (undo.x + undo.width) < 24, "Undo's by the paper's right edge");
    assert.equal(await now(page), 'Pen', 'the tool in use named');
    await until(() => faded(page), 'the name faded a moment after');
    // Ctrl and the wheel: one notch on, one back, the name shown again
    const mid = [paper.x + paper.width / 2, paper.y + paper.height / 2];
    await page.mouse.move(...mid);
    await page.evaluate(() => {
      const el = document.querySelector('#book .bk-now');
      new MutationObserver(() => !el.classList.contains('bk-faded') && (window.__named = true)).observe(el, {
        attributeFilter: ['class'],
      });
    });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await until(async () => (await now(page)) === 'Highlighter', 'the next tool after a notch');
    assert.ok(await page.evaluate(() => window.__named), 'the name shown again as the tool is picked');
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, -100);
    await until(async () => (await now(page)) === 'Pen', 'the tool before after a notch back');
    await page.keyboard.up('Control');
    assert.equal(await page.locator('#book .bk-pct').isVisible(), false, 'Ctrl and the wheel zoomed nothing');
    // the wheel alone zooms: the % shows, the tool kept
    await page.mouse.wheel(0, -200);
    await until(() => page.locator('#book .bk-pct').isVisible(), 'the zoom off 100%');
    assert.equal(await pressed(page), 'Pen', 'the wheel kept the tool');
    await pinched(page, mid);
    assert.equal(await pressed(page), 'Pen', 'the pinch kept the tool');
    await c.shot('book-wheel-desktop', page);
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

// A trackpad's pinch as Chromium hands it over, a wheel with ctrlKey and no key down: the zoom goes on. (Chromium's own
// pinch, which comes as a wheel with no notch in it)
async function pinched(page, at) {
  const pct = () => page.locator('#book .bk-pct').textContent(),
    was = await pct(),
    cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', { x: at[0], y: at[1], scaleFactor: 1.5, gestureSourceType: 'mouse' });
  await until(async () => (await pct()) !== was, 'the pinch zoomed');
}

// (the name gone, or on its way: the fade's class, bookstrip.css)
const faded = page => page.locator('#book .bk-now').evaluate(el => el.classList.contains('bk-faded'));
