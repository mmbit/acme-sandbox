#!/usr/bin/env node
// Mail's Send to the team (mail.ts forward): one button under a mail of the board's own, none under the agents' mail. A
// click hands it on once and the button says so with the job's number; a mail already handed shows its job from the start.
// In every look, on a phone and a laptop.
//   node platform/hq/mailhand-check.mjs [out dir for shots]   (HQ's files from serve.mjs, its /api played here)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { lookNames } from './looks.mjs';
const { chromium } = await import('/usr/local/lib/node_modules/playwright/index.mjs').catch(
  () => import('/opt/node22/lib/node_modules/playwright/index.mjs'),
);
const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const iso = h => new Date(Date.now() - h * 36e5).toISOString();
const mail = () => [
  {
    id: 9,
    received: iso(0.5),
    sender: 'accountant@example.net',
    recipient: 'board@example.com',
    subject: 'Quarterly VAT return',
    board: 1,
    forwarded: null,
  },
  {
    id: 8,
    received: iso(1),
    sender: 'a@example.com',
    recipient: 'hello@example.com',
    subject: 'Hi',
    board: 0,
    forwarded: null,
  },
  {
    id: 7,
    received: iso(2),
    sender: 'no-reply@bank.example',
    recipient: 'board@example.com',
    subject: 'New statement',
    board: 1,
    forwarded: 4321,
  },
];
for (const look of lookNames())
  for (const [width, height, device] of [
    [390, 844, 'phone'],
    [1280, 800, 'laptop'],
  ]) {
    const at = `${look}, ${device}`,
      forwards = [];
    const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
    await ctx.route(`${base}/api/**`, async r => {
      const path = new URL(r.request().url()).pathname;
      if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
      if (path === '/api/brand') {
        const b = await (await r.fetch({ url: `${base}/mock/brand.json` })).json();
        b.brand.mail.forwardTo = 'juno';
        return r.fulfill({ json: b });
      }
      if (path === '/api/mail') return r.fulfill({ json: mail() });
      if (path === '/api/mail/one')
        return r.fulfill({
          json: {
            id: Number(new URL(r.request().url()).searchParams.get('id')),
            body: 'Please sign the return by Friday.',
            attachments: '[]',
          },
        });
      if (path === '/api/mail/forward') {
        forwards.push(r.request().postDataJSON().id);
        return r.fulfill({ json: { job: 16300, already: false } });
      }
      if (path === '/api/seen') return r.fulfill({ json: {} });
      if (path === '/api/gazette') return r.fulfill({ json: [] });
      if (path === '/api/requests' || path === '/api/review/products') return r.fulfill({ json: [] });
      return r.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    await page.waitForFunction(() => document.querySelector('#loading')?.classList.contains('gone'), null, {
      timeout: 30_000,
    });
    await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('mail')));
    await page.waitForSelector('.rows [data-mail]');
    const open = async id => {
      await page.click(`[data-mail="${id}"] > summary`);
      await page.waitForSelector(`[data-mail="${id}"][data-loaded]`);
    };
    const button = id =>
      page.$eval(`[data-mail="${id}"]`, d => {
        const b = d.querySelector('.mailfwd button');
        return b && { text: b.textContent, disabled: b.disabled };
      });
    await open(8);
    assert.equal(await button(8), null, `${at}: the agents' mail has no button`);
    await open(7);
    assert.deepEqual(
      await button(7),
      { text: 'Sent to the team · job #4321', disabled: true },
      `${at}: a mail already handed shows its job`,
    );
    await open(9);
    assert.deepEqual(await button(9), { text: 'Send to the team', disabled: false }, at);
    if (out) await page.screenshot({ path: `${out}/${look}-${device}-before.png` });
    await page.click('[data-mail="9"] .mailfwd button');
    await page.waitForFunction(() => document.querySelector('[data-mail="9"] .mailfwd button')?.disabled);
    assert.deepEqual(
      await button(9),
      { text: 'Sent to the team · job #16300', disabled: true },
      `${at}: after the click`,
    );
    assert.deepEqual(forwards, [9], `${at}: one hand-off`);
    if (out) await page.screenshot({ path: `${out}/${look}-${device}-after.png` });
    const box = await page.$eval('[data-mail="9"] .mailfwd button', b => {
      const r = b.getBoundingClientRect();
      return { inside: r.right <= innerWidth && r.left >= 0 };
    });
    assert.ok(box.inside, `${at}: on screen (${JSON.stringify(box)})`);
    assert.deepEqual(errors, [], at);
    await ctx.close();
  }
console.log('mailhand-check: ok');
await browser.close();
server.close();
