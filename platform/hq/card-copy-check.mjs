#!/usr/bin/env node
// The desk phone's cards on a tablet and a phone: text to paste is a block with a Copy button that copies it exactly and
// says "Copied", a long block shows a few lines and Show all, a [text](address) link shows its text, a list in a step
// is one link a line, a `value` still copies with a tap, and a card's long opening and its background fold under More,
// so the steps are on the first screen. A block's Copy sits under it, on one row with Show all, and a card's files are
// downloads by their names.
//   node platform/hq/card-copy-check.mjs [--browser chromium|webkit]… [--shots <dir>]
// HQ on its own files with a fake /api serving two cards, in Chromium and WebKit (set up as copy-check.mjs says).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const { chromium, webkit } = playwright();
const args = process.argv.slice(2),
  arg = k => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const BROWSERS = { chromium, webkit },
  WHICH = arg('--browser').length ? arg('--browser') : ['chromium', 'webkit'],
  SHOTS = arg('--shots')[0];
const VIEWPORTS = { tablet: { width: 820, height: 1180 }, phone: { width: 390, height: 844 } };
// a busy machine can take long over a tap
const TAP = { timeout: 90_000 };

// The text to paste, with an empty line and an indent of its own, as the card writes it indented under its step
const PASTE = [
  'I ask you to remove the pages below from your results, as they show my home address.',
  '',
  ...Array.from(
    { length: 9 },
    (_, i) => `Line ${i + 1} of the reason, long enough to wrap on a phone's narrow column of text.`,
  ),
  'Set the filter to `active` and keep **both** asterisks.',
  'products/_cycles/demo/cover.png',
  'https://cycles.preview.example.org/demo/frame.png',
  '  Signed, the owner',
  '',
].join('\n');
const PAGES = ['https://www.example.org/one', 'https://www.example.net/two/', 'https://www.example.com/three'];
const ago = m => new Date(Date.now() - m * 60_000).toISOString();
const card = (id, title, body) => ({
  id,
  created: ago(id),
  agent: 'wren',
  kind: 'action',
  title,
  body,
  urgency: 'today',
});
const cards = [
  card(
    1,
    'Search: take the address out of the results',
    `Ask the search engine to drop the results that show the home address. About seven minutes.

Claude: yes
Steps:
1. Open **[its removal form](https://search.example.com/removal)** (https://search.example.com/removal) and choose personal information.
2. Add the pages it shows:
${PAGES.map(p => `   - ${p}`).join('\n')}
3. Paste this as the reason:
   \`\`\`
${PASTE.split('\n')
  .map(l => l && `   ${l}`)
  .join('\n')}
   \`\`\`
4. Submit, then name the case \`address-removal\` and keep its number.

---
The pages have shown the address since spring. Removal from the results leaves the pages themselves as they are.`,
  ),
  {
    // (two files to download, a third past its month)
    ...card(
      3,
      'The fixed pages',
      'Two pages to put in place.\n\nSteps:\n1. Download over-ons.html and put it in place of the old one.',
    ),
    files: [
      { n: 0, name: 'over-ons.html', size: 2300, kept: true },
      { n: 1, name: 'contact.html', size: 1900, kept: true },
      { n: 2, name: 'old.html', size: 900, kept: false },
    ],
  },
  card(
    2,
    'A card with a long opening',
    `${Array.from({ length: 24 }, (_, i) => `Sentence ${i + 1} tells the board a little more about the why.`).join(' ')}

Steps:
1. Tap the first button.
2. Tap the second one.`,
  ),
];

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
let failed = false;
for (const name of WHICH)
  for (const [size, viewport] of Object.entries(VIEWPORTS)) {
    try {
      await check(name, size, viewport);
      console.log(`card-copy-check ${name} ${size}: blocks copy exactly, lists and folds read`);
    } catch (err) {
      failed = true;
      console.error(`card-copy-check ${name} ${size}: ${err.message}`);
    }
  }
server.close();
process.exit(failed ? 1 : 0);

async function check(name, size, viewport) {
  const browser = await BROWSERS[name].launch();
  try {
    const { page, errors, shot } = await openCards(browser, name, size, viewport);
    await listReads(page);
    await blockShowsAll(page, shot);
    await copiesExactly(page);
    await opensFold(page, shot);
    await filesDownload(page, shot);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

// HQ with the fake /api, its clipboard writes recorded in window.copied, the desk phone open on the first card
async function openCards(browser, name, size, viewport) {
  const { context, page, errors } = await openPage(browser, {
    viewport,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  if (name === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await context.route(`${base}/api/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/org') return r.fulfill({ path: join(ROOT, 'platform/hq/mock/org.json') });
    if (path === '/api/requests') return r.fulfill({ json: cards });
    if (path === '/api/seen') return r.fulfill({ json: {} });
    if (['/api/gazette', '/api/mail', '/api/review/products'].includes(path)) return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  await context.addInitScript(() => {
    window.copied = [];
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = text =>
      write(text).then(() => {
        window.copied.push(text);
      });
  });
  const shot = file => SHOTS && page.screenshot({ path: join(SHOTS, `card-${name}-${size}-${file}.png`) });
  await page.goto(`${base}/?intro=0`);
  await page.waitForSelector('#loading.gone', { timeout: 60_000 });
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openPhone()));
  await page.waitForSelector('#phone-screen .req .steps');
  await shot('first');
  return { page, errors, shot };
}

// Step 1's [text](address) link shows its text, bold as written, by a bare address; the list in step 2: a link a line
async function listReads(page) {
  const step = await page.$$eval('.req .steps > li:nth-child(1) a', as =>
    as.map(a => [a.href, a.textContent, a.target, a.parentElement.tagName]),
  );
  assert.deepEqual(step, [
    ['https://search.example.com/removal', 'its removal form ↗', '_blank', 'B'],
    ['https://search.example.com/removal', 'search.example.com/removal ↗', '_blank', 'P'],
  ]);
  const links = await page.$$eval('.req .steps > li:nth-child(2) li a', as =>
    as.map(a => [a.href, a.getBoundingClientRect().top]),
  );
  assert.deepEqual(
    links.map(l => l[0]),
    PAGES,
    'each page is a link of its own',
  );
  assert.equal(new Set(links.map(l => Math.round(l[1]))).size, PAGES.length, 'one page a line');
}

// The block in step 3: a few lines, then Show all; step 4 right under it
async function blockShowsAll(page, shot) {
  await page.waitForSelector('.req .steps pre');
  const block = page.locator('.req .steps pre');
  assert.equal(await block.count(), 1, 'one block to paste');
  const sizes = () =>
    block.evaluate(pre => {
      const next = pre.closest('li').nextElementSibling.getBoundingClientRect(),
        screen = document.querySelector('#phone-screen').clientHeight;
      return {
        shown: pre.clientHeight,
        whole: pre.scrollHeight,
        gap: next.top - pre.getBoundingClientRect().bottom,
        screen,
      };
    });
  const clipped = await sizes();
  assert.ok(
    clipped.whole > clipped.shown * 1.5 && clipped.shown < clipped.screen * 0.3,
    `the block shows a few lines (${JSON.stringify(clipped)})`,
  );
  assert.ok(clipped.gap < 80, `step 4 follows the block (${clipped.gap} px)`);
  // Copy and Show all are the block's tools under it, and none above it
  const tools = await block.evaluate(pre => ({
    under: [...(pre.nextElementSibling?.children ?? [])].map(b => b.className),
    above: pre.previousElementSibling?.className,
  }));
  assert.deepEqual(tools.under, ['whole-code', 'copy-code'], 'Copy under the block');
  assert.notEqual(tools.above, 'copy-code', 'none above it');
  const whole = page.locator('.req .steps .whole-code');
  await whole.tap(TAP);
  await page.waitForFunction(() => document.querySelector('.req .steps pre').classList.contains('whole'));
  const open = await sizes();
  assert.ok(open.shown >= open.whole - 1, `Show all shows it whole (${JSON.stringify(open)})`);
  assert.equal(await whole.textContent(), 'Show less');
  await shot('whole');
  await whole.tap(TAP);
}

// The block's Copy button, a `value`'s tap and the Claude task all keep the literal paste text, and it shows no media
async function copiesExactly(page) {
  const tapped = async (selector, n) => {
    await page.locator(selector).tap(TAP);
    await page.waitForFunction(k => window.copied.length === k, n, { timeout: 10_000 });
    return page.evaluate(k => window.copied[k - 1], n);
  };
  const box = await page.locator('.req .steps .copy-code').boundingBox();
  assert.ok(box.width >= 44 && box.height >= 32, `the Copy button is big enough to tap (${box.width}×${box.height})`);
  assert.equal(
    await tapped('.req .steps .copy-code', 1),
    PASTE,
    'the block copies exactly, including literal Markdown, media paths and its final empty line',
  );
  assert.equal(await tapped('.req .steps [data-copy]', 2), 'address-removal');
  const task = await tapped('.req [data-claude]', 3);
  const handedOver = await page.evaluate(async text => {
    const { prose } = await import('/shell/prose.js');
    const div = document.createElement('div');
    div.innerHTML = prose(text);
    return div.querySelector('pre')?.textContent;
  }, task);
  assert.equal(handedOver, PASTE, 'the Claude task keeps the same literal paste text');
  assert.equal(await page.locator('.req .pics img').count(), 0, 'paste text creates no media preview');
}

// The first card's background folds under More; the second card's long opening folds, so its steps are on the first screen
async function opensFold(page, shot) {
  assert.equal(await page.$eval('.req details.more', d => d.open), false);
  assert.match(await page.textContent('.req details.more'), /since spring/);
  await toCard(page, 'long opening');
  const first = await page.evaluate(() => {
    const screen = document.querySelector('#phone-screen'),
      steps = screen.querySelector('.req .steps').getBoundingClientRect();
    return {
      stepsTop: steps.top - screen.getBoundingClientRect().top,
      screen: screen.clientHeight,
      more: screen.querySelector('.req details.more').textContent,
    };
  });
  assert.ok(first.stepsTop < first.screen * 0.8, `the steps are on the first screen (${JSON.stringify(first)})`);
  assert.match(first.more, /Sentence 24/, 'the rest of the opening is under More');
  await shot('long');
}

// The third card's files: each a download by its name, its size beside it, under the card's text; one past its month is
// its name alone
async function filesDownload(page, shot) {
  await toCard(page, 'fixed pages');
  const files = await page.$$eval('.req .files li', l =>
    l.map(li => {
      const a = li.querySelector('a');
      return [
        li.querySelector('.fn').textContent,
        a?.getAttribute('href') ?? null,
        a?.getAttribute('download') ?? null,
        li.querySelector('.size').textContent,
      ];
    }),
  );
  assert.deepEqual(files, [
    ['over-ons.html', '/api/requests/file?id=3&n=0', 'over-ons.html', '3 KB'],
    ['contact.html', '/api/requests/file?id=3&n=1', 'contact.html', '2 KB'],
    ['old.html', null, null, '1 KB'],
  ]);
  assert.ok(
    await page.$eval(
      '.req .files',
      ul => ul.compareDocumentPosition(document.querySelector('.req .steps')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ),
    'the files come before the steps that say where they go',
  );
  await shot('files');
}

// The card whose title says these words, by its pager (whatever order the phone shows them in): back to the first, then on
async function toCard(page, words) {
  const title = () => page.textContent('.req h3');
  while (await page.isEnabled('.pager [data-step="-1"]')) await page.click('.pager [data-step="-1"]');
  while (!(await title()).includes(words)) await page.click('.pager [data-step="1"]');
}
