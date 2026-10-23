#!/usr/bin/env node
// The desk phone takes a card that changed (hq rewrite) for a new one: HQ rings, the badge turns red again and the card
// comes first. Rewritten while the phone is open, the card re-renders in its new place, unless the board is typing.
//   node platform/hq/rewrite-check.mjs
// HQ on its own files with a stand-in /api: /api/requests in the coordinator's order (newest first, a changed card as of
// its change) and /api/seen kept here. A ring is counted by its first note.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';

const server = await serve(), base = `http://localhost:${server.address().port}`;
const ago = s => new Date(Date.now() - s * 1000).toISOString();
const cards = [
  { id: 1, created: ago(600), agent: 'wren', kind: 'decision', title: 'The shop', body: 'Good now, or more changes?', urgency: 'today' },
  { id: 2, created: ago(300), agent: 'wren', kind: 'decision', title: 'The van', body: 'Red or blue?', urgency: 'today' },
];
const cardTime = c => c.changed || c.created;
const listed = () => [...cards].sort((a, b) => cardTime(b).localeCompare(cardTime(a)));
const rewrite = (id, body) => Object.assign(cards.find(c => c.id === id), { body, changed: new Date().toISOString() });
const marks = {};

const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 420, height: 912 } });
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname, method = r.request().method();
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests') return r.fulfill({ json: listed() });
  if (path === '/api/seen' && method === 'GET') return r.fulfill({ json: { ...marks } });
  if (path === '/api/seen') { const b = r.request().postDataJSON(); if (marks[b.list] == null || b.newest > marks[b.list]) marks[b.list] = b.newest; return r.fulfill({ json: { ...marks } }); }
  if (['/api/gazette', '/api/mail', '/api/review/products'].includes(path)) return r.fulfill({ json: [] });
  return r.fulfill({ status: 404, body: '' });
});
// the ring's first note (audio.js: note(88)), each time it's set
await context.addInitScript(() => {
  window.rings = 0;
  const set = AudioParam.prototype.setValueAtTime;
  AudioParam.prototype.setValueAtTime = function (v, t) { if (Math.abs(v - 440 * 2 ** (19 / 12)) < 0.01) window.rings++; return set.call(this, v, t); };
});
await page.goto(`${base}/?intro=0`);
await until(page, '#loading.gone');
await page.evaluate(() => dispatchEvent(new Event('click')));   // HQ's sound starts with the first tap (audio.js unlock)
await page.waitForTimeout(500);

// a poll, as HQ does it every 20 s (desk.js is the page's own module: same URL, same instance)
const desk = fn => page.evaluate(name => import('/shell/desk.js').then(m => m[name]()), fn);
const poll = () => desk('refreshRequests');
const badge = () => page.$eval('#desk-count', b => ({ n: Number(b.dataset.n), read: b.classList.contains('read') }));
const shown = async () => ({ title: await page.textContent('#phone-screen h3'), place: await page.textContent('.pager [data-list]'),
  text: await page.textContent('#phone-screen article') });
const rang = async (before, why) => { await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.rings) - before, 4, why); };
const rings = () => page.evaluate(() => window.rings);

assert.deepEqual(await badge(), { n: 2, read: false }, 'two cards the board has not seen: red');
await desk('openPhone'); await page.waitForSelector('#phone-screen h3');
assert.equal((await shown()).title, 'The van', 'the newest card first');
assert.deepEqual(await badge(), { n: 2, read: false }, 'the newest card shown, the other not yet: still red');
await page.click('[data-step="1"]');
await page.click('[data-close]');
assert.deepEqual(await badge(), { n: 2, read: true }, 'both seen on the phone: grey');

// rewritten while the phone is closed: it rings, the badge is red again, and the card comes first with its new text
let before = await rings();
rewrite(1, 'Good now? The new header is live.'); await poll();
await rang(before, 'a changed card rings like a new one');
assert.deepEqual(await badge(), { n: 2, read: false }, 'a changed card is unread again');
before = await rings(); await poll(); await page.waitForTimeout(300);
assert.equal(await rings(), before, 'the same list again rings nothing');
await desk('openPhone'); await page.waitForSelector('#phone-screen h3');
let now = await shown();
assert.deepEqual([now.title, now.place], ['The shop', '1 of 2']);
assert.match(now.text, /The new header is live/);
assert.deepEqual(await badge(), { n: 2, read: true });

// rewritten while the board types an answer on the phone: nothing re-renders, the answer stays, the badge turns red
await page.fill('#answer', 'Half an answer');
before = await rings();
rewrite(2, 'Red, blue or green?'); await poll();
await rang(before, 'it rings while the phone is open too');
assert.equal(await page.inputValue('#answer'), 'Half an answer');
assert.equal((await shown()).title, 'The shop');
assert.deepEqual(await badge(), { n: 2, read: false });
// the answer emptied and left: the phone catches up, the changed card first
await page.fill('#answer', ''); await page.locator('#answer').blur();
now = await shown();
assert.deepEqual([now.title, now.place], ['The van', '1 of 2']);
assert.match(now.text, /green/);
assert.deepEqual(await badge(), { n: 2, read: true });

// rewritten while the phone is open and nobody types: it re-renders at once, in its new place
rewrite(1, 'Good now? Prices fixed too.'); await poll();
now = await shown();
assert.deepEqual([now.title, now.place], ['The shop', '1 of 2']);
assert.match(now.text, /Prices fixed too/);
await page.click('[data-close]');

// a card changed, then a new one filed after it: the phone opens on the new one, and the changed one keeps the badge red
// until it's shown too
rewrite(2, 'Red, blue, green or yellow?');
cards.push({ id: 3, created: new Date(Date.now() + 1000).toISOString(), agent: 'wren', kind: 'decision', title: 'The sign', body: 'Wood or metal?', urgency: 'today' });
await poll();
await desk('openPhone'); await page.waitForSelector('#phone-screen h3');
assert.equal((await shown()).title, 'The sign');
assert.deepEqual(await badge(), { n: 3, read: false }, 'the changed card not shown yet: red');
await page.click('[data-step="1"]');
now = await shown();
assert.deepEqual([now.title, now.place], ['The van', '2 of 3']);
assert.deepEqual(await badge(), { n: 3, read: true }, 'every card shown: grey');

assert.deepEqual(errors, []);
await browser.close(); server.close();
console.log('rewrite-check: a changed card rings, is unread again and comes first; grey once every card is shown; a half-typed answer is kept');
