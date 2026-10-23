#!/usr/bin/env node
// The Library's Copy buttons: in a document with two code blocks, each button copies its own block exactly, with its
// newlines and indents, and says "Copied" for a moment. A post's code block has one too.
//   node platform/hq/copy-check.mjs [--browser chromium|webkit]… [--shots <dir>]
// HQ on its own files with a fake /api serving the document, at a tablet's width with touch, in Chromium and WebKit.
// Each tap goes through the browser's real clipboard call, recorded on the way; Chromium also reads the clipboard back.
// WebKit needs Playwright's WebKit build and the system libraries it lists (`npx playwright install-deps webkit`, or
// unpacked into a folder without root); Chromium needs nothing.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const { chromium, webkit } = playwright();
const args = process.argv.slice(2), arg = k => args.flatMap((a, i) => a === k ? [args[i + 1]] : []);
const BROWSERS = { chromium, webkit }, WHICH = arg('--browser').length ? arg('--browser') : ['chromium', 'webkit'], SHOTS = arg('--shots')[0];

// Two blocks as the coordinator's Markdown renderer writes them: escaped, a newline before </code>, and a file name
// that HQ turns into a link. The first has a line longer than the tablet's column.
const FIRST = 'Monthly block\nInvoices (date | supplier | total)\n  2026-10-01 | "Fonts & Co <EU>" | 12.10\nThis line is long on purpose, longer than the tablet column, so that the block scrolls sideways under its button.\nSee books.md';
const SECOND = 'Quarterly block\nSales: none\n\nTotal: 0.00';
const escaped = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const block = s => `<pre><code class="language-text">${escaped(s)}\n</code></pre>\n`;
const library = [
  { path: 'knowledge/notes/test/two-blocks.md', shelf: 'Notes · test', title: 'Two blocks', html: `<p>Copy each block.</p>\n<h2>Month</h2>\n${block(FIRST)}<h2>Quarter</h2>\n${block(SECOND)}` },
  { path: 'knowledge/notes/test/books.md', shelf: 'Notes · test', title: 'Books', html: '<p>The books.</p>' },
];
const gazette = [{ slug: '2026-10-04-post', title: 'A post', author: 'someone', date: '2026-10-04', t: '2026-10-04', html: `<p>One block.</p>\n${block(SECOND)}` }];

const server = await serve(), base = `http://localhost:${server.address().port}`;
let failed = false;
for (const name of WHICH) {
  try { await check(name); console.log(`copy-check ${name}: each Copy button copies its own block, and says so`); }
  catch (err) { failed = true; console.error(`copy-check ${name}: ${err.message}`); }
}
server.close();
process.exit(failed ? 1 : 0);

async function check(name) {
  const browser = await BROWSERS[name].launch();
  const { context, page, errors } = await openPage(browser, { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  if (name === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await context.route(`${base}/api/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/org') return r.fulfill({ path: join(ROOT, 'platform/hq/mock/org.json') });
    if (path === '/api/library') return r.fulfill({ json: library });
    if (path === '/api/gazette') return r.fulfill({ json: gazette });
    return r.fulfill({ status: 404, body: '' });
  });
  await context.addInitScript(() => {
    window.copied = [];
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = text => write(text).then(() => { window.copied.push(text); });
  });
  try {
    await page.goto(`${base}/?intro=0`);
    await page.waitForSelector('#loading.gone');
    await page.evaluate(() => import('/shell/news.js').then(m => m.openLibraryDoc('two-blocks.md')));
    const buttons = page.locator('.doc .html .copy-code');
    await buttons.nth(1).waitFor();
    assert.equal(await buttons.count(), 2, 'one button per block');
    assert.equal(await page.locator('.doc .html pre a').count(), 1, 'the file name in the first block is a link');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `copy-${name}.png`) });

    for (const [i, text] of [[1, SECOND], [0, FIRST]]) {
      const button = buttons.nth(i);
      const box = await button.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 32, `button ${i + 1} is big enough to tap (${box.width}×${box.height})`);
      // what the button says, as it changes (on a busy machine a tap can take longer than the 1.2 s "Copied" shows)
      await button.evaluate(b => { window.labels = []; new MutationObserver(() => window.labels.push(b.textContent)).observe(b, { childList: true }); });
      await button.tap();
      await page.waitForFunction(n => window.copied.length === n && window.labels.length === 2, 2 - i, { timeout: 5000 })
        .catch(async () => { throw new Error(`button ${i + 1} copied ${JSON.stringify(await page.evaluate(() => window.copied))}, said ${JSON.stringify(await page.evaluate(() => window.labels))}`); });
      assert.equal(await page.evaluate(() => window.copied.at(-1)), text, `button ${i + 1} copies its own block`);
      assert.deepEqual(await page.evaluate(() => window.labels), ['Copied', 'Copy'], `button ${i + 1} says Copied, then Copy again`);
      if (name === 'chromium') assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, 'the clipboard holds the block');
    }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `copy-${name}-after.png`) });

    await page.evaluate(() => import('/shell/news.js').then(m => m.openGazette(false)));
    await page.locator('.card > .cover').first().evaluate(b => b.click()); // (its button)
    await page.locator('.post .html .copy-code').tap();
    await page.waitForFunction(() => window.copied.length === 3, null, { timeout: 5000 })
      .catch(async () => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `copy-${name}-post.png`) }); throw new Error("a post's Copy button copied nothing"); });
    assert.equal(await page.evaluate(() => window.copied.at(-1)), SECOND, "a post's block copies too");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
