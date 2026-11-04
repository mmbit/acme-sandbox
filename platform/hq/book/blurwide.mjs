// book-check.mjs's story of the Notebook's swing beside HQ on a workstation's screen: HQ's page blurs as it dissolves
// (shell/ink/bookswingmath.js blurs)
import assert from 'node:assert/strict';
import { until } from './kit.mjs';
import { seen, tabAt, tappedWatched, shutBy } from './open.mjs';

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode) }
export function blurWideStories(c) {
  return {
    "the Notebook's swing beside HQ at 2400 × 1300: HQ's page blurs as it goes and comes back": browser =>
      blurredWide(browser, c),
  };
}

// A workstation's screen, the book laid open beside HQ: lifted from shut and held mid-swing, HQ's page is blurred; let
// go, it opens, and shut again by the tab, HQ's page blurs as it goes. Each swing watched starts from a cleared count
// of slow swings, so it blurs however slow the ones before it were (tappedWatched clears it for the shut).
async function blurredWide(browser, c) {
  const { page, errors, done } = await c.hq(browser, { width: 2400, height: 1300 }, { hasTouch: false, pen: false });
  try {
    await shutBy(page, c);
    await page.evaluate(() => localStorage.removeItem('hq.book.slow'));
    const tab = await tabAt(page);
    await page.mouse.move(tab.x, tab.y);
    await page.mouse.down();
    await page.mouse.move(1700, tab.y, { steps: 4 });
    const held = await until(async () => {
      const s = await seen(page);
      return s.hq.opacity < 0.9 && s.hq.opacity > 0.1 && s;
    }, "HQ's page dissolving under the lifted book");
    await c.shot('swing-wide-held', page);
    assert.match(held.hq.filter, /^blur\(/, `held mid-swing: ${JSON.stringify(held.hq)}`);
    await page.mouse.move(400, tab.y, { steps: 4 });
    await page.mouse.up();
    await c.settled(page, 'open');
    await tappedWatched(page);
    await c.settled(page, 'folded');
    const frames = await page.evaluate(() => window.__rooms.splice(0));
    assert.ok(
      frames.some(f => f.blurred),
      `shut: HQ's page blurred as it went (${frames.length} frames)`,
    );
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
