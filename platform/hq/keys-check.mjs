#!/usr/bin/env node
// A key card says why a save was refused, under the field it was about, and marks the fields that were saved: the server's
// refusal ({ error, refused: { name: why }, missing }, secrets.ts saveSecrets) as the desk phone shows it. A card refused
// as a whole says so in the message line.
//   node platform/hq/keys-check.mjs
// HQ on its own files with a fake /api (so it isn't in dev mode), the phone open on a card with two key fields.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const server = await serve(), base = `http://localhost:${server.address().port}`;
const CARE = 'CARE_ANTHROPIC_API_KEY', EVAL = 'ANTHROPICEVAL_TEST_API_KEY', WHY = 'This is a Claude sign-in token, not an API key.';
const card = { id: 9, created: new Date().toISOString(), agent: 'wren', kind: 'credential', title: 'Two model keys', body: 'Both, please.', urgency: 'today', secrets: `${CARE},${EVAL}`, saved: [] };
const other = { ...card, id: 10, title: 'Another key', secrets: 'STRIPE_TEST_OTHER_KEY' };
let late = null; // a reply held back until the board has moved on to the other card
const answers = [], replies = [
  [400, { error: `Not saved: ${EVAL}.`, refused: { [EVAL]: WHY }, missing: [EVAL] }],
  [400, { error: 'Fill in at least one key.', refused: {} }],
  [400, { error: `Not saved: ${EVAL}.`, refused: { [EVAL]: WHY }, missing: [EVAL] }, new Promise(go => late = go)],
  [200, { ok: true }],
];
const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 420, height: 912 } });
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests') return r.fulfill({ json: [card, other] });
  if (path === '/api/gazette') return r.fulfill({ json: [] }); // (HQ's boot waits for it)
  if (path === '/api/requests/answer') { answers.push(r.request().postDataJSON().secrets); const [status, json, wait] = replies.shift(); await wait; return r.fulfill({ status, json }); }
  return r.fulfill({ status: 404, body: '' });
});
await page.goto(`${base}/?intro=0&open=phone`);
await page.waitForSelector(`[data-key="${EVAL}"]`);
const msg = () => page.textContent('#answer-msg'), under = k => page.locator(`label.key:has([data-key="${k}"]) + p.refused`);

// one refused, one saved: the reason under the eval field only, the server key marked saved, the fields empty again
await page.fill(`[data-key="${CARE}"]`, 'sk-ant-usr01-aaaa');
await page.fill(`[data-key="${EVAL}"]`, 'sk-ant-oat01-bbbb');
await page.click('#send-answer');
await page.waitForSelector('p.refused');
assert.equal(await under(EVAL).textContent(), WHY);
assert.equal(await under(CARE).count(), 0);
assert.match(await page.textContent(`label.key:has([data-key="${CARE}"])`), /saved ✓/);
assert.equal(await page.inputValue(`[data-key="${EVAL}"]`), '');
assert.ok(!['', 'Sending…'].includes(await msg()), 'a word in the message line too');
await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/keys-check.png` });
// the next Save clears the old reason; a card refused as a whole says why in the message line
await page.fill(`[data-key="${EVAL}"]`, 'x');
await page.click('#send-answer');
await page.waitForFunction(() => document.querySelector('#answer-msg')?.textContent === 'Fill in at least one key.');
assert.equal(await page.locator('p.refused').count(), 0);
// a refusal that comes back after the board has gone on to the next card leaves that card and what's typed there alone;
// the reason is under the field when the board comes back
await page.fill(`[data-key="${EVAL}"]`, 'sk-ant-oat01-dddd');
await page.click('#send-answer');
await page.click('[data-step="1"]');
await page.fill('[data-key="STRIPE_TEST_OTHER_KEY"]', 'sk_test_typed');
const landed = page.waitForResponse(/\/api\/requests\/answer/);
late(); await landed; await page.waitForTimeout(300); // (the page's catch runs just after the response)
assert.equal(await page.inputValue('[data-key="STRIPE_TEST_OTHER_KEY"]'), 'sk_test_typed');
assert.equal(await page.locator('p.refused').count(), 0);
assert.equal(await msg(), '');
await page.fill('[data-key="STRIPE_TEST_OTHER_KEY"]', '');
await page.click('[data-step="-1"]');
assert.equal(await under(EVAL).textContent(), WHY);
// and a save that goes through closes the card
await page.fill(`[data-key="${EVAL}"]`, 'sk-ant-usr01-cccc');
await page.click('#send-answer');
await page.waitForSelector('.req.done');
assert.deepEqual(answers, [{ [CARE]: 'sk-ant-usr01-aaaa', [EVAL]: 'sk-ant-oat01-bbbb' }, { [EVAL]: 'x' }, { [EVAL]: 'sk-ant-oat01-dddd' }, { [EVAL]: 'sk-ant-usr01-cccc' }]);
assert.deepEqual(errors, []);
await browser.close(); server.close();
console.log('keys-check: ok');
