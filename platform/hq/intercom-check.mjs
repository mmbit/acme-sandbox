#!/usr/bin/env node
// The intercom opens on a loader until its history is in, the empty-chat hint only once it came back empty, and a first
// load that fails says so under the input.
//
// Pictures on the intercom: the board attaches or pastes pictures for its next line, each goes up at once as a JPEG
// (redrawn: no camera metadata), Send carries their numbers with the words (or alone) and waits for one still on its
// way, a refused one leaves the tray with the reason, and the chat shows them on the line, a tap opening one big. Send
// takes the tray as it is: a picture added meanwhile waits for the next line. One the board removes is deleted on the
// coordinator, even if it lands after, its tile staying until it is; if the coordinator can't, the tile is back with the
// reason, to send or remove again (closing the intercom doesn't lose it). The ones still waiting come back after a
// reload, but not one sent or removed before a slow answer about them comes back, nor a second time while it's still
// going up (one begun while the tray waits for another too), and one no longer waiting there (removed in another tab,
// or gone after a day) leaves the tray when it reopens. A line refused because one of its pictures is no longer
// waiting keeps its words, and that picture leaves the tray. A bare address in a line is a link, and a tap on it
// doesn't copy the line.
//   node platform/hq/intercom-check.mjs [--shots dir]
// HQ on its own files with a fake /api (so it isn't in dev mode), at a phone's size.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const server = await serve(), base = `http://localhost:${server.address().port}`;
// a 64×40 PNG of two colours, made by the browser below: the fake /api serves it as every picture
let png = null;
const uploads = [], lines = [];
let nextId = 41, slow = 0, refuse = 0, heldChat = null, chatDown = false, held = null, heldWaiting = null, heldUpload = null, heldForget = null, waitingDown = false, forgetDown = false, waitingAsked = 0;
// heldChat: the conversation's history; held: a line waits for it; heldWaiting: the waiting list; heldUpload: an upload's answer (refused, or once it's waiting);
// heldForget: a removal's answer
const messages = [], waiting = new Set(), forgotten = [];

const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
await context.route(`${base}/api/**`, async r => {
  const url = new URL(r.request().url()), path = url.pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/gazette') return r.fulfill({ json: [] });
  if (path === '/api/chat' && r.request().method() === 'GET') {
    await heldChat;
    return chatDown ? r.fulfill({ status: 502, body: '' }) : r.fulfill({ json: { messages, thinking: false } });
  }
  if (path === '/api/chat') {
    const b = r.request().postDataJSON();
    await held;
    const missing = b.pictures.filter(id => !waiting.has(id));
    if (missing.length) return r.fulfill({ status: 409, json: { error: 'no longer waiting', missing } });   // (as chat.fromBoard)
    lines.push(b);
    for (const id of b.pictures) waiting.delete(id);
    messages.push({ id: messages.length + 1, ts: new Date().toISOString(), who: 'board', text: b.text, ...(b.pictures.length ? { pictures: b.pictures } : {}) });
    return r.fulfill({ json: { messages, thinking: true } });
  }
  if (path === '/api/pictures') {
    if (slow) await new Promise(res => setTimeout(res, slow));
    if (refuse) { const status = refuse; await heldUpload; return r.fulfill({ status, json: { error: 'too large' } }); }
    const id = nextId++;
    uploads.push({ id, type: r.request().headers()['content-type'], bytes: r.request().postDataBuffer().length });
    waiting.add(id);
    await heldUpload;
    return r.fulfill({ json: { id, type: 'image/jpeg', bytes: 1 } });
  }
  if (path === '/api/pictures/file') return r.fulfill({ contentType: 'image/png', body: png });
  if (path === '/api/pictures/waiting') {
    waitingAsked++;
    if (waitingDown) return r.fulfill({ status: 502, body: '' });
    const pictures = [...waiting].map(id => ({ id, type: 'image/jpeg' }));
    await heldWaiting;
    return r.fulfill({ json: { pictures } });
  }
  if (path === '/api/pictures/forget') {
    const { id } = r.request().postDataJSON();
    await heldForget;
    if (forgetDown) return r.fulfill({ status: 503, body: '' });
    forgotten.push(id); waiting.delete(id);
    return r.fulfill({ json: { forgotten: id } });
  }
  return r.fulfill({ status: 404, body: '' });
});
const hq = `${base}/?intro=0${process.env.LOOK ? `&renderer=${process.env.LOOK}` : ''}&open=intercom`;
// opening: a loader until the history is in, never the empty-chat hint; the hint once it came back empty
let history;
heldChat = new Promise(res => { history = res; });
await page.goto(hq);
await page.waitForSelector('#chat[aria-busy="true"] .typing');
assert.equal(await page.$('#chat .hint'), null, 'no empty-chat hint while the history loads');
history(); heldChat = null;
await page.waitForSelector('#chat:not([aria-busy]) .hint');
assert.equal(await page.$('#chat .typing'), null, 'the loader goes');
await page.waitForSelector('#dir-attach');
png = Buffer.from(await page.evaluate(async () => {
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 40 }), g = c.getContext('2d');
  g.fillStyle = '#2b6cb0'; g.fillRect(0, 0, 64, 40); g.fillStyle = '#f6c343'; g.fillRect(8, 8, 20, 20);
  return c.toDataURL('image/png').split(',')[1];
}), 'base64');
const tray = () => page.$$eval('#dir-pics .pic', l => l.map(p => p.classList.contains('removing') ? 'removing' : p.classList.contains('busy') ? 'busy' : 'ready'));
const msg = () => page.textContent('#dir-msg');
const told = async () => assert.ok((await msg()).trim(), 'the board is told why');
const paste = () => page.evaluate(async b64 => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), dt = new DataTransfer();
  dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
  document.querySelector('#dir-title').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, png.toString('base64'));
const waitFor = async ok => { for (let i = 0; !ok(); i++) { assert.ok(i < 100, 'timed out'); await new Promise(r => setTimeout(r, 50)); } };
const settled = n => page.waitForFunction(n => [...document.querySelectorAll('#dir-pics .pic')].filter(p => !p.classList.contains('busy')).length === n, n);

// attached from the picker, then pasted: each goes up at once, as a JPEG
await page.setInputFiles('#dir-file', { name: 'photo.png', mimeType: 'image/png', buffer: png });
await settled(1);
await paste();
await settled(2);
assert.deepEqual(uploads.map(u => u.type), ['image/jpeg', 'image/jpeg']);
// a pasted text stays text: only images are taken
await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'https://example.com/idea');
  document.querySelector('#dir-title').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
assert.equal((await tray()).length, 2);
if (shots) { mkdirSync(shots, { recursive: true }); await page.fill('#dir-title', 'This is how the menu looks on my phone. Can the buttons be bigger?'); await page.screenshot({ path: `${shots}/intercom-tray.png` }); }
// one removed: its tile waits for the coordinator to let it go, the line carries the other, with the words, and the
// tray empties
let forget;
heldForget = new Promise(res => { forget = res; });
await page.click('#dir-pics .pic:first-child [data-unpick]');
assert.deepEqual(await tray(), ['removing', 'ready']);
forget(); heldForget = null;
await waitFor(() => forgotten.includes(41));
await page.waitForFunction(() => document.querySelectorAll('#dir-pics .pic').length === 1);
await page.fill('#dir-title', 'This is how the menu looks on my phone. Can the buttons be bigger?');
await page.click('#dir-send');
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);
assert.deepEqual(lines.at(-1), { text: 'This is how the menu looks on my phone. Can the buttons be bigger?', pictures: [42] });
assert.equal(await page.inputValue('#dir-title'), '');
// the chat shows it on the line; a tap opens it big, and doesn't copy the line
await page.waitForSelector('#chat .me .pics img');
assert.equal(await page.getAttribute('#chat .me .pics img', 'src'), '/api/pictures/file?id=42');
await page.click('#chat .me .pics button');
await page.waitForSelector('.pic-zoom img');
assert.equal(await page.$('#chat .copied'), null);
if (shots) await page.screenshot({ path: `${shots}/intercom-zoom.png` });
await page.click('.pic-zoom');

// a picture alone is a line; Send waits for one still on its way, and sends it with its number
slow = 1200;
await paste();
await page.waitForSelector('#dir-pics .pic.busy');
await page.click('#dir-send');
await page.waitForFunction(n => document.querySelectorAll('#chat .me').length === n, 2);
assert.deepEqual(lines.at(-1), { text: '', pictures: [43] });
slow = 0;
if (shots) await page.screenshot({ path: `${shots}/intercom-chat.png` });

// a picture the server refuses leaves the tray with the reason; nothing is sent until the board taps Send again
refuse = 413;
const sent = lines.length;
await paste();
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);
await told();
await page.fill('#dir-title', 'and this one');
let refuseIt;
heldUpload = new Promise(res => { refuseIt = res; });
await paste();
await page.waitForSelector('#dir-pics .pic.busy');
await page.click('#dir-send');
await page.waitForSelector('#dir-pics .pic.busy:not(:has([data-unpick]))');   // (Send has it, and waits for it)
const sending = await msg();
refuseIt(); heldUpload = null;
await page.waitForFunction(() => !document.querySelector('#dir-send').disabled);
assert.ok(await page.$eval('#dir-pics', el => el.hidden));
await told();
assert.notEqual(await msg(), sending);
assert.equal(lines.length, sent);
assert.equal(await page.inputValue('#dir-title'), 'and this one');
refuse = 0;
await page.fill('#dir-title', '');

// Send takes the tray as it is: a picture added while the line is on its way, or while Send waits for an upload, stays
// for the next line. The pictures going can't be removed meanwhile.
let letGo;
held = new Promise(res => { letGo = res; });
await paste();
await settled(1);
const before = lines.length;
await page.click('#dir-send');
await paste();
await settled(2);
assert.equal(lines.length, before);   // (the line is still on its way)
assert.deepEqual(await page.$$eval('#dir-pics .pic', l => l.map(p => !!p.querySelector('[data-unpick]'))), [false, true]);
letGo(); held = null;
await page.waitForFunction(n => document.querySelectorAll('#chat .me').length === n, 3);
await settled(1);
const [went, stayed] = uploads.slice(-2).map(u => u.id);
assert.deepEqual(lines.at(-1).pictures, [went]);
await page.click('#dir-pics [data-unpick]');
await waitFor(() => forgotten.includes(stayed));
slow = 1500;
await paste();
await page.waitForSelector('#dir-pics .pic.busy');
await page.click('#dir-send');   // it waits for the upload, and one more comes meanwhile
await paste();
await page.waitForFunction(n => document.querySelectorAll('#chat .me').length === n, 4);
await settled(1);
const [waited, left] = uploads.slice(-2).map(u => u.id);
assert.deepEqual(lines.at(-1).pictures, [waited]);
slow = 0;

// after a reload the picture still waiting is back in the tray, and goes with the next line
await page.goto(hq);   // (HQ takes ?open= off its address once it's open)
await page.waitForSelector('#dir-attach');
await settled(1);
await page.click('#dir-send');
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);
assert.deepEqual(lines.at(-1).pictures, [left]);

// one removed while it's still going up stays, marked, until it lands; then it's let go of and the tray empties
let landIt;
heldUpload = new Promise(res => { landIt = res; });
const landed = uploads.length;
await paste();
await waitFor(() => uploads.length > landed);
await page.waitForSelector('#dir-pics .pic.busy [data-unpick]');
await page.click('#dir-pics .pic [data-unpick]');
assert.deepEqual(await tray(), ['removing']);
landIt(); heldUpload = null;
await waitFor(() => forgotten.includes(uploads.at(-1).id));
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);
assert.equal((await tray()).length, 0);
assert.deepEqual([...waiting], []);

// the intercom reopened while a picture waits, and the coordinator's list of waiting ones comes back only after that
// picture went with a line: it doesn't come back to the tray, and the next line goes
await paste();
await settled(1);
let answerWaiting;
heldWaiting = new Promise(res => { answerWaiting = res; });
await page.click('.intercom [data-close]');
await page.click('#btn-intercom');
await settled(1);
await page.click('#dir-send');
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);
assert.deepEqual(lines.at(-1).pictures, [uploads.at(-1).id]);
const answered = page.waitForResponse(r => r.url().endsWith('/api/pictures/waiting'));
answerWaiting(); heldWaiting = null;
await answered;
await page.evaluate(() => new Promise(requestAnimationFrame));
assert.equal((await tray()).length, 0);
const linesBefore = lines.length;
await page.fill('#dir-title', 'one more thing');
await page.click('#dir-send');
await waitFor(() => lines.length > linesBefore);
assert.deepEqual(lines.at(-1), { text: 'one more thing', pictures: [] });

// the intercom reopened while a picture is going up, already on the coordinator but its number not back yet: the tray
// shows it once, not again from the waiting list. Removed and then landed, it's let go of, and the next line goes.
let land;
heldUpload = new Promise(res => { land = res; });
const asked = waitingAsked;
await paste();
await waitFor(() => waiting.size === 1);
await page.click('.intercom [data-close]');
await page.click('#btn-intercom');
await page.waitForSelector('#dir-pics .pic.busy [data-unpick]');
assert.deepEqual(await tray(), ['busy']);
assert.equal(waitingAsked, asked, 'the waiting list is asked for once the upload is back');
await page.click('#dir-pics [data-unpick]');
let listed = page.waitForResponse(r => r.url().endsWith('/api/pictures/waiting'));
land(); heldUpload = null;
await listed;
await page.evaluate(() => new Promise(requestAnimationFrame));
assert.equal((await tray()).length, 0);
assert.deepEqual([...waiting], []);
await page.fill('#dir-title', 'not that one after all');
await page.click('#dir-send');
await waitFor(() => lines.at(-1).text === 'not that one after all');
assert.deepEqual(lines.at(-1).pictures, []);

// the intercom reopened while picture A is going up, and B begun while the tray waits for A, already on the coordinator
// but its number not back yet when A lands: the waiting list doesn't add B a second time. B removed and then landed is
// let go of, and the next line goes with A alone.
let landA, landB;
heldUpload = new Promise(res => { landA = res; });
await paste();
await waitFor(() => waiting.size === 1);
const a = uploads.at(-1).id;
await page.click('.intercom [data-close]');
await page.click('#btn-intercom');
await page.waitForSelector('#dir-pics .pic.busy [data-unpick]');
heldUpload = new Promise(res => { landB = res; });
await paste();
await waitFor(() => waiting.size === 2);
const b = uploads.at(-1).id;
listed = page.waitForResponse(r => r.url().endsWith('/api/pictures/waiting'));
landA();
await listed;
await page.evaluate(() => new Promise(requestAnimationFrame));
assert.deepEqual(await tray(), ['ready', 'busy']);
await page.click('#dir-pics .pic.busy [data-unpick]');
listed = page.waitForResponse(r => r.url().endsWith('/api/pictures/waiting'));
landB(); heldUpload = null;
await waitFor(() => forgotten.includes(b));
await listed;
await page.evaluate(() => new Promise(requestAnimationFrame));
assert.deepEqual(await tray(), ['ready']);
await page.fill('#dir-title', 'just the first');
await page.click('#dir-send');
await waitFor(() => lines.at(-1).text === 'just the first');
assert.deepEqual(lines.at(-1).pictures, [a]);
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);

// a waiting list that didn't come back changes nothing; one that did is the truth: a picture removed in another tab (or
// gone after a day) leaves the tray, and the next line goes
await paste();
await settled(1);
const reopen = async () => {
  listed = page.waitForResponse(r => r.url().endsWith('/api/pictures/waiting'));
  await page.click('.intercom [data-close]');
  await page.click('#btn-intercom');
  await listed;
  await page.evaluate(() => new Promise(requestAnimationFrame));
};
waitingDown = true;
await reopen();
assert.deepEqual(await tray(), ['ready']);
waitingDown = false;
waiting.delete(uploads.at(-1).id);
await reopen();
assert.equal((await tray()).length, 0);
await page.fill('#dir-title', 'just words');
await page.click('#dir-send');
await waitFor(() => lines.at(-1).text === 'just words');
assert.deepEqual(lines.at(-1).pictures, []);

// a removal the coordinator can't do brings the tile back with the reason, also after the intercom is closed and
// reopened, and once more nothing else: removed again, it's gone, and a waiting list asked for before doesn't bring it back
await paste();
await settled(1);
const kept = uploads.at(-1).id;
forgetDown = true;
await page.click('#dir-pics [data-unpick]');
await page.waitForSelector('#dir-pics .pic:not(.busy) [data-unpick]');
await told();
assert.ok(waiting.has(kept));
await reopen();
assert.deepEqual(await tray(), ['ready']);
forgetDown = false;
heldWaiting = new Promise(res => { answerWaiting = res; });
listed = page.waitForResponse(r => r.url().endsWith('/api/pictures/waiting'));
await page.click('.intercom [data-close]');
await page.click('#btn-intercom');
await page.click('#dir-pics [data-unpick]');
await waitFor(() => forgotten.includes(kept));
answerWaiting(); heldWaiting = null;
await listed;
await page.evaluate(() => new Promise(requestAnimationFrame));
assert.equal((await tray()).length, 0);

// the same for one removed while it's going up: it stays, marked, until it lands; the coordinator can't let it go, so
// it's back, comes back once when the intercom reopens, and goes with the next line
heldUpload = new Promise(res => { land = res; });
await paste();
await waitFor(() => waiting.size === 1);
const late = uploads.at(-1).id;
await page.click('#dir-pics [data-unpick]');
assert.deepEqual(await tray(), ['removing']);
forgetDown = true;
land(); heldUpload = null;
await page.waitForSelector('#dir-pics .pic:not(.busy) [data-unpick]');
await told();
forgetDown = false;
await reopen();
assert.deepEqual(await tray(), ['ready']);
await page.fill('#dir-title', 'keep this one');
await page.click('#dir-send');
await waitFor(() => lines.at(-1).text === 'keep this one');
assert.deepEqual(lines.at(-1).pictures, [late]);
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);

// a picture deleted on the coordinator while it's in an open tray (removed in another tab, or gone after a day): Send is
// refused, the words stay, that picture leaves the tray and the others stay, and the next Send goes with them
await paste();
await paste();
await settled(2);
const [stays, vanished] = uploads.slice(-2).map(u => u.id);
waiting.delete(vanished);
const linesNow = lines.length;
await page.fill('#dir-title', 'both of these');
await page.click('#dir-send');
await page.waitForFunction(() => document.querySelectorAll('#dir-pics .pic').length === 1 && !document.querySelector('#dir-send').disabled);
assert.equal(lines.length, linesNow);
assert.equal(await page.inputValue('#dir-title'), 'both of these');
assert.deepEqual(await tray(), ['ready']);
await told();
await page.click('#dir-send');
await waitFor(() => lines.length > linesNow);
assert.deepEqual(lines.at(-1), { text: 'both of these', pictures: [stays] });
await page.waitForFunction(() => document.querySelector('#dir-pics').hidden);

// at most six to a line: the rest aren't taken, and the board is told
const uploaded = uploads.length;
await page.setInputFiles('#dir-file', Array.from({ length: 8 }, (_, i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: png })));
await settled(6);
assert.equal((await tray()).length, 6);
await waitFor(() => uploads.length === uploaded + 6);
await told();

// a bare address in a line is a link, and a tap on it opens it rather than copying the line
await page.fill('#dir-title', 'The ad: https://www.facebook.com/ads/library/?id=1.');
await page.click('#dir-send');   // (with the six)
await page.waitForSelector('#chat .me:last-child a');
assert.equal(await page.getAttribute('#chat .me:last-child a', 'href'), 'https://www.facebook.com/ads/library/?id=1');
assert.equal(await page.textContent('#chat .me:last-child p'), 'The ad: facebook.com/ads/library/?id=1 ↗.');
await page.$eval('#chat .me:last-child a', a => a.addEventListener('click', e => e.preventDefault()));   // (no new tab)
await page.click('#chat .me:last-child a');
assert.equal(await page.$('#chat .copied'), null);

// a first load that fails says so under the input while the loader stays, never the hint, and the next poll brings the
// conversation in and lets the alert go
chatDown = true;
await page.goto(hq);
await page.waitForSelector('#dir-msg [role=alert]');
assert.match(await page.textContent('#dir-msg .words'), /^Could not load the conversation/);
assert.ok(await page.$('#chat[aria-busy="true"] .typing'), 'the loader stays');
assert.equal(await page.$('#chat .hint'), null);
chatDown = false;
await page.waitForSelector('#chat:not([aria-busy]) .me', { timeout: 10e3 });
assert.equal(await msg(), '', 'the alert goes');

assert.deepEqual(errors, []);
await browser.close(); server.close();
console.log('intercom-check: a loader until the history is in, the hint only for an empty one, a failed load says so; pictures attach and paste, go up as JPEGs, ride with the line (or alone), wait for an upload, show in the chat; removed ones are let go of, later ones wait, waiting ones come back, a vanished one leaves the tray at Send; a bare address is a link');
