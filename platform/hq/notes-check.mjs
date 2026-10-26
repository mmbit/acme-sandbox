#!/usr/bin/env node
// Pinned notes don't get forgotten: the computer's button counts the notes waiting, the viewer's Send button counts every
// note waiting on the product (from before this sitting too) and opens Reviews at the product, and a send there goes back
// to the preview. It ticks no note: the board ticks the ones it recognises. A tick left from an earlier send step is gone
// when a new one opens, and a send of some of the notes keeps the viewer's Send for the rest. A note discarded in Reviews
// no longer counts on it. Pinning puts nothing over the page (no message, no "Send from HQ"), and the viewer's bar stays
// one slim row on a phone. Review mode's own Send my notes opens the same send step in the frame (a page asking for it
// gets no more: nothing ticked, nothing sent), whatever HQ has open under the viewer and after a late goodbye (or, the
// computer holding something typed, brings that up), and in a tab of its own HQ's Reviews at those notes. My notes is a
// sidebar: a dozen notes with their screenshots, loaded as the list scrolls, on a phone and a desktop, in the frame and
// in a tab; Change and Delete there; Escape and its button close it. Shift + drag draws a rectangle, a circle in every
// other way, and Change brings a note's mark back on its page, to draw again. HQ itself always has the same tool, its
// notes go into the board's book; while the viewer shows a preview, only the preview's pin shows. Every line of the menu fits on one line on a phone.
//   node platform/hq/notes-check.mjs [--shots dir]
// (Send my notes over a tool, after a late goodbye)
// First HQ in dev mode, then with a fake /api and a product preview played by Playwright at
// https://hello.preview.test running the real shared/review/review.js, its shadow root forced open.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage, until } from '../../shared/browser/browser.mjs';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { wrappedMenuLines } from '../../shared/review/lines.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve(), base = `http://localhost:${server.address().port}`;
const org = await (await fetch(`${base}/mock/org.json`)).json();
const ceo = org.departments.flatMap(d => d.agents).find(a => a.id === org.company.ceo);
const PRODUCT = 'https://hello.preview.test';
const reviewJs = (await readFile(`${ROOT}/shared/review/review.js`, 'utf8')).replace('{{HQ_ORIGIN}}', base);
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hello</title>
  <style>body { font: 18px system-ui; margin: 24px; } h1 { margin-top: 80px; }</style>
  <h1>Hello, whoever you are</h1><p>A little card for a friend.</p><script src="/__review/review.js" defer></script>`;

// ---- the coordinator, played: products, notes, sends
const OWNERS = { hello: ['Hello', 'bolt', 'Bolt'], 'pebble-pals': ['Pebble Pals', 'wren', 'Wren'] };
let lastId = 0;
const note = (slug, text, status = 'pending') => ({ id: ++lastId, created: new Date().toISOString(), slug, page: '/', note: text, element: { v: 1, url: `${PRODUCT}/`, el: { tag: 'h1', selector: 'h1', text: 'Hello' }, ink: [], kind: 'pin', area: null },
  viewport: {}, trail: [], shot: false, status, job: null });
const notes = [note('hello', 'An older note on the headline'), note('pebble-pals', 'The pebble could wiggle'), note('hello', 'Already sent', 'sent')];
const sends = [], photos = new Map(), edits = [];   // a note's id → its screenshot, as review mode sent it
const products = () => Object.entries(OWNERS).map(([slug, [name, owner, ownerName]]) => {
  const count = status => notes.filter(n => n.slug === slug && n.status === status).length;
  return { slug, name, owner, ownerName, pending: count('pending'), sent: count('sent'), discarded: count('discarded') };
});
const waiting = () => notes.filter(n => n.status === 'pending').length;

const browser = await playwright().chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });   // (a call)
// The foundation's mock has the pending Hello notes this send needs, regardless of the company's theme/hq/mock.
// In dev mode (no /api), sending them names the job: by its number, until its agent names the task (hq code).
{
  const dev = await openPage(browser, { viewport: { width: 390, height: 844 } });
  await dev.context.route(`${base}/mock/*.json`, async r => r.fulfill({ contentType: 'application/json',
    body: await readFile(`${ROOT}/platform/hq${new URL(r.request().url()).pathname}`) }));
  await dev.page.goto(`${base}/?intro=0&renderer=wire`);
  await until(dev.page, '#loading.gone');
  await dev.page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('notes')));
  const group = dev.page.locator('section.notes[data-slug=hello]');
  await group.locator('[data-all]').click();
  await group.locator('[data-send]').click();
  await until(dev.page, '.toast:last-child', /job #\d+/);
  assert.deepEqual(dev.errors, []);
  await dev.context.close();
}
const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
  permissions: ['microphone'] });   // (a call)
await context.addInitScript(() => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (o) { return a.call(this, { ...o, mode: 'open' }); }; });
await context.route(`${base}/api/**`, async r => {
  const url = new URL(r.request().url()), path = url.pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests' || path === '/api/gazette') return r.fulfill({ json: [] });
  if (path === '/api/language') return r.fulfill({ json: { lang: 'en', languages: [{ code: 'en', own: 'English' }] } }); // (a call reads it before it dials, Settings shows it)
  if (path === '/api/preview/link') return r.fulfill({ json: { url: r.request().postDataJSON().url } });
  if (path === '/api/review/products') return r.fulfill({ json: products() });
  if (path === '/api/review/shares') return r.fulfill({ json: [] });   // (no outside links: shares-check.mjs has those)
  // (or with ?pic= a picture added to it, and the notes listed with their pictures' names)
  const pic = url.searchParams.get('pic'), picture = pic && notes.find(n => n.id === +url.searchParams.get('id'))?.pictures?.find(p => p.file === pic);
  if (path === '/api/review/shot' && pic) return picture ? r.fulfill({ contentType: picture.data.slice(5, picture.data.indexOf(';')), body: Buffer.from(picture.data.split(',')[1], 'base64') }) : r.fulfill({ status: 404, body: '' });
  if (path === '/api/review/shot') return r.fulfill({ contentType: 'image/jpeg', body: Buffer.from(photos.get(+url.searchParams.get('id')).split(',')[1], 'base64') });
  if (path === '/api/review/notes') return r.fulfill({ json: notes.filter(n => n.slug === url.searchParams.get('slug')).toReversed().map(n => ({ ...n, pictures: n.pictures?.map(p => p.file) })) });
  if (path === '/api/review/send') {
    const body = r.request().postDataJSON(), batch = notes.filter(n => n.slug === body.slug && n.status === 'pending' && body.ids.includes(n.id));
    sends.push(body); batch.forEach(n => Object.assign(n, { status: 'sent', job: 99 }));
    return r.fulfill({ json: { job: 99, job_code: null, agent: ceo.id, name: ceo.name, count: batch.length } });   // (the CEO routes them)
  }
  if (path === '/api/review/discard') {
    const body = r.request().postDataJSON(), batch = notes.filter(n => n.status === 'pending' && body.ids.includes(n.id));
    batch.forEach(n => { n.status = 'discarded'; });
    return r.fulfill({ json: { ok: true, count: batch.length } });
  }
  return r.fulfill({ status: 404, body: '' });
});
await context.route(`${PRODUCT}/**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (fulfilPart(r, path, reviewJs)) return;
  if (path === '/__review/notes') {
    const posted = r.request().postDataJSON(), added = note('hello', posted.note);
    if (posted.shot) { Object.assign(added, { element: posted.element, viewport: posted.viewport, shot: true }); photos.set(added.id, posted.shot); }
    added.seen = 'Chrome 141 on Linux, desktop, screen 390×844, window 390×844, pixel ratio 2'; // the coordinator's seenOn
    if (posted.element?.kind === 'general') Object.assign(added, { element: { v: 1, url: posted.page, el: null, ink: [], kind: 'general', area: null }, posted });
    if (posted.pictures?.length) Object.assign(added, { posted, pictures: pictured(added.id, posted.pictures) });
    notes.push(added);
    return r.fulfill({ json: { ok: true, id: added.id } });
  }
  // the board's notes waiting on the product, as review mode's menu reads and changes them; ?shots: with each one's
  // screenshot, Reviews' own link on HQ's host
  const waiting = () => notes.filter(n => n.slug === 'hello' && n.status === 'pending');
  if (path === '/__review/mine') {
    const withShots = new URL(r.request().url()).searchParams.has('shots');
    // (as feedback.ts mine() gives them: the anchor, and what frames the screenshot)
    const markOf = ({ element: e }) => e.kind === 'general' ? null : { v: e.v, url: e.url, el: e.el, view: e.view, ink: e.ink, kind: e.kind, area: e.area };
    const list = waiting().map(n => ({ id: n.id, note: n.note, page: n.page, kind: n.element.kind, text: n.element.el?.text ?? '',
      ...(withShots ? { here: true, mark: markOf(n), shot: n.shot ? { url: `${base}/api/review/shot?id=${n.id}`, mark: { kind: n.element.kind, area: n.element.area, el: n.element.el && { box: n.element.el.box }, view: n.element.view } } : null,
        pictures: (n.pictures ?? []).map(p => ({ file: p.file, url: `${base}/api/review/shot?id=${n.id}&pic=${p.file}` })) } : {}) }));   // (pictures)
    return r.fulfill({ json: { notes: list.length, list, sent: false, more: false } });
  }
  if (path === '/__review/edit' || path === '/__review/delete') {
    const body = r.request().postDataJSON(), { id, note: words } = body, n = waiting().find(x => x.id === id);
    if (!n) return r.fulfill({ status: 404, json: { error: 'not a note of yours still to go' } });
    Object.assign(n, path.endsWith('edit') ? { note: words } : { status: 'discarded' });
    if (path.endsWith('edit')) edits.push(body);
    if (body.element) { Object.assign(n, { element: body.element, viewport: body.viewport }); if (body.shot) photos.set(n.id, body.shot); }   // (a mark drawn again)
    if (body.pictures) n.pictures = pictured(n.id, body.pictures, n.pictures);
    return r.fulfill({ json: { ok: true } });
  }
  return r.fulfill({ contentType: 'text/html', body: PAGE });
});
const pendingHello = () => notes.filter(n => n.slug === 'hello' && n.status === 'pending').length;
// A note's pictures as the coordinator keeps them: the ones a change keeps by name, new ones (data URLs) under a name of
// their own
let pictureNames = 0;
const pictured = (id, list, had = []) => list.map(p => had.find(q => q.file === p)
  ?? { file: `${id}-p-${++pictureNames}.${p.startsWith('data:image/png') ? 'png' : 'jpg'}`, data: p });

// a stand-in voice line for Reviews' Call
const hellos = [];
await context.routeWebSocket(/\/voice\/ws$/, ws => ws.onMessage(m => {
  if (typeof m !== 'string') return; // (the microphone)
  const e = JSON.parse(m);
  if (e.agent) { hellos.push(e); ws.send(JSON.stringify({ type: 'call', id: 'line', call: 7, key: 'k' })); ws.send(JSON.stringify({ type: 'state', state: 'listening' })); }
}));
const shot = async (name, on = page) => { if (shots) await on.screenshot({ path: `${shots}/${name}.png` }); };
await page.goto(`${base}/?intro=0`);
await until(page, '#loading.gone');

// ---- the badge: the notes waiting, every product's, on the computer's button and on the Reviews icon
const badge = sel => page.$eval(sel, b => b.hidden ? 0 : Number(b.dataset.n));
await page.waitForFunction(() => !document.querySelector('#computer-count').hidden, null, { timeout: 10_000 });
assert.equal(await badge('#computer-count'), 2, 'the computer\'s button counts every product\'s waiting notes');
await shot('hud-badge');
await page.click('#btn-computer');
await page.waitForSelector('[data-app=notes] + .count');
assert.equal(await badge('[data-app=notes] + .count'), 2, 'the Reviews icon shows the same count');
// in a look, round like the computer button's (icons.css); the pixel screen squares its own (style.css)
const corner = (p, sel) => p.$eval(sel, b => getComputedStyle(b).borderTopLeftRadius);
const look = await page.context().newPage();
await look.goto(`${base}/?intro=0&renderer=wire`);
await until(look, '#loading.gone');
await look.waitForFunction(() => !document.querySelector('#computer-count').hidden, null, { timeout: 10_000 });
await look.click('#btn-computer');
await look.waitForSelector('[data-app=notes] + .count');
assert.equal(await corner(look, '[data-app=notes] + .count'), await corner(look, '#computer-count'), 'round, like the computer button\'s');
await look.close();
await page.click('[data-close]');

// ---- the viewer: pin a note in the frame, and the bar's Send button opens the send step
const ticks = () => page.$$eval('section.notes', ss => Object.fromEntries(ss.map(s => [s.dataset.slug, [...s.querySelectorAll('[data-note]')].map(b => [+b.dataset.note, b.checked])])));
await page.evaluate(href => { const a = document.createElement('a'); a.href = href; a.textContent = 'preview'; document.body.append(a); a.click(); a.remove(); }, `${PRODUCT}/`);
await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
let frame = page.frame({ url: `${PRODUCT}/` });
// the notes the viewer's Send button counts (0 while it's hidden): every note waiting on the product
const toSend = () => page.$eval('#viewer .bar .send', b => b.hidden ? 0 : Number(b.textContent.match(/\d+/)[0]));
const sendCountsAll = async what => {
  await page.waitForFunction(n => { const b = document.querySelector('#viewer .bar .send'); return (b.hidden ? 0 : Number(b.textContent.match(/\d+/)[0])) === n; },
    pendingHello(), { timeout: 10_000 }).catch(() => {});
  assert.equal(await toSend(), pendingHello(), what);
};
await sendCountsAll('the note waiting from before this sitting counts on the bar\'s Send');
assert.equal(pendingHello(), 1);
// a framed preview (frame.js) shows the whole mark: scaled with the img, it falls inside the img's box
const showsMark = (img, mark, viewportWidth) => img.evaluate((img, [mark, viewportWidth]) => {
  const scale = img.offsetWidth / viewportWidth, box = img.offsetParent;
  const left = img.offsetLeft + mark.x * scale, top = img.offsetTop + mark.y * scale;
  return img.classList.contains('framed') && left >= -1 && top >= -1 && left + mark.w * scale <= box.clientWidth + 1 && top + mark.h * scale <= box.clientHeight + 1;
}, [mark, viewportWidth]);
async function pinNote(where, text, startPin, mouse = page.mouse) {
  await startPin();
  await where.waitForSelector('review-mode .veil:not([hidden])');
  const h1 = await where.locator('h1').boundingBox();
  await mouse.click(h1.x + 40, h1.y + h1.height / 2);
  await where.waitForSelector('review-mode .sheet:not([hidden])');
  await where.fill('review-mode textarea', text);
  const [pinned, viewportWidth] = await where.evaluate(() => { const r = document.querySelector('h1').getBoundingClientRect(); return [{ x: r.x, y: r.y, w: r.width, h: r.height }, innerWidth]; });
  const polaroid = where.locator('review-mode .polaroid .img :is(img, canvas)');
  await polaroid.waitFor();
  assert.ok(await showsMark(polaroid, pinned, viewportWidth), 'the polaroid is framed on the pinned headline');
  const count = () => document.querySelector('review-mode').shadowRoot.querySelector('.count').textContent;
  const was = await where.evaluate(count);
  await where.click('review-mode .send');
  // pinned: the pin counts it
  await where.waitForFunction(`(${count})() !== ${JSON.stringify(was)}`, null, { timeout: 20_000 });
}
// nothing of review mode's covers the page after a pin: only its pin (the dock) is there
const overPage = where => where.evaluate(() => [...document.querySelector('review-mode').shadowRoot.querySelectorAll('.ui > *')]
  .filter(el => !el.hidden && !el.classList.contains('dock') && !(el.localName === 'canvas' && !el.getContext('2d').getImageData(0, 0, el.width, el.height).data.some(v => v)) && getComputedStyle(el).display !== 'none' && getComputedStyle(el).opacity !== '0' && el.getBoundingClientRect().height > 0)
  .map(el => el.className));
await pinNote(frame, 'Make the headline warmer', () => page.click('#viewer .bar .pin'));
await sendCountsAll('the pinned note counts too');
assert.equal(await toSend(), 2);
await page.waitForTimeout(600);   // (where a message would have come up)
assert.deepEqual(await overPage(frame), [], 'nothing comes up over the page after a pin');
const fits = await page.$eval('#viewer .bar', bar => [...bar.children].filter(c => !c.hidden).every(c => c.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5));
assert.ok(fits, 'the bar with Send still fits a phone');
assert.ok(await page.$eval('#viewer .bar', b => b.getBoundingClientRect().height <= 40), 'the bar is one slim row');
await shot('viewer-send');
const mine = notes.find(n => n.note === 'Make the headline warmer').id;
const minesMark = notes.find(n => n.id === mine);
// the note keeps the screen, beside the window, and the touch points
assert.deepEqual([minesMark.viewport.sw, minesMark.viewport.sh, minesMark.viewport.touch > 0], [390, 844, true]);
const nothingTicked = async () => Object.values(await ticks()).flat().every(([, on]) => !on);

await page.click('#viewer .bar .send');
await page.waitForSelector('section.notes.wanted [data-send]');
assert.match(await page.textContent('.device header b'), /Reviews/);
assert.ok(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('#tool')), 'the computer is over the viewer');
assert.ok(await nothingTicked(), 'nothing is ticked, the older note and the one just pinned alike');
const thumbnail = page.locator(`li.pending:has([data-note="${mine}"]) .shot img`);
await thumbnail.waitFor();
const onScreen = ({ el: { box }, view }) => ({ ...box, x: box.x - view.x, y: box.y - view.y });   // (the anchor's document px)
assert.ok(await showsMark(thumbnail, onScreen(minesMark.element), minesMark.viewport.w), "the note's thumbnail is framed on the pinned headline");
assert.equal(await page.textContent(`li.pending:has([data-note="${mine}"]) .seen`), minesMark.seen, 'the note says what it was seen on');
assert.ok(await page.$eval('section.wanted [data-send]', b => b.disabled));
await page.click(`[data-note="${mine}"]`);   // the board ticks the note it recognises
assert.equal(await page.textContent('section.wanted [data-send]'), 'Send 1');
await page.waitForTimeout(400);   // (scrolled to the product)
await shot('reviews-ticked');

// a note that arrives during the 15 s refresh stays unticked
const late = note('hello', 'Arrived while the board was reading'); notes.push(late);
await page.waitForSelector(`[data-note="${late.id}"]`, { timeout: 25_000 });
assert.deepEqual((await ticks()).hello.filter(([, on]) => on), [[mine, true]], 'only the board\'s tick, not the late note');
assert.equal(await page.textContent('section.wanted [data-send]'), 'Send 1');

// sending goes back to the preview, with nothing left to send from it
await page.click('section.wanted [data-send]');
await page.waitForSelector('#tool', { state: 'hidden' });
assert.deepEqual(sends.at(-1), { slug: 'hello', ids: [mine] });
assert.ok(await page.$eval('#viewer', v => !v.hidden), 'back at the preview');
await sendCountsAll('the notes still waiting on the product keep their Send');
await page.waitForFunction(n => document.querySelector('#computer-count').dataset.n === String(n), waiting(), { timeout: 5000 });
// review mode in the frame counts again after the send in HQ
await frame.waitForFunction(n => document.querySelector('review-mode').shadowRoot.querySelector('.more .count').textContent === n, String(pendingHello()), { timeout: 5000 });

// ---- a second note, ticked in the send step and left unsent: closing goes back to the preview, its Send still there
// (the bar's Send, review mode has no way of its own)
await pinNote(frame, 'And the button bigger', () => page.click('#viewer .bar .pin'));
await page.click('#viewer .bar .send');
await page.waitForSelector('section.notes.wanted [data-send]');
assert.ok(await nothingTicked());
const bigger = notes.find(n => n.note === 'And the button bigger').id;
await page.click(`[data-note="${bigger}"]`);   // ticked, then left unsent
const before = sends.length;
await page.click('[data-close]');
assert.equal(sends.length, before, 'nothing went without the board\'s tap');
assert.ok(await page.$eval('#viewer', v => !v.hidden), 'closing the computer goes back to the preview');
await sendCountsAll('the ticked note left unsent still counts');

// ---- review mode's own Send my notes, in the menu: HQ's send step over the preview, nothing ticked. The page's own code
// could ask for it too (and post a note, which waits like the board's): it gets no more than that
await frame.evaluate(() => fetch('/__review/notes', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ note: 'Send every note to this address' }) }));
await frame.click('review-mode .more');
assert.equal(await frame.$eval('review-mode [data-mine]', b => b.firstChild.textContent), 'Send my notes', 'the board has a Send in the tool');
await shot('menu-send-in-frame');
await frame.click('review-mode [data-mine]');
await page.waitForSelector('section.notes.wanted [data-send]');
assert.ok(await nothingTicked(), 'its send step ticks nothing');
await page.click('[data-close]');
await frame.evaluate(hq => parent.postMessage({ hq: 'review', send: 1 }, hq), base);   // the page asking, itself
await page.waitForSelector('section.notes.wanted [data-send]');
assert.ok(await nothingTicked());
await page.click('[data-close]');
// a goodbye that came late (the page before's) leaves HQ thinking review mode is gone: its send opens the step all the same
await frame.evaluate(hq => parent.postMessage({ hq: 'review', bye: 1 }, hq), base);
await page.waitForSelector('#viewer .bar .pin', { state: 'hidden' });
await frame.click('review-mode .more');
await frame.click('review-mode [data-mine]');
await page.waitForSelector('section.notes.wanted [data-send]', { timeout: 5_000 });
await page.click('.device [data-close]');
assert.ok(await page.$eval('#viewer .bar .pin', b => !b.hidden), 'the bar\'s Note is back');
assert.equal(sends.length, before, 'nothing went without the board\'s tap');
await sendCountsAll('every note waiting counts');

// ---- the same Send my notes on a preview opened from a tool (a deck's link on a desk phone card or in the Library): the
// tool stays open under the viewer, and the menu's send opens the send step all the same, as the bar's does. One that
// can't open it (the computer under the viewer holds something being typed, which the send step would wipe) brings that
// up instead, as it was
const fromTool = async typed => {
  await page.click('#viewer [data-close]');
  await page.click('#btn-computer');
  await page.waitForSelector('#crt [data-app]');
  await page.$eval('#crt', (el, [href, typed]) => {
    if (typed) { const t = document.createElement('input'); t.className = 'typed'; t.value = typed; el.append(t); }   // (a field being typed in)
    const a = document.createElement('a'); a.href = href; a.textContent = 'preview'; el.append(a); a.click();
  }, [`${PRODUCT}/`, typed]);
  await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
  frame = page.frame({ url: `${PRODUCT}/` });
  await sendCountsAll('the notes waiting count on a preview opened from a tool');
  assert.ok(await page.$eval('#tool', t => !t.hidden), 'the tool is still open under the viewer');
  await frame.click('review-mode .more');
  await frame.click('review-mode [data-mine]');
};
await fromTool('');
await page.waitForSelector('section.notes.wanted [data-send]', { timeout: 5_000 });
assert.ok(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2).closest('#tool')), 'the computer is over the viewer');
assert.ok(await nothingTicked(), 'its send step ticks nothing');
await page.click('.device [data-close]');
assert.ok(await page.$eval('#viewer', v => !v.hidden), 'closing the computer goes back to the preview');
await fromTool('Dear Print API,');
await page.waitForFunction(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('#tool'), null, { timeout: 5_000 });
await shot('menu-send-typing');
assert.equal(await page.$eval('#crt .typed', i => i.value), 'Dear Print API,', 'the computer comes up with what was typed, kept');
assert.equal(await page.locator('section.notes.wanted').count(), 0, 'and no send step over it');
await page.click('.device [data-close]');
await page.click('#viewer [data-close]');
await page.evaluate(href => { const a = document.createElement('a'); a.href = href; a.textContent = 'preview'; document.body.append(a); a.click(); a.remove(); }, `${PRODUCT}/`);
await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
frame = page.frame({ url: `${PRODUCT}/` });
assert.equal(sends.length, before, 'nothing went without the board\'s tap');

// ---- two pinned in this sitting, one sent: Send stays for the other
await pinNote(frame, 'Make the card blue', () => page.click('#viewer .bar .pin'));
await sendCountsAll('a new pin counts');
await page.click('#viewer .bar .send');
await page.waitForSelector('section.notes.wanted [data-send]');
assert.ok(await nothingTicked(), 'a tick left from an earlier send step is gone');
await page.click(`[data-note="${bigger}"]`);
await page.click('section.wanted [data-send]');
await page.waitForSelector('#tool', { state: 'hidden' });
assert.deepEqual(sends.at(-1), { slug: 'hello', ids: [bigger] });
await sendCountsAll('the notes still pending keep their Send');

// ---- two pinned, one discarded in Reviews and the other sent: nothing left to send
const blue = notes.find(n => n.note === 'Make the card blue').id;
await pinNote(frame, 'A softer font', () => page.click('#viewer .bar .pin'));
await sendCountsAll('a new pin counts');
const softer = notes.find(n => n.note === 'A softer font').id;
await page.click('#viewer .bar .send');
await page.waitForSelector(`section.notes.wanted [data-note="${softer}"]`);
await page.click(`[data-note="${blue}"]`);
// asking once more moves nothing on the row
const actsRow = () => page.$$eval('section.wanted .acts button', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [r.left, r.top, r.width].map(Math.round); }));
await page.$eval('.device', d => Promise.all(d.getAnimations().map(a => a.finished)));   // (measured once the device has dropped in)
const unasked = await actsRow();
await page.click('section.wanted [data-discard]');
assert.deepEqual(await actsRow(), unasked, 'the asking Discard keeps the row as it was');
assert.equal(await page.textContent('section.wanted [data-discard]'), 'Sure?', 'the asking Discard asks in a word no wider than its own');
assert.equal(await page.textContent('section.wanted .msg'), 'Tap again to discard 1 note for good.', 'the asking Discard counts the ticked notes and says it lasts');
await page.waitForTimeout(600);   // (askAgain's settling: a tap within 500 ms is the first one's)
await page.click('section.wanted [data-discard]');   // (the second tap does it)
await page.waitForFunction(id => !document.querySelector(`[data-note="${id}"]`), blue, { timeout: 10_000 });
assert.equal(notes.find(n => n.id === blue).status, 'discarded');
assert.equal(await page.locator('section.notes li', { hasText: 'Make the card blue' }).count(), 0, 'a discarded note is gone from Reviews');
await sendCountsAll('the discarded note no longer counts, the ones still pending do');
await page.click(`[data-note="${softer}"]`);
await page.click('section.wanted [data-send]');
await page.waitForSelector('#tool', { state: 'hidden' });
assert.deepEqual(sends.at(-1), { slug: 'hello', ids: [softer] });
await sendCountsAll('the sent note no longer counts');

// ---- outside HQ: a preview in a tab of its own pins without anything over the page, and HQ has no notes link
const tab = await context.newPage();
tab.on('pageerror', e => errors.push(e.message));
await tab.goto(`${PRODUCT}/`);
await pinNote(tab, 'Seen in a browser tab', () => tab.click('review-mode .fab', { force: true }), tab.mouse);
await tab.waitForTimeout(600);
assert.deepEqual(await overPage(tab), [], 'nothing comes up over the page in a tab either');
// the board's general note, from the pin's menu: the same sheet without a photo, pinned to nothing, and Reviews reads it as
// one
const items = () => tab.$$eval('review-mode .menu .items button:not([hidden])', bs => bs.map(b => b.firstChild.textContent));
await tab.click('review-mode .more');
assert.deepEqual(await items(), ['General note', 'My notes', 'Send my notes'], 'the board has a Send in the tool');
assert.equal(await tab.textContent('review-mode .menu .cap'), `Review · ${pendingHello()} notes to send`);
// every line of it on one line on a phone: the count only in the caption, a sub-line only what its title doesn't say
const subs = () => tab.$$eval('review-mode .menu .items button:not([hidden]) small', s => s.map(x => x.textContent));
assert.deepEqual(await subs(), ['About it all, not one spot', 'Read, change or delete', 'Tick and send in HQ']);
assert.deepEqual(await tab.evaluate(wrappedMenuLines), [], 'no line of the menu wraps on a phone');
assert.equal(await tab.textContent('review-mode .more .count'), String(notes.filter(n => n.slug === 'hello' && n.status === 'pending').length), "the count is the board's notes waiting on the product");
await shot('menu', tab);
await tab.click('review-mode [data-general]');
await tab.waitForSelector('review-mode .sheet:not([hidden])');
assert.equal(await tab.textContent('review-mode .who h2'), 'A general note');
assert.ok(await tab.isHidden('review-mode .polaroid'));
await tab.fill('review-mode textarea', 'The pages greet in two different ways');
await shot('general-note', tab);
await tab.click('review-mode .send');
await tab.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
const general = notes.find(n => n.note === 'The pages greet in two different ways');
await tab.waitForFunction(n => document.querySelector('review-mode').shadowRoot.querySelector('.more .count').textContent === n, String(notes.filter(n => n.slug === 'hello' && n.status === 'pending').length));
const { kind, el, ink: lines, area } = general.posted.element;
assert.deepEqual([{ kind, el, lines, area }, general.posted.shot, general.posted.page], [{ kind: 'general', el: null, lines: [], area: null }, null, `${PRODUCT}/`]);
// My notes: the sidebar, every note with its screenshot (a general note has none), the words in full and the page; the
// board changes one's words there, and deletes another (two taps: discarded, as in HQ)
const tabNote = notes.find(n => n.note === 'Seen in a browser tab');
const side = async where => {
  await where.click('review-mode .more');
  await where.click('review-mode [data-list]');
  await where.waitForSelector('review-mode .side:not([hidden]) li');
  // (once it has slid in)
  return where.$eval('review-mode .side', async el => { await Promise.all(el.getAnimations().map(a => a.finished)); const r = el.getBoundingClientRect(); return [r.left, r.right, innerWidth]; });
};
const entries = where => where.$$eval('review-mode .side li', ls => ls.map(l => ({ words: l.querySelector('.words')?.textContent, where: l.querySelector('.where')?.textContent,
  shot: l.querySelector('.shot img')?.src ?? null, loaded: (l.querySelector('.shot img')?.naturalWidth ?? 0) > 0, framed: !!l.querySelector('.shot img.framed') })));
await tab.setViewportSize({ width: 1280, height: 800 });
const [left, right, width] = await side(tab);
assert.ok(right === width && left > width / 2, `a sidebar on the right of a desktop (${left}–${right} of ${width})`);
assert.ok(await tab.isHidden('review-mode .dock'), 'the pin steps aside while it is open');
assert.match(await tab.textContent('review-mode .side .cap'), /^My notes · \d+ to send$/);
await tab.waitForFunction(() => [...document.querySelector('review-mode').shadowRoot.querySelectorAll('.side .shot img')].slice(0, 1).every(i => i.naturalWidth > 0), null, { timeout: 10_000 });
const listed = await entries(tab);
const pinnedEntry = listed.find(e => e.words === 'Seen in a browser tab'), generalEntry = listed.find(e => e.words === 'The pages greet in two different ways');
assert.ok(pinnedEntry && generalEntry, JSON.stringify(listed));
assert.equal(pinnedEntry.shot, `${base}/api/review/shot?id=${tabNote.id}`, "its screenshot comes from HQ's host, not the product's");
assert.ok(pinnedEntry.loaded && pinnedEntry.framed, 'the screenshot is there, framed on the mark');
assert.equal(pinnedEntry.where, 'On “Hello, whoever you are” · /');
assert.deepEqual([generalEntry.shot, generalEntry.where], [null, 'General note · written on /'], 'a general note has no screenshot');
await shot('my-notes-desktop', tab);
// a tap on a screenshot shows it bigger; Escape puts it away, then the sidebar
await tab.click(`review-mode .side li:has-text("Seen in a browser tab") .shot`);
await tab.waitForSelector('review-mode .zoom:not([hidden])');
assert.ok(await tab.$eval('review-mode .zoom img', i => { const r = i.getBoundingClientRect(); return i.naturalWidth > 0 && r.height > innerHeight / 2 && r.top >= 0 && r.bottom <= innerHeight; }), 'the whole screen, bigger, and all of it in view');
await shot('my-notes-zoom', tab);
await tab.keyboard.press('Escape');
assert.ok(await tab.isHidden('review-mode .zoom') && await tab.isVisible('review-mode .side'), 'Escape puts the picture away first');
// Change: the note's own sheet (a general note's without a photo or a mark), and Save goes back to My notes
await tab.click('review-mode .side li:has-text("The pages greet") button:has-text("Change")');
await tab.waitForSelector('review-mode .sheet:not([hidden])');
assert.ok(await tab.isHidden('review-mode .side') && await tab.isHidden('review-mode .redraw') && await tab.isHidden('review-mode .polaroid'));
assert.equal(await tab.inputValue('review-mode .sheet textarea'), 'The pages greet in two different ways');
assert.equal(await tab.textContent('review-mode .send'), 'Save');
await tab.fill('review-mode .sheet textarea', 'The pages greet in two different ways: pick one');
await tab.click('review-mode .send');
await tab.waitForSelector('review-mode .side:not([hidden]) .words:has-text("pick one")');
assert.equal(general.note, 'The pages greet in two different ways: pick one');
assert.equal(edits.at(-1).element, undefined, 'words alone');
// Delete, two taps
const del = 'review-mode .side li:has-text("Seen in a browser tab") button:has-text("Delete")';
await tab.click(del);
assert.equal(await tab.textContent('review-mode .side li:has-text("Seen in a browser tab") .acts .sure'), 'Tap again to delete');
assert.equal(tabNote.status, 'pending', 'the first tap only asks');
await tab.click('review-mode .side li:has-text("Seen in a browser tab") .acts .sure');
await tab.waitForSelector('review-mode .side li:has-text("Seen in a browser tab")', { state: 'detached' });
assert.equal(tabNote.status, 'discarded');
await tab.waitForFunction(n => document.querySelector('review-mode').shadowRoot.querySelector('.more .count').textContent === n, String(pendingHello()));
await tab.click('review-mode .side .x');
assert.ok(await tab.isHidden('review-mode .side') && await tab.isVisible('review-mode .fab'), 'its button closes it, and the pin is back');

// ---- Shift + drag draws a rectangle: its four corners are the line (the pen's, ink.js), and the note is a circle's in
// every other way. Without Shift, the freehand line. Change brings the mark back on the element, Redraw marks it again
// (Escape there puts the sheet back), and a note pinned on another page opens that page first
// (the ink on screen: how much of it, and whether there's some within 5 px of a point.)
const ink = () => tab.$eval('review-mode', h => { const c = h.shadowRoot.querySelector('.ink'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.filter((v, i) => i % 4 === 3 && v > 128).length; });
const inkNear = ([x, y]) => tab.$eval('review-mode', (h, [x, y]) => {
  const c = h.shadowRoot.querySelector('.ink'), k = c.width / c.getBoundingClientRect().width;
  return c.getContext('2d').getImageData(Math.round((x - 5) * k), Math.round((y - 5) * k), Math.round(10 * k), Math.round(10 * k)).data.some((v, i) => i % 4 === 3 && v > 128);
}, [x, y]);
const inkOn = async points => (await Promise.all(points.map(inkNear))).every(Boolean);
async function draw(points, shift = false) {
  await tab.waitForSelector('review-mode .veil:not([hidden])');
  if (shift) await tab.keyboard.down('Shift');
  await tab.mouse.move(...points[0]); await tab.mouse.down();
  for (const p of points.slice(1)) await tab.mouse.move(...p, { steps: 3 });
  const drawn = await tab.$eval('review-mode', h => { const c = h.shadowRoot.querySelector('.wet'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v); });
  await tab.mouse.up(); if (shift) await tab.keyboard.up('Shift');
  await tab.waitForSelector('review-mode .sheet:not([hidden])');
  return drawn;
}
const pinIt = async words => { await tab.fill('review-mode .sheet textarea', words); await tab.click('review-mode .send'); await tab.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 }); };
const para = await tab.locator('body > p').boundingBox(), head = await tab.locator('body > h1').boundingBox();
const [x0, y0, x1, y1] = [Math.round(para.x - 12), Math.round(para.y - 10), Math.round(para.x + 300), Math.round(para.y + para.height + 10)];
await tab.click('review-mode .fab', { force: true });
const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], edges = [[(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2]];
assert.ok(await draw([[x0, y0], [x0 + 100, y0 + 30], [x1, y1]], true), 'a rectangle while it is dragged');
assert.ok(await inkOn(edges) && !(await inkNear([(x0 + x1) / 2, (y0 + y1) / 2])), 'and once it is drawn');
await pinIt('Box this line');
const boxed = notes.find(n => n.note === 'Box this line');
assert.equal(boxed.element.kind, 'circle', 'a circle to everyone who reads the note');
assert.deepEqual(boxed.element.ink[0].points.map(p => p.slice(0, 2)), [...corners, corners[0]]);
assert.deepEqual(boxed.element.area, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
const oval = n => Array.from({ length: n }, (_, i) => [Math.round(head.x + 150 + 190 * Math.cos(i / n * 2 * Math.PI)), Math.round(head.y + head.height / 2 + 45 * Math.sin(i / n * 2 * Math.PI))]);
await tab.click('review-mode .fab', { force: true });
await draw(oval(16));
await pinIt('Circle the headline');
const circled = notes.find(n => n.note === 'Circle the headline');
assert.ok(circled.element.kind === 'circle' && circled.element.ink[0].points.length >= 16, 'without Shift, the freehand line');
// Change: the rectangle back where it was, on its element
await side(tab);
await tab.click('review-mode .side li:has-text("Box this line") button:has-text("Change")');
await tab.waitForSelector('review-mode .sheet:not([hidden])');
assert.ok(await tab.isHidden('review-mode .side'), 'the sidebar steps aside');
assert.equal(await tab.inputValue('review-mode .sheet textarea'), 'Box this line');
await tab.waitForFunction(() => { const c = document.querySelector('review-mode').shadowRoot.querySelector('.ink'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v); });
assert.ok(await inkOn(edges), 'the rectangle is back around the line');
await shot('change-rectangle', tab);
// Redraw: Escape puts the sheet back as it was; then a circle around the headline replaces it
await tab.click('review-mode .redraw');
await tab.waitForSelector('review-mode .veil:not([hidden])');
assert.ok(await tab.isHidden('review-mode .sheet') && !(await ink()), 'the sheet and the old mark step aside');
await tab.keyboard.press('Escape');
await tab.waitForSelector('review-mode .sheet:not([hidden])');
assert.ok(await inkOn(edges) && await tab.inputValue('review-mode .sheet textarea') === 'Box this line', 'Escape: the sheet and the mark as they were');
await tab.click('review-mode .redraw');
await draw(oval(20));
assert.ok(await ink() > 100 && await inkOn(oval(20).slice(0, 1)), 'the new circle stays on the page with the sheet');
await tab.locator('review-mode .polaroid .img :is(img, canvas)').waitFor();
await tab.fill('review-mode .sheet textarea', 'Circle this headline instead');
await tab.click('review-mode .send');
await tab.waitForSelector('review-mode .side:not([hidden]) .words:has-text("Circle this headline instead")', { timeout: 20_000 });
const redrawn = edits.at(-1);
assert.ok(redrawn.element.kind === 'circle' && redrawn.element.ink[0].points.length >= 20 && redrawn.shot?.startsWith('data:image/jpeg') && redrawn.page === `${PRODUCT}/`, 'the new mark goes with its screenshot');
assert.ok(await tab.isHidden('review-mode .sheet') && !(await ink()), 'saved: back to My notes, no mark left on the page');
// a note pinned on another page: Change opens that page, then its sheet and its mark there
const away = note('hello', 'On the other page'); Object.assign(away, { page: '/elsewhere?x=1', element: circled.element, viewport: circled.viewport }); notes.push(away);
await tab.keyboard.press('Escape');
await side(tab);
await Promise.all([tab.waitForURL(`${PRODUCT}/elsewhere?x=1`), tab.click('review-mode .side li:has-text("On the other page") button:has-text("Change")')]);
await tab.waitForSelector('review-mode .sheet:not([hidden])', { timeout: 10_000 });
assert.equal(await tab.inputValue('review-mode .sheet textarea'), 'On the other page');
await tab.waitForFunction(() => { const c = document.querySelector('review-mode').shadowRoot.querySelector('.ink'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some(v => v); });
assert.ok(await inkOn([oval(16)[0], oval(16)[4], oval(16)[12]]), 'its circle on that page');
await tab.click('review-mode [data-cancel]');
await tab.waitForSelector('review-mode .side:not([hidden])');
await tab.keyboard.press('Escape');
assert.ok(await tab.isVisible('review-mode .fab'), 'Never mind… goes back to My notes, Escape closes it');

// ---- a dozen notes: one scrolling list, the screenshots loaded as it scrolls, on a desktop and on a phone, in a tab and in
// HQ's frame
const photo = [...photos.values()][0];
for (let i = 1; i <= 12; i++) {
  const n = note('hello', `Dozen note ${i}: ${'a few more words to make it wrap onto a second line '.repeat(i % 3)}`);
  Object.assign(n, { element: minesMark.element, viewport: minesMark.viewport, shot: true }); photos.set(n.id, photo); notes.push(n);
}
async function dozen(where, what) {
  const on = typeof where.page === 'function' ? where.page() : where;   // (a frame's page)
  await side(where);
  // (the screenshots asked for: review.js gives each its src as it comes near the view; the page may show one it has
  // already without asking HQ again)
  const asked = () => where.$$eval('review-mode .side li .shot img', i => i.filter(x => x.getAttribute('src')).length);
  const total = await where.$$eval('review-mode .side li .shot', s => s.length);
  assert.ok(total >= 12, `${what}: every note's screenshot in the list (${total})`);
  await where.waitForTimeout(800);
  const first = await asked();
  assert.ok(first > 0 && first < total, `${what}: the first screenshots load at once, the rest wait (${first} of ${total})`);
  await shot(`my-notes-${what}`, on);
  // a phone's sidebar is the whole width
  const [l, r, w] = await where.$eval('review-mode .side', el => { const b = el.getBoundingClientRect(); return [b.left, b.right, innerWidth]; });
  if (w < 560) assert.deepEqual([l, r], [0, w], `${what}: the whole width on a phone`);
  for (let i = 0; i < 40 && (await asked()) < total; i++) {
    await where.$eval('review-mode .side ol', ol => ol.scrollBy(0, 500));
    await where.waitForTimeout(120);
  }
  assert.equal(await asked(), total, `${what}: scrolled to the end, every screenshot loaded`);
  assert.ok(await where.$$eval('review-mode .side li .shot img', i => i.every(x => x.complete && x.naturalWidth > 0)), `${what}: and every one shows`);
  assert.ok(await where.$eval('review-mode .side ol', ol => { ol.scrollTop = ol.scrollHeight; return ol.lastElementChild.getBoundingClientRect().bottom <= Math.min(innerHeight, ol.getBoundingClientRect().bottom) + 1; }),
    `${what}: the last note scrolls into view`);
  await where.waitForTimeout(200);
  await shot(`my-notes-${what}-end`, on);
  await on.keyboard.press('Escape');
  assert.ok(await where.isHidden('review-mode .side'), `${what}: Escape closes it`);
}
await dozen(tab, 'desktop-tab');
await tab.setViewportSize({ width: 390, height: 844 });
await dozen(tab, 'phone-tab');
// Send my notes at the sidebar's foot, in a tab of its own: HQ's Reviews at those notes, in a new tab, nothing ticked
await side(tab);
const [reviews] = await Promise.all([context.waitForEvent('page'), tab.click('review-mode .side footer [data-send]')]);
reviews.on('pageerror', e => errors.push(e.message));
await until(reviews, '#loading.gone');
await reviews.waitForSelector('section.notes.wanted[data-slug=hello] [data-send]', { timeout: 15_000 });
assert.ok(await reviews.$$eval('[data-note]', bs => bs.every(b => !b.checked)), 'nothing ticked');
assert.equal(new URL(reviews.url()).search, '', 'the address is HQ\'s own again');
await shot('reviews-from-tab', reviews);
await reviews.close();
assert.ok(await tab.isHidden('review-mode .side'), 'the sidebar is put away');
await dozen(frame, 'phone-frame');
await page.setViewportSize({ width: 1280, height: 800 });
await dozen(frame, 'desktop-frame');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/?notes=hello`);
await until(page, '#loading.gone');
await page.waitForTimeout(1000);
assert.ok(await page.$eval('#tool', t => t.hidden), 'an old /?notes= link just opens HQ');
// and Reviews from the computer ticks nothing either
await page.click('#btn-computer'); await page.click('[data-app=notes]');
await page.waitForSelector('section.notes [data-send]');
assert.ok(await nothingTicked());
assert.equal(await page.$('section.notes.wanted'), null);
assert.match(await page.textContent(`#rn-${general.id} ~ .dim`), /^General note · /, 'a general note reads as one in Reviews');
assert.equal(await page.textContent(`label[for=rn-${general.id}] b`), 'The pages greet in two different ways: pick one');

// ---- Call next to Send: it rings the group's owner about the ticked notes only, and sends none of them; hanging up
// comes back to Reviews (card #94, call #69.)
const ring = sel => page.$eval(`section.notes[data-slug=hello] ${sel}`, b => [b.textContent, b.disabled]);
assert.deepEqual(await ring('[data-call]'), ['Call Bolt', true], 'Call sits by Send, and needs a tick too');
const waitingHello = await page.$$eval('section.notes[data-slug=hello] [data-note]', bs => bs.map(b => +b.dataset.note));
assert.ok(waitingHello.length >= 2, 'two notes wait on hello');
await page.click(`#rn-${waitingHello[0]}`, { force: true });
assert.deepEqual(await ring('[data-call]'), ['Call Bolt', false]);
await shot('call-by-send');
const sentBefore = sends.length;
await page.click('section.notes[data-slug=hello] [data-call]');
await page.waitForFunction(() => document.querySelector('#call-screen') && !document.querySelector('#call-screen').hidden, null, { timeout: 10_000 });
await page.waitForFunction(() => document.querySelector('#call-state')?.textContent === 'Listening…', null, { timeout: 10_000 });
assert.equal(hellos.length, 1, 'one call');
assert.deepEqual([hellos[0].agent, hellos[0].request, hellos[0].pins], ['bolt', 0, [waitingHello[0]]], "the owner, about the ticked note only");
assert.equal(sends.length, sentBefore, 'starting the call sent nothing');
assert.equal(notes.find(n => n.id === waitingHello[0]).status, 'pending');
await shot('call-about-pins');
await page.click('#call-end');
await page.waitForSelector('section.notes[data-slug=hello] [data-call]', { timeout: 10_000 });
// a note the call answered reads so in its group; one it sent with a job, sent
Object.assign(notes.find(n => n.id === waitingHello[0]), { status: 'sent', job: null, call: 7 });
Object.assign(notes.find(n => n.id === waitingHello[1]), { status: 'sent', job: 98, call: 7 });
await page.click('[data-close]'); await page.click('#btn-computer'); await page.click('[data-app=notes]');
await page.waitForSelector('section.notes[data-slug=hello] .st');
const states = await page.$$eval('section.notes[data-slug=hello] li.old', ls => ls.map(l => [l.querySelector('b').textContent, l.querySelector('.st').textContent]));
assert.ok(states.some(([, st]) => st === 'answered') && states.some(([, st]) => st === 'sent'), JSON.stringify(states));

// ---- pictures of the board's own on a note: a big screenshot pasted, a phone's photo and a sketch dropped, the sketch
// taken off again. Each is scaled down on the device and goes with the note; My notes shows them and a change keeps
// them, Reviews shows them, and hq note saves them, the note sent through the real coordinator
const picturedAt = tab.url();
await tab.click('review-mode .fab', { force: true });
await tab.waitForSelector('review-mode .veil:not([hidden])');
const headline = await tab.locator('h1').boundingBox();
await tab.mouse.click(headline.x + 40, headline.y + headline.height / 2);
await tab.waitForSelector('review-mode .sheet:not([hidden])');
await tab.fill('review-mode textarea', 'Warmer, like these');
// made in the page: a 3000×1800 screenshot (a PNG), a 12-megapixel photo (a JPEG full of grain) and a small sketch
const made = ([width, height, type, name]) => tab.evaluateHandle(async ([width, height, type, name]) => {
  const c = Object.assign(document.createElement('canvas'), { width, height }), g = c.getContext('2d');
  const fill = g.createLinearGradient(0, 0, width, height);
  fill.addColorStop(0, '#ffb36b'); fill.addColorStop(1, '#6b8cff'); g.fillStyle = fill; g.fillRect(0, 0, width, height);
  if (type === 'image/jpeg') {
    const grain = g.getImageData(0, 0, width, height);
    for (let i = 0; i < grain.data.length; i += 4) grain.data[i] ^= (i * 2654435761) >>> 27;
    g.putImageData(grain, 0, 0);
  }
  g.fillStyle = '#222'; g.font = `${Math.round(height / 8)}px sans-serif`; g.fillText(name, width / 10, height / 2);
  return new File([await new Promise(r => c.toBlob(r, type, 0.95))], name, { type });
}, [width, height, type, name]);
const [screenshot, photoFile, sketch] = await Promise.all([[3000, 1800, 'image/png', 'screen.png'], [4032, 3024, 'image/jpeg', 'IMG_2041.jpg'], [300, 200, 'image/png', 'sketch.png']].map(made));
// pasted: Ctrl+V with the screenshot on the clipboard
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PRODUCT });
await tab.evaluate(file => navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]), screenshot);
await tab.focus('review-mode textarea');
await tab.keyboard.press('ControlOrMeta+V');
const thumbs = () => tab.$$eval('review-mode .sheet .pics li', ls => ls.map(l => l.classList.contains('busy') ? 'busy' : l.querySelector('img').naturalWidth > 0 ? 'shown' : 'blank'));
await tab.waitForFunction(() => document.querySelector('review-mode').shadowRoot.querySelectorAll('.sheet .pics li:not(.busy)').length === 1, null, { timeout: 10_000 });
assert.equal(await tab.inputValue('review-mode textarea'), 'Warmer, like these', 'a pasted picture adds nothing to the words');
// dropped: the photo and the sketch, dragged onto the note together (which lights up as they come over it)
const droppedFiles = await tab.evaluateHandle(files => { const d = new DataTransfer(); for (const f of files) d.items.add(f); return d; }, [photoFile, sketch]);
await tab.locator('review-mode .sheet').dispatchEvent('dragover', { dataTransfer: droppedFiles });
assert.ok(await tab.$eval('review-mode .sheet', s => s.classList.contains('taking')), 'the note lights up under a dragged file');
await tab.locator('review-mode .sheet').dispatchEvent('drop', { dataTransfer: droppedFiles });
await tab.waitForFunction(() => document.querySelector('review-mode').shadowRoot.querySelectorAll('.sheet .pics li:not(.busy)').length === 3, null, { timeout: 15_000 });
assert.deepEqual(await thumbs(), ['shown', 'shown', 'shown'], 'three thumbnails under the words');
assert.equal(tab.url(), picturedAt, 'the page stays');
await shot('note-pictures', tab);
// the sketch taken off with its ×
await tab.click('review-mode .sheet .pics li:nth-child(3) .x');
assert.deepEqual(await thumbs(), ['shown', 'shown']);
await tab.click('review-mode .send');
await tab.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
const pictureNote = notes.find(n => n.note === 'Warmer, like these');
const [pastedPicture, droppedPicture] = pictureNote.posted.pictures;
assert.equal(pictureNote.posted.pictures.length, 2, 'the two left on it went with the note');
// each drawn again at most 2,000 px a side, under what the coordinator keeps: the screenshot still a PNG, the photo a JPEG
const sizeOf = data => tab.evaluate(async data => { const i = new Image(); i.src = data; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, data);
assert.deepEqual([pastedPicture.slice(0, 15), await sizeOf(pastedPicture)], ['data:image/png;', [2000, 1200]]);
assert.deepEqual([droppedPicture.slice(0, 16), await sizeOf(droppedPicture)], ['data:image/jpeg;', [2000, 1500]]);
assert.ok(pictureNote.posted.pictures.every(p => p.length < 2_000_000), 'each fits what the coordinator keeps');
// My notes: under the note's words, a tap shows one bigger
await side(tab);
const pictureEntry = `review-mode .side li:has-text("Warmer, like these")`;
await tab.waitForFunction(sel => [...document.querySelector('review-mode').shadowRoot.querySelectorAll('.side li')].find(l => l.textContent.includes(sel))
  ?.querySelectorAll('.pics img').length === 2, 'Warmer, like these', { timeout: 10_000 });
await tab.locator(`${pictureEntry} .pics button`).first().scrollIntoViewIfNeeded();
await tab.waitForFunction(() => [...document.querySelector('review-mode').shadowRoot.querySelectorAll('.side .pics img')].some(i => i.naturalWidth > 0), null, { timeout: 10_000 });
await tab.click(`${pictureEntry} .pics button >> nth=1`);
await tab.waitForSelector('review-mode .zoom:not([hidden])');
assert.match(await tab.$eval('review-mode .zoom img', i => i.src), /&pic=\d+-p-\d+\.jpg$/, 'the photo, bigger');
await shot('my-notes-pictures', tab);
await tab.keyboard.press('Escape');
// Change keeps them, and one taken off there goes
await tab.click(`${pictureEntry} button:has-text("Change")`);
await tab.waitForSelector('review-mode .sheet:not([hidden])');
await tab.waitForFunction(() => [...document.querySelector('review-mode').shadowRoot.querySelectorAll('.sheet .pics img')].filter(i => i.naturalWidth > 0).length === 2, null, { timeout: 10_000 });
await tab.click('review-mode .sheet .pics li:nth-child(1) .x');
await tab.click('review-mode .send');
await tab.waitForSelector('review-mode .side:not([hidden])');
assert.deepEqual(edits.at(-1).pictures, [pictureNote.pictures.at(-1).file], 'the photo kept by its name, the screenshot gone');
assert.equal(pictureNote.pictures.length, 1);
await tab.click('review-mode .side .x');
// Reviews: a small thumbnail under the note's words, and a tap shows it over the screen
await page.click('[data-close]'); await page.click('#btn-computer'); await page.click('[data-app=notes]');
const inReviews = `li.pending:has([data-note="${pictureNote.id}"]) .pics button`;
await page.waitForSelector(inReviews, { timeout: 10_000 });
await page.waitForFunction(sel => [...document.querySelectorAll(`${sel} img`)].every(i => i.naturalWidth > 0), inReviews, { timeout: 10_000 });
assert.equal(await page.locator(inReviews).count(), 1);
await page.locator(inReviews).scrollIntoViewIfNeeded();
await shot('reviews-pictures');
await page.click(inReviews);
await page.waitForSelector('.crt .zoom img');
assert.match(await page.$eval('.crt .zoom img', i => i.getAttribute('src')), /^\/api\/review\/shot\?id=\d+&pic=/);
await page.click('.crt .zoom');
// ...and in Wire's look
const wire = await context.newPage();
await wire.goto(`${base}/?intro=0&renderer=wire`);
await wire.waitForFunction(() => document.querySelector('#loading')?.classList.contains('gone'), null, { timeout: 30_000 });
await wire.click('#btn-computer'); await wire.click('[data-app=notes]');
await wire.waitForFunction(sel => [...document.querySelectorAll(`${sel} img`)].some(i => i.naturalWidth > 0), inReviews, { timeout: 10_000 });
await wire.locator(inReviews).scrollIntoViewIfNeeded();
await shot('reviews-pictures-wire', wire);
await wire.close();
// hq note: the note as review mode posted it, sent through the real coordinator (the test company, a throwaway DATA_DIR),
// and read back by the real hq
const coordinator = `
  const { fixtureRepo } = await import(${JSON.stringify(`${ROOT}/platform/coordinator/src/fixture.ts`)});
  fixtureRepo();
  process.env.DATA_DIR = (await import('node:fs')).mkdtempSync(process.env.TMPDIR + '/notes-check-');
  process.env.PUBLIC_HOST = 'hq.company.test';
  const feedback = await import(${JSON.stringify(`${ROOT}/platform/coordinator/src/feedback.ts`)});
  const posted = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));
  const { id } = feedback.saveNote('hello', 'hello.preview.test', posted);
  feedback.send({ slug: 'hello', ids: [id] });
  process.stdout.write(JSON.stringify(feedback.forWorker(id)));`;
const sentNote = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', coordinator],
  { input: JSON.stringify(pictureNote.posted), maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'inherit'] }));
const agentApi = createServer((q, s) => s.end(q.url === `/api/agent/note?id=${sentNote.id}` ? JSON.stringify(sentNote) : '{}'));
await new Promise(r => agentApi.listen(0, '127.0.0.1', r));
const saved = await new Promise((resolve, reject) => execFile(`${ROOT}/platform/worker/bin/hq`, ['note', String(sentNote.id)],
  { env: { PATH: process.env.PATH, HQ_URL: `http://127.0.0.1:${agentApi.address().port}`, HQ_TOKEN: 'job-token', TMPDIR: process.env.TMPDIR ?? '/tmp' } },
  (err, out) => err ? reject(err) : resolve(out)));
agentApi.close();
const savedFiles = [...saved.matchAll(/^Picture (\d+): (\S+)$/gm)];
assert.deepEqual(savedFiles.map(m => m[1]), ['1', '2'], saved.slice(0, 400));
for (const [i, [, , file]] of savedFiles.entries()) {
  assert.deepEqual(await readFile(file), Buffer.from(pictureNote.posted.pictures[i].split(',')[1], 'base64'), `hq note saves picture ${i + 1} as it was sent`);
  await rm(file);
}
await rm(saved.match(/^Screenshot: (\S+)$/m)[1]);

// ---- on a shelf (the front's preview door, /hello/): the script loaded by its relative address posts next to itself
const SHELF = 'https://front.preview.test', posted = [];
await context.route(`${SHELF}/**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (path.startsWith('/hello/') && fulfilPart(r, path, reviewJs)) return;
  if (path === '/hello/__review/coach') return r.fulfill({ json: { show: false } });
  if (path.includes('/__review/') && r.request().method() === 'POST') { posted.push(path); return r.fulfill({ json: { ok: true, id: ++lastId } }); }
  return r.fulfill({ contentType: 'text/html', body: PAGE.replace('src="/__review/', 'src="./__review/') });
});
const shelf = await context.newPage();
shelf.on('pageerror', e => errors.push(e.message));
await shelf.goto(`${SHELF}/hello/`);
await pinNote(shelf, 'Seen on a shelf', () => shelf.click('review-mode .fab', { force: true }), shelf.mouse);
// (the mark started the mic: its clip, if it went, goes there too)
assert.deepEqual(posted.filter(p => p !== '/hello/__review/voice'), ['/hello/__review/notes'], "a shelf's note goes to its own path");

// ---- HQ itself: review mode over HQ's own screens (drawn under HQ's CSP, which admits no inline style), its note goes
// into the board's book, on the sheet of HQ's page there (book-check.mjs has the Pencil's story).
OWNERS.hq = ['HQ', 'bolt', 'Bolt'];
const onHq = [], booked = [];
await context.route(`${base}/__review/**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (fulfilPart(r, path, reviewJs)) return;
  if (path === '/__review/coach') return r.fulfill({ json: { show: false } });
  if (path === '/__review/mine') return r.fulfill({ json: { notes: 0, list: [], sent: false, more: false } }); // (HQ's notes are the book's)
  if (path === '/__review/notes') { onHq.push(path); return r.fulfill({ json: { ok: true, id: ++lastId } }); }
  return r.fulfill({ status: 404, body: '' });
});
await context.route(`${base}/api/book**`, r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/book') return r.fulfill({ json: { day: '2026-10-26', today: '2026-10-26', days: [], pages: [] } });
  if (path === '/api/book/sheets') return r.fulfill({ json: { open: [], sent: [] } });
  if (path === '/api/book/page/new') return r.fulfill({ json: { id: 5, ...r.request().postDataJSON() } });
  if (path === '/api/book/note') { const b = r.request().postDataJSON(); booked.push(b); return r.fulfill({ json: { note: { id: 9, n: 1, status: 'open', ...b }, sheet: { id: 1 } } }); }
  return r.fulfill({ json: { notes: [] } });
});
await context.route(`${base}/?intro=0`, async r => r.fulfill({ response: await r.fetch(),
  headers: { 'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' https://*.preview.test" } }));   // (frame-src)
const hq = await context.newPage();
hq.on('pageerror', e => errors.push(e.message));
await hq.goto(`${base}/?intro=0`);
await until(hq, '#loading.gone');
await hq.waitForSelector('review-mode .fab');   // (signed in, HQ always has it)
assert.equal(await hq.$eval('review-mode .fab', b => getComputedStyle(b).position), 'absolute', 'review mode is drawn under HQ\'s CSP');
await hq.click('review-mode .fab', { force: true });
await hq.waitForSelector('review-mode .veil:not([hidden])');
await hq.mouse.click(120, 24);   // (HQ's plate, up in the corner)
await hq.waitForSelector('review-mode .sheet:not([hidden])');
assert.equal(await hq.textContent('review-mode .send'), 'Send', "HQ's post-it has one Send");
await hq.fill('review-mode textarea', 'The plate could say the time');
await hq.click('review-mode .send');
await hq.waitForSelector('review-mode .sheet', { state: 'hidden', timeout: 20_000 });
assert.deepEqual(onHq, [], "a note on HQ doesn't wait in Reviews");
assert.deepEqual(booked.map(b => ({ page: b.page, words: b.words, said: b.said, v: b.anchor.v, pinned: !!b.anchor.el })),
  [{ page: 5, words: 'The plate could say the time', said: 'typed', v: 1, pinned: true }], 'it goes on its sheet in the book');
await shot('hq-pinned', hq);
await hq.click('review-mode .more');
assert.deepEqual(await hq.$$eval('review-mode .menu .items button:not([hidden])', items => items.map(i => i.firstChild.textContent)), ['General note'],
  'its menu, its notes sent: a general note, and no switch to put the pin away');
await hq.click('review-mode [data-general]');
const draft = 'The cards row is cut off on the right';
await hq.fill('review-mode textarea', draft);
// one pin at a time: a preview in the viewer shows only its own, and HQ's draft is back as it closes
const pinsShown = async () => (await Promise.all(hq.frames().map(f => f.$$eval('review-mode', hosts => hosts
  .filter(h => h.shadowRoot.querySelector('.fab').checkVisibility()).map(() => location.origin))))).flat();
await hq.evaluate(href => { const a = document.createElement('a'); a.href = href; a.textContent = 'preview'; document.body.append(a); a.click(); a.remove(); }, `${PRODUCT}/`);
await hq.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 });
await hq.frame({ url: `${PRODUCT}/` }).waitForSelector('review-mode .fab');
assert.deepEqual(await pinsShown(), [PRODUCT], 'a framed preview shows exactly one pin, its own');
// (and HQ's covered note takes no picture pasted or dropped on HQ's page, while a drop still doesn't open the file.)
const missed = await hq.evaluate(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 40, height: 30 });
  const files = new DataTransfer();
  files.items.add(new File([await new Promise(r => c.toBlob(r, 'image/png'))], 'covered.png', { type: 'image/png' }));
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: files, bubbles: true, cancelable: true }));
  const over = new DragEvent('dragover', { dataTransfer: files, bubbles: true, cancelable: true }),
    drop = new DragEvent('drop', { dataTransfer: files, bubbles: true, cancelable: true });
  document.body.dispatchEvent(over);
  document.body.dispatchEvent(drop);
  const sheet = document.querySelector('review-mode').shadowRoot.querySelector('.sheet');
  return { effect: over.dataTransfer.dropEffect, opened: !drop.defaultPrevented, pictures: sheet.querySelectorAll('.pics li').length, lit: sheet.classList.contains('taking') };
});
assert.deepEqual(missed, { effect: 'none', opened: false, pictures: 0, lit: false }, "HQ's covered note ignores a paste and a drop on HQ's page");
await hq.keyboard.press('Escape');
await Promise.all([hq.waitForEvent('framedetached'), hq.click('#viewer [data-close]')]);
assert.equal(await hq.inputValue('review-mode textarea'), draft, 'opening a preview and pressing Escape keeps HQ\'s draft');
await hq.waitForSelector('review-mode .sheet:not([hidden])');
await hq.click('review-mode [data-cancel]');
assert.deepEqual(await pinsShown(), [base], "HQ's own pin is back once the viewer closes");

assert.deepEqual(errors, []);
await context.unrouteAll({ behavior: 'ignoreErrors' });   // (HQ still polling as it closes)
await browser.close(); server.close();
// (the summary's over a tool, after a late goodbye; its pictures)
console.log(`notes-check: the badge, the send step from the viewer's slim bar (every note waiting counted) and from review mode's Send my notes ticking no note (over a tool, after a late goodbye; something typed comes up instead), the menu's lines unwrapped on a phone, a discard there, nothing over the page after a pin, My notes as a sidebar with a dozen screenshots loaded as it scrolls (phone and desktop, frame and tab), Change, Delete, Escape, Send my notes in a tab opening Reviews, Call by Send about the ticked notes, a shelf's note on its own path, the board's general note and My notes from the pin's menu, the polaroid and the thumbnail framed on the pin, the pin always on HQ itself (its note on its sheet in the book), one pin over a framed preview (HQ's covered note taking nothing pasted or dropped), pictures pasted, dropped and taken off a note (scaled on the device), in My notes, kept by a change, in Reviews and saved by hq note${shots ? ` (screenshots in ${shots})` : ''}`);
