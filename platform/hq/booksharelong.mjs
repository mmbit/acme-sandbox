// book-check.mjs's story of a long page shared by its corner (shell/ink/bookshare.js), on a desktop in Chromium with
// the played store: it downloads whole as a PDF, and goes onto the call in pieces each readable at full size.
import assert from 'node:assert/strict';
import { until } from './bookkit.mjs';
import { downloaded, dragTo, inkLine, opened, shownOnCall, tapedPage } from './bookshare.mjs';

// c: book-check.mjs's { hqIn, base, pages, notebook, settled, noErrorsIn, SNIP, TALL, GROWN }
export function longShareStories(c) {
  return {
    'a long page downloads whole as a PDF and goes onto the call in pieces, each readable': browser =>
      longStory(browser, c),
    'a page whose answers run below its box goes onto the call in pieces of its picture, each readable': browser =>
      grownStory(browser, c),
  };
}

// A page four times as tall as wide (its picture as the store draws one: TALL): the PDF downloads whole on one page of
// its shape, and on Juno the call gets it in three pieces down it, each at most half again as tall as wide and a little
// over a third of it, so none is shrunk to be read
async function longStory(browser, c) {
  const free = tapedPage(c);
  // (a line written far down it grows it, as the store grows a page to what's on it: 1200 wide, about 4800 tall)
  const line = { ...inkLine(), points: inkLine().points.map(([x, y, ...r]) => [x, y + 4560, ...r]) };
  c.notebook.route('/api/notebooks/groups/create', {}, { page: free.id, ink: [line] });
  const { w, h } = c.notebook.route('/api/notebooks/pages', { notebook: 1 }).pages.find(p => p.id === free.id);
  assert.ok(h / w > 3.9, `a long page (${w} × ${h})`);
  const s = await opened(browser, c, c.TALL);
  const { page } = s;
  try {
    await page.locator('#book .bk-dogear').waitFor({ timeout: 5000 });
    const pdf = await downloaded(page, () => dragTo(page, 'mouse', 'pdf'));
    const text = pdf.bytes.toString('latin1');
    assert.match(text, /\/Count 1/, 'one page');
    assert.match(text, /\/MediaBox \[0 0 900 3600\]/, 'the page’s shape, four times as tall as wide');
    assert.match(text, /\/Width 600 \/Height 2400 /, 'its picture whole');
    await dragTo(page, 'mouse', 'call');
    await until(() => s.line.hello, 'a call started', 8000);
    for (const n of [1, 2, 3]) await shownOnCall(s, n, `piece ${n} of the page`);
    await page.waitForTimeout(800);
    assert.equal(s.uploads.length, 3, 'three pieces');
    for (const [i, jpeg] of s.uploads.entries()) {
      const { width, height } = jpegSize(jpeg);
      assert.equal(width, 600, `piece ${i + 1} the page’s whole width`);
      assert.ok(height <= 900 && height >= 800, `piece ${i + 1} a third of it, a little over (${height})`);
    }
    c.noErrorsIn(s.errors);
  } finally {
    c.pages.splice(c.pages.indexOf(free), 1);
    await s.done();
  }
}
// A page whose box isn't long but whose picture, as the store draws it with the answers under its last group, is twice
// as tall as wide (GROWN): the call gets it in pieces of the picture, each its whole width and at most half again as
// tall, down the whole of it.
async function grownStory(browser, c) {
  const free = tapedPage(c);
  assert.ok(free.h / free.w <= 1.5, `the page's box isn't long (${free.w} × ${free.h})`);
  const s = await opened(browser, c, c.GROWN);
  const { page } = s;
  try {
    await page.locator('#book .bk-dogear').waitFor({ timeout: 5000 });
    await dragTo(page, 'mouse', 'call');
    await until(() => s.line.hello, 'a call started', 8000);
    for (const n of [1, 2]) await shownOnCall(s, n, `piece ${n} of the page`);
    await page.waitForTimeout(800);
    const sizes = s.uploads.map(jpegSize);
    for (const [i, { width, height }] of sizes.entries()) {
      assert.equal(width, 600, `piece ${i + 1} the picture's whole width`);
      assert.ok(height <= 900, `piece ${i + 1} at most half again as tall as wide (${height})`);
    }
    assert.ok(sizes.reduce((sum, { height }) => sum + height, 0) >= 1200, 'together the whole picture');
    c.noErrorsIn(s.errors);
  } finally {
    c.pages.splice(c.pages.indexOf(free), 1);
    await s.done();
  }
}
// A JPEG's size, from its frame's header
function jpegSize(bytes) {
  for (let at = 2; at < bytes.length; at += 2 + bytes.readUInt16BE(at + 2))
    if (bytes[at + 1] >= 0xc0 && bytes[at + 1] <= 0xc2)
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
  return {};
}
