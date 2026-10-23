#!/usr/bin/env node
// The desk phone's Share button follows the server: a tap sends a card's Share part as the latest poll has it, so one
// corrected since (hq rewrite) goes out corrected and one withdrawn since (rewritten in a keys job's words) goes out
// not at all, also while the board is typing an answer (when the phone holds off re-rendering). (A guest card has no
// card-wide Share: each person's Send link is guests-check's.) A Share part that is only a link goes to the sheet as its
// URL alone, no text (with text, Windows' sheet offers no Copy and Teams receives nothing); a written one as text.
//   node platform/hq/share-check.mjs
// HQ on its own files with a fake /api (so it isn't in dev mode and polls /api/requests), the phone open, and
// navigator.share recording what it's handed.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const card = share => ({
  id: 7,
  created: new Date().toISOString(),
  agent: 'wren',
  kind: 'action',
  title: 'Forward me',
  body: 'What we need from the accountant.',
  urgency: 'today',
  ...(share ? { share } : {}),
});
let requests = [card('First text')];

const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 420, height: 912 } });
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests') return r.fulfill({ json: requests });
  if (path === '/api/gazette') return r.fulfill({ json: [] }); // (HQ's boot waits for it)
  return r.fulfill({ status: 404, body: '' });
});
await context.addInitScript(() => {
  window.shared = [];
  navigator.share = async d => {
    window.shared.push(d);
  };
});
await page.goto(`${base}/?intro=0&open=phone`);
await page.waitForSelector('#share');

// a poll, as HQ does it every 20 s (desk.js is the page's own module: same URL, same instance)
const poll = async next => {
  requests = next;
  await page.evaluate(() => import('/shell/desk.js').then(m => m.refreshRequests()));
};
const tap = async () => {
  await page.click('#share');
  return page.evaluate(() => window.shared.at(-1));
};
const answer = '#answer',
  msg = () => page.textContent('#answer-msg');

assert.deepEqual(await tap(), { text: 'First text' });
// corrected while the board isn't typing: the card re-renders, the tap sends the new text
await poll([card('Second text')]);
assert.deepEqual(await tap(), { text: 'Second text' });
// corrected while the board is typing: no re-render (the answer stays), but the tap sends the new text
await page.fill(answer, 'my half-written answer');
await poll([card('Third text')]);
assert.equal(await page.inputValue(answer), 'my half-written answer');
assert.deepEqual(await tap(), { text: 'Third text' });
// withdrawn while the board is typing: the tap sends nothing, the button goes, the phone says so; the answer stays
await page.focus(answer);
await poll([card(null)]);
const before = await page.evaluate(() => window.shared.length);
await page.click('#share');
assert.equal(await page.evaluate(() => window.shared.length), before);
assert.equal(await page.$('#share'), null);
assert.match(await msg(), /Nothing to share/);
assert.equal(await page.inputValue(answer), 'my half-written answer');
// back again, not typing: the button follows the server on the next poll, and goes when it's withdrawn
await page.fill(answer, '');
await page.locator(answer).blur();
await poll([card('Fourth text')]);
assert.deepEqual(await tap(), { text: 'Fourth text' });
// a Share part that is only a link: its URL alone
await poll([card(' https://example.org/a/b?c=1\n')]);
assert.deepEqual(await tap(), { url: 'https://example.org/a/b?c=1' });
await poll([card('Our page: https://example.org/a')]);
assert.deepEqual(await tap(), { text: 'Our page: https://example.org/a' });
await poll([card(null)]);
assert.equal(await page.$('#share'), null);

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log(
  'share-check: the Share tap follows the server (corrected, withdrawn, while typing and not); a link goes as its URL alone',
);
