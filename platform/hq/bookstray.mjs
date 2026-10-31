// book-check.mjs's story of stray selection: on the iPad mini (upright, touch) and a desktop, nothing on HQ's canvas
// and the notebook's controls selects, at any point of the screen or by a drag across them, and nothing there opens
// iOS's long-press callout where the engine knows it; while the intercom's words still select and copy. Run it in
// WebKit too (--webkit), the iPad's engine.
import assert from 'node:assert/strict';
import { DESKTOP, UPRIGHT, heard } from './bookkit.mjs';

// c: book-check.mjs's played store and helpers
export function strayStories(c) {
  return {
    "stray selection: HQ's canvas and the notebook's controls select nothing, the intercom's words still copy":
      browser => stray(browser, c),
  };
}

async function stray(browser, c) {
  for (const [viewport, touch] of [
    [DESKTOP, false],
    [UPRIGHT, true],
  ]) {
    const size = `${viewport.width}x${viewport.height}`,
      context = await c.hqIn(browser, viewport, { hasTouch: touch, deviceScaleFactor: 1 }),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await heard(page);
      await page.goto(`${c.base}/?intro=0`);
      const upright = viewport === UPRIGHT;
      await c.settled(page, upright ? 'folded' : 'open');
      // HQ's page with the book folded (upright) or beside it: every point of it
      assert.deepEqual(await selectable(page, 'hq'), [], `HQ's page selects nothing (${size})`);
      await dragged(page, await quarterAcross(page, '#world'), [8, 8]);
      await page.mouse.dblclick(...(await quarterAcross(page, '#world')));
      assert.equal(await selected(page), '', `a drag or a double click on HQ's canvas selects nothing (${size})`);
      await copied(page, size);
      await page.keyboard.press('Escape');
      await page.evaluate(() => getSelection().removeAllRanges());
      if (upright) {
        await page.evaluate(() => document.querySelector('#book .bk-lip').click());
        await c.settled(page, 'spread');
      }
      // the notebook open: every point of it but its form fields, and a drag down its strip and on over HQ
      assert.deepEqual(await selectable(page, 'book'), [], `the notebook's controls select nothing (${size})`);
      const strip = await page.locator('#book .bk-strip').boundingBox();
      await dragged(page, [strip.x + strip.width / 2, strip.y + 8], [8, strip.y + strip.height - 8]);
      assert.equal(await selected(page), '', `a drag down the notebook's strip selects nothing (${size})`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

// The points on a 24 px grid over HQ's page (where: 'hq') or the book (where: 'book') whose element would select
// (user-select resolved through its ancestors, as Chromium's auto takes its parent's and WebKit's inherits) or, where
// the engine has iOS's callout, would open it; form fields and written-in boxes are text to select, so left out
async function selectable(page, where) {
  return page.evaluate(where => {
    const callouts = CSS.supports('-webkit-touch-callout', 'none'),
      found = new Set();
    const selects = el => {
      for (let at = el; at; at = at.parentElement) {
        const s = getComputedStyle(at),
          value = s.userSelect || s.webkitUserSelect;
        if (value && value !== 'auto') return value !== 'none';
      }
      return true;
    };
    for (let y = 4; y < innerHeight; y += 24)
      for (let x = 4; x < innerWidth; x += 24) {
        const el = document.elementFromPoint(x, y);
        if (!el || el.closest('input, textarea, [contenteditable]')) continue;
        if ((where === 'book') !== Boolean(el.closest('#book'))) continue;
        const callout = callouts && getComputedStyle(el).webkitTouchCallout !== 'none';
        if (selects(el) || callout) found.add(`${el.id ? `#${el.id}` : el.className || el.tagName} (${x}, ${y})`);
      }
    return [...found].slice(0, 12);
  }, where);
}

// The intercom's words: a double click selects one (a mouse's drag selects nothing in Chromium's iPad, a mobile
// screen), and the copy carries it
async function copied(page, size) {
  await page.evaluate(() => document.querySelector('#btn-intercom').click());
  const line = page.locator('.intercom .chat li').filter({ hasText: /\w{4}/ }).first();
  await line.waitFor({ timeout: 30_000 });
  const box = await line.boundingBox();
  await page.mouse.dblclick(box.x + 24, box.y + 12);
  const words = await selected(page);
  assert.ok(
    words.trim().length > 1,
    `a double tap on the intercom's words selects one (${size}) ${JSON.stringify(words)}`,
  );
  const copy = await page.evaluate(() => {
    let carried = null;
    addEventListener('copy', () => (carried = getSelection().toString()), { once: true });
    document.execCommand('copy');
    return carried;
  });
  assert.equal(copy, words, `the selected words copy (${size})`);
}

async function dragged(page, from, to) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}
const selected = page => page.evaluate(() => getSelection().toString());
// A point a quarter across an element, halfway down
async function quarterAcross(page, selector) {
  const box = await page.locator(selector).boundingBox();
  return [box.x + box.width / 4, box.y + box.height / 2];
}
