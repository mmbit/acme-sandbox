#!/usr/bin/env node
// A notice card (kind notice: news that asks nothing) closes with Got it: no answer needed, a typed note optional, the
// call there as on any card. An action card (steps for the board to do) sends with its box empty too.
// A decision card still asks for its answer.
//   node platform/hq/notice-check.mjs
// HQ on its own files with a fake /api (so it isn't in dev mode), the phone open on a notice, a decision and an action.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const at = new Date().toISOString();
const notice = {
  id: 9,
  created: at,
  agent: 'wren',
  kind: 'notice',
  title: 'No more photo work tonight',
  body: 'The batch is in.',
  urgency: 'whenever',
};
const decision = {
  id: 10,
  created: at,
  agent: 'wren',
  kind: 'decision',
  title: 'Red or blue?',
  body: 'For the van.',
  urgency: 'today',
};
const action = {
  id: 11,
  created: at,
  agent: 'wren',
  kind: 'action',
  title: 'Start Docker on the desktop',
  body: 'Open Docker Desktop.',
  urgency: 'today',
};
const answers = [];
const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 420, height: 912 } });
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests')
    return r.fulfill({ json: [notice, decision, action].filter(c => !answers.some(a => a.id === c.id)) });
  if (path === '/api/gazette') return r.fulfill({ json: [] }); // (HQ's boot waits for it)
  if (path === '/api/requests/answer') {
    answers.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true } });
  }
  return r.fulfill({ status: 404, body: '' });
});
await page.goto(`${base}/?intro=0&open=phone`);
await page.waitForSelector('#send-answer');

// the notice: Got it, the note optional, the call there
assert.equal((await page.textContent('#send-answer')).trim(), 'Got it');
assert.equal(await page.getAttribute('#answer', 'placeholder'), 'Anything to add (optional)');
assert.equal(await page.locator('#call-about').count(), 1);
await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/notice-check.png` });
// the decision next to it still needs its answer: an empty Send goes nowhere
await page.click('[data-step="1"]');
await page.waitForSelector('#send-answer:has-text("Send")');
await page.click('#send-answer');
await page.waitForTimeout(300);
assert.deepEqual(answers, []);
// back on the notice, Got it with nothing typed closes it
await page.click('[data-step="-1"]');
await page.waitForSelector('#send-answer:has-text("Got it")');
await page.click('#send-answer');
await page.waitForSelector('.req.done');
assert.deepEqual(
  answers.map(a => [a.id, a.answer]),
  [[9, '']],
);
// the action card: its box optional, Send with nothing typed sends it (the server records it as Done.)
await page.click('[data-step="1"]');
await page.waitForSelector('#send-answer:has-text("Send")');
await page.click('[data-step="1"]');
await page.waitForSelector('h3:has-text("Start Docker")');
assert.equal(await page.getAttribute('#answer', 'placeholder'), 'Anything to add (optional)');
await page.click('#send-answer');
await page.waitForSelector('.req.done');
assert.deepEqual(
  answers.map(a => [a.id, a.answer]),
  [
    [9, ''],
    [11, ''],
  ],
);
assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log('notice-check: ok');
