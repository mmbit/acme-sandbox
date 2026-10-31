// book-check.mjs's story of Ctrl and the wheel on a desktop (shell/ink/bookstrip.js, bookpan.js): a notch on steps to
// the next tool along the rail, the pen and the marker one stop, and a notch back steps back.
import assert from 'node:assert/strict';
import { desk, paperBox } from './bookmouse.mjs';
import { pressed } from './bookstrip.mjs';
import { until } from './bookkit.mjs';

// c: book-check.mjs's played store and helpers
export function wheelStories(c) {
  return {
    'controls with a mouse: Ctrl and the wheel step along the rail, the pen and the marker one stop': browser =>
      wheel(browser, c),
  };
}

async function wheel(browser, c) {
  const { page, errors, done } = await desk(browser, c);
  try {
    const paper = await paperBox(page);
    let was = null;
    await until(
      async () => (was = await pressed(page)) === 'Pen',
      () => `the book opens on the pen, not ${was}`,
    );
    await page.mouse.move(paper.x + paper.width / 2, paper.y + paper.height / 3);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await until(async () => (await pressed(page)) === 'Eraser', 'the eraser after a notch, past the marker');
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, -100);
    await until(async () => (await pressed(page)) === 'Pen', 'the pen after a notch back');
    await page.keyboard.up('Control');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}
