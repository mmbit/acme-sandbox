#!/usr/bin/env node
// A desk-phone card with a Markdown table shows it as a table on its first screen, never as pipes or under More: in
// small type at the card's width, a wider one scrolling sideways inside the card while the page holds still. On a phone
// and a tablet, in every look.
//   node platform/hq/table-check.mjs [looks] [--shots <dir>]   (looks: brownstone,holo,wire by default)
// HQ on its own files with a fake /api serving one notice, in Chromium.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const args = process.argv.slice(2),
  shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null,
  looks = args[0] && args[0] !== '--shots' ? args[0].split(',') : ['brownstone', 'holo', 'wire'];
const VIEWPORTS = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 } };

const ROWS = [
  ['/en/', 'wooden toys', '2,400', '1,900', '+12%'],
  ['/en/shop/', 'handmade rattle', '880', '1,310', '+4%'],
  ['/nl/winkel/', 'houten speelgoed', '3,600', '20', '-2%'],
  ['/de/laden/', 'holzspielzeug kaufen', '30', '5,400', '+31%'],
];
const BACKGROUND = Array.from(
  { length: 12 },
  (_, i) => `Background sentence ${i + 1} says where the figures come from.`,
).join(' ');
const notice = {
  id: 7,
  created: new Date().toISOString(),
  agent: 'wren',
  kind: 'notice',
  title: 'Searches a month, per page and word',
  urgency: 'whenever',
  body: `Google's search counts for our pages, Netherlands and Germany.

| Page | Word | NL | DE | Change |
|---|---|---:|---:|---:|
${ROWS.map(r => `| ${r.join(' | ')} |`).join('\n')}

${BACKGROUND}`,
};

const browser = await playwright().chromium.launch(),
  server = await serve(),
  base = `http://localhost:${server.address().port}`;
let failed = false;
for (const look of looks)
  for (const [size, viewport] of Object.entries(VIEWPORTS))
    try {
      await check(look, size, viewport);
      console.log(`table-check ${look} ${size}: the table shows on the first screen`);
    } catch (err) {
      failed = true;
      console.error(`table-check ${look} ${size}: ${err.message}`);
    }
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

async function check(look, size, viewport) {
  const { context, page, errors } = await openPage(browser, { viewport, isMobile: true, hasTouch: true });
  await context.route(`${base}/api/**`, async r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (path === '/api/requests') return r.fulfill({ json: [notice] });
    if (['/api/gazette', '/api/mail', '/api/review/products'].includes(path)) return r.fulfill({ json: [] });
    if (path === '/api/seen') return r.fulfill({ json: {} });
    return r.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${base}/?intro=0&renderer=${look}&open=phone`);
  await page.waitForSelector('#phone-screen .req table', { timeout: 60_000 });
  if (shots) await page.screenshot({ path: join(shots, `table-${look}-${size}.png`) });
  const shown = await page.evaluate(() => {
    const screen = document.querySelector('#phone-screen'),
      card = screen.querySelector('.req'),
      wrap = card.querySelector('.table'),
      box = el => el.getBoundingClientRect();
    return {
      inMore: !!wrap.closest('details'),
      cells: [...wrap.querySelectorAll('tr')].map(tr => [...tr.children].map(td => td.textContent)),
      pipes: card.innerText.includes('|'),
      top: box(wrap).top - box(screen).top,
      screen: screen.clientHeight,
      overhang: box(wrap).right - box(card).right,
      wider: wrap.scrollWidth > wrap.clientWidth,
      fontSize: parseFloat(getComputedStyle(wrap.querySelector('td')).fontSize),
      bodySize: parseFloat(getComputedStyle(card.querySelector('.body')).fontSize),
      pageScrolls: document.documentElement.scrollWidth > innerWidth,
      more: card.querySelector('details.more')?.textContent ?? '',
    };
  });
  assert.equal(shown.inMore, false, 'the table is on the card, not under More');
  assert.deepEqual(shown.cells, [['Page', 'Word', 'NL', 'DE', 'Change'], ...ROWS]);
  assert.equal(shown.pipes, false, 'no raw pipes');
  assert.ok(
    shown.top < shown.screen * 0.6,
    `the table starts on the first screen (${shown.top} of ${shown.screen} px)`,
  );
  assert.ok(shown.overhang <= 1, `the table stays inside the card (${shown.overhang} px over)`);
  assert.ok(shown.fontSize < shown.bodySize, `small type (${shown.fontSize} px in ${shown.bodySize} px text)`);
  assert.equal(shown.pageScrolls, false, 'the page itself never scrolls sideways');
  assert.match(shown.more, /Background sentence 12/, 'the background still folds under More');
  if (shown.wider) {
    await page.$eval('#phone-screen .req .table', wrap => wrap.scrollBy(400, 0));
    const scrolled = await page.$eval('#phone-screen .req .table', wrap => wrap.scrollLeft);
    assert.ok(scrolled > 0, 'a wider table scrolls sideways inside the card');
  }
  assert.deepEqual(errors, []);
  await context.close();
}
