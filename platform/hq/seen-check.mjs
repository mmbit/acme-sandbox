#!/usr/bin/env node
// What the board reads on one device is read on all of them: two browsers, a phone
// and a laptop, share one stand-in for the coordinator's /api/seen. The phone opens the Gazette and Mail, and the
// laptop's Gazette and computer counts, and Mail's icon on its open home screen, clear when it comes back to the foreground.
// Mail to a reports address (brand.yaml's mail.reports: a DMARC report to dmarc@) never counts as new.
//   node platform/hq/seen-check.mjs        (HQ's files from serve.mjs, its /api played here)
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
const server = await serve(), base = `http://localhost:${server.address().port}`;
const browser = await playwright().chromium.launch();
const now = Date.now(), iso = h => new Date(now - h * 36e5).toISOString();
const local = h => { const d = new Date(now - h * 36e5), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
const gazette = [{ slug: 'b', title: 'Board brief', author: 'writer', date: local(1).slice(0, 10), t: local(1), board: true, html: '<p>x</p>' },
  { slug: 'c', title: 'Company news', author: 'writer', date: local(2).slice(0, 10), t: local(2), html: '<p>y</p>' }];
const mail = [{ id: 8, received: iso(0.5), sender: 'noreply-dmarc-support@google.com', recipient: 'dmarc@example.com', subject: 'Report domain: example.com' },
  { id: 7, received: iso(1), sender: 'a@example.com', recipient: 'hello@example.com', subject: 'Hi' }];
const marks = {};
async function device(width) {
  const { context, page, errors } = await openPage(browser, { viewport: { width, height: 844 } });
  await context.route(`${base}/api/**`, async r => {
    const path = new URL(r.request().url()).pathname, method = r.request().method();
    if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
    if (path === '/api/brand') { const b = await (await r.fetch({ url: `${base}/mock/brand.json` })).json(); b.brand.mail.reports = ['dmarc']; return r.fulfill({ json: b }); }
    if (path === '/api/gazette') return r.fulfill({ json: gazette });
    if (path === '/api/mail') return r.fulfill({ json: mail });
    if (path === '/api/seen' && method === 'GET') return r.fulfill({ json: { ...marks } });
    if (path === '/api/seen') { const b = r.request().postDataJSON(); if (marks[b.list] == null || b.newest > marks[b.list]) marks[b.list] = b.newest; return r.fulfill({ json: { ...marks } }); }
    if (path === '/api/requests' || path === '/api/review/products') return r.fulfill({ json: [] });
    return r.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${base}/?intro=0`);
  await until(page, '#loading.gone');
  await page.waitForTimeout(500);
  return { page, errors };
}
const news = p => p.$eval('#news-count', b => b.hidden ? 0 : Number(b.dataset.n));
const comp = p => p.$eval('#computer-count', b => b.hidden ? 0 : Number(b.dataset.n));
const laptop = await device(1280), phone = await device(390);
assert.equal(await news(laptop.page), 2, 'laptop: both posts new'); assert.equal(await news(phone.page), 2);
assert.equal(await comp(laptop.page), 1, 'laptop: one new mail, the DMARC report not counted');
// the laptop leaves its computer on the home screen, Mail's icon showing the new mail
await laptop.page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('home')));
await laptop.page.waitForSelector('.apps li.has-count [data-app="mail"]');
const mailIcon = p => p.$eval('[data-app="mail"]', b => b.parentElement.querySelector('.count')?.getAttribute('aria-label') ?? null);
assert.equal(await mailIcon(laptop.page), '1 waiting in Mail');
// the phone reads the Gazette (board feed, then company) and Mail
await phone.page.evaluate(() => import('/shell/news.js').then(m => { m.openGazette(true); m.openGazette(false); }));
await phone.page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('mail')));
await phone.page.waitForSelector('.rows [data-mail]'); await phone.page.waitForTimeout(300);
assert.deepEqual(marks, { 'gazette.board': local(1), 'gazette.company': local(2), mail: 8 }, 'the phone kept its reads on the server');
assert.equal(await news(phone.page), 0);
// the laptop comes back to the foreground
await laptop.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await laptop.page.waitForTimeout(800);
assert.equal(await news(laptop.page), 0, 'laptop: Gazette read on the phone');
assert.equal(await comp(laptop.page), 0, 'laptop: Mail read on the phone');
assert.equal(await mailIcon(laptop.page), null, "laptop: Mail's icon follows");
assert.equal(await laptop.page.$$eval('.apps li.has-count [data-app="mail"]', l => l.length), 0);
assert.deepEqual([...laptop.errors, ...phone.errors], []);
console.log('seen-check: ok');
await browser.close(); server.close();
