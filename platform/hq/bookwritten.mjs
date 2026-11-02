// book-check.mjs's handwriting story (shared/review/pencil.js, settle.js), held like an iPad mini with the book open,
// the board saying nothing: words written with the Pencil on HQ's page stay ink (board, call 176). The pen rests and
// nothing reads them: no type beside the ink, its post-it's field still empty; Save puts the scrap in the Notebook with
// no words, its ink and its snip carrying the strokes for whoever reads the note.
import assert from 'node:assert/strict';
import { savedScrap } from './bookscrap.mjs';
import { pressAlong } from './bookkit.mjs';

// Past the pen's rest (settle.js SETTLE_MS), with room to spare
const RESTED_MS = 2000;

// c: book-check's { hqOnStore, ui, hush, posts, pages, noErrorsIn, shot }
export async function writtenStory(browser, c) {
  const { page, errors, done } = await c.hqOnStore(browser),
    before = { pages: c.pages.length };
  c.hush(true);
  try {
    const from = c.posts.length;
    const box = await write(page, 120, 300);
    await page.waitForTimeout(RESTED_MS);
    assert.equal(await typeBeside(page, box), 0, 'no type beside the ink');
    assert.equal(await page.locator(c.ui('.sheet textarea')).inputValue(), '', 'its post-it holds no words');
    await c.shot('book-written-ink', page);
    const sent = await savedScrap({ ...c, page }, from, 'written');
    assert.deepEqual([sent.words ?? '', sent.said ?? null], ['', null], 'the scrap goes with no words');
    assert.equal(sent.anchor?.ink?.length, 4, 'its ink is the four lines written');
    assert.match(sent.snip ?? '', /^data:image\/(jpeg|png);base64,/, 'its snip goes with it, the lines on it');
    c.noErrorsIn(errors);
  } finally {
    c.hush(false);
    c.pages.splice(before.pages);
    await done();
  }
}

// "Hi" written at x, y with the pen, three lines in a row, as Safari hands them over. Returns the ink's box.
async function write(page, x, y) {
  const line = (a, b, n = 10) =>
    Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  const lines = [
    line([x, y], [x, y + 40]),
    line([x + 22, y], [x + 22, y + 40]),
    line([x, y + 20], [x + 22, y + 20]),
    line([x + 36, y + 14], [x + 36, y + 40]),
  ];
  for (const pts of lines) await pressAlong(page, pts);
  return { x, y, w: 36, h: 40 };
}
// How many of review mode's ink pixels to the right of a box are type's dark, not the ink's red
const typeBeside = (page, b) =>
  page.evaluate(b => {
    const k = devicePixelRatio;
    let dark = 0;
    for (const c of document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > canvas')) {
      const x = Math.round((b.x + b.w + 8) * k),
        y = Math.round(b.y * k),
        w = Math.min(Math.round(240 * k), c.width - x),
        h = Math.round(24 * k);
      if (w <= 0 || h <= 0) continue;
      const d = c.getContext('2d').getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
    }
    return dark;
  }, b);
