#!/usr/bin/env node
// An email card (outbox.ts): the desk phone shows who it goes to and the text to edit, Send posts the board's own subject and
// text, a refusal keeps what the board typed and says why, Discard asks first, and a send that may have gone says so on the
// card even while the board's edits hold its redraw back, and an agent-signed one says who signs it. Its attachments show
// under the text: a picture (a tap shows it big), a PDF by its name. With the company's look the card shows the letter as
// it will go, redrawn from the boxes as the board edits them. The board's edits outlast closing the phone, and a text
// selection dragged out of it doesn't close it.
//   node platform/hq/outbox-check.mjs
// HQ on its own files with a fake /api (so it isn't in dev mode), the phone open on two email cards.
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const server = await serve(), base = `http://localhost:${server.address().port}`;
const mail = { id: 4, to: ['legal@partner.example', 'dpo@partner.example'], cc: ['counsel@partner.example'], from: 'hello@testco.example',
  replyTo: 'privacy@testco.example', subject: 'Our transfer assessment', text: 'Dear legal team,\n\nHere it is.\n\nKind regards,',
  status: 'open', signoff: 'Ada Board\nTestco', name: 'Ada Board', ready: true };
const card = { id: 9, created: new Date().toISOString(), agent: 'wren', kind: 'mail', title: 'Our transfer assessment', body: 'They asked for it.', urgency: 'today', mail };
const other = { ...card, id: 10, title: 'Another email', mail: { ...mail, id: 5, subject: 'Another email' } };
card.mail = { ...mail, attachments: [{ n: 0, name: 'insert-front.png', type: 'image/png', size: 70 }, { n: 1, name: 'insert.pdf', type: 'application/pdf', size: 9000 }] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'), files = [];
let cards = [card, other];
const previews = [], frames = [];
const posted = [], replies = [[502, { error: 'Not sent: the email service refused it (422: bad address).' }], [200, { ok: true }], [200, { ok: true }], [0]];
const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 420, height: 912 } });
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname;
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/requests') return r.fulfill({ json: cards });
  if (path === '/api/gazette') return r.fulfill({ json: [] }); // (HQ's boot waits for it)
  if (path === '/api/outbox/file') { files.push(new URL(r.request().url()).search); return r.fulfill({ contentType: 'image/png', body: PNG }); }
  if (path === '/api/outbox/preview') {
    if (r.request().method() === 'POST') { previews.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); }
    frames.push(new URL(r.request().url()).search);
    return r.fulfill({ contentType: 'text/html', body: `<p>The letter, as it goes (${frames.length})</p>` });
  }
  if (path === '/api/outbox/send' || path === '/api/outbox/discard') {
    posted.push({ path, ...r.request().postDataJSON() });
    const [status, json] = replies.shift();
    if (!status) return r.abort();   // (HQ unreachable mid-send)
    if (status === 200) cards = cards.filter(c => c.id !== posted.at(-1).id);
    return r.fulfill({ status, json });
  }
  return r.fulfill({ status: 404, body: '' });
});
await page.goto(`${base}/?intro=0&open=phone`);
await page.waitForSelector('#mail-text');

// who it goes to and where the answer comes in; the subject and text to edit, with the sign-off under them; no answer box
assert.match(await page.textContent('.mailto'), /legal@partner\.example, dpo@partner\.example.*counsel@partner\.example.*hello@testco\.example.*privacy@testco\.example/s);
assert.equal(await page.inputValue('#mail-subject'), 'Our transfer assessment');
assert.equal(await page.textContent('.mail-sign'), 'Ada Board\nTestco');
assert.equal(await page.locator('#answer').count(), 0);
// its attachments under the sign-off: the picture from the card's draft, a tap shows it big; the PDF a link by its name
await page.locator('.req .pics img').evaluate(i => i.complete || new Promise(go => i.onload = go));
assert.deepEqual([files, await page.textContent('.req .pics figcaption')], [['?id=9&n=0'], 'insert-front.png']);
assert.deepEqual([await page.textContent('.mail-files a'), await page.getAttribute('.mail-files a', 'href')], ['insert.pdf', '/api/outbox/file?id=9&n=1']);
await page.click('.req .pics [data-pic]');
await page.click('.pic-zoom');
await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/outbox-check.png`, fullPage: true });

// a refused Send keeps the board's edits and says why; the next Send posts them
await page.fill('#mail-text', 'Dear legal team,\n\nHere it is, signed.\n\nKind regards,');
// the board's edits outlast the phone: a selection dragged out of it onto the backdrop leaves it open, a tap on the
// backdrop closes it, and the phone opened again shows the edits (kept until the email is sent)
const backdrop = await page.evaluate(() => { const d = document.querySelector('#tool .device').getBoundingClientRect(); return { x: d.left + d.width / 2, y: Math.max(d.top, innerHeight - d.bottom) > 8 ? (d.top > 8 ? d.top / 2 : (d.bottom + innerHeight) / 2) : null }; });
assert.ok(backdrop.y !== null, 'the phone leaves some backdrop to press on');
const box = await page.locator('#mail-text').boundingBox();
await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down();
await page.mouse.move(backdrop.x, backdrop.y, { steps: 5 }); await page.mouse.up();
assert.equal(await page.isVisible('#mail-text'), true);
await page.mouse.click(backdrop.x, backdrop.y);
await page.waitForSelector('#tool', { state: 'hidden' });
await page.click('#btn-desk');
await page.waitForSelector('#mail-text');
assert.match(await page.inputValue('#mail-text'), /signed/);
await page.click('#mail-send');
await page.waitForFunction(() => /^Not sent/.test(document.querySelector('#answer-msg')?.textContent ?? ''));
assert.match(await page.inputValue('#mail-text'), /signed/);
await page.click('#mail-send');
await page.waitForFunction(() => document.querySelector('#answer-msg')?.textContent === 'Sent.');
assert.equal(await page.evaluate(() => localStorage.getItem('hq.mail.4')), 'null');
assert.deepEqual(posted.slice(0, 2).map(p => [p.path, p.id, p.subject, p.text]), Array(2).fill(['/api/outbox/send', 9, 'Our transfer assessment',
  'Dear legal team,\n\nHere it is, signed.\n\nKind regards,']));

// the card leaves; Discard on the next asks first, in its own spot (nothing posted), then posts
await page.waitForFunction(() => document.querySelector('.req h3')?.textContent === 'Another email');
await page.click('#mail-discard');
assert.equal(posted.length, 2);
assert.equal(await page.textContent('#mail-discard'), 'Tap again to discard');
assert.match(await page.textContent('#answer-msg'), /^Discard this email\? Nothing is sent, and .+ hears so\.$/);
await page.waitForTimeout(600); // (a second tap within 500 ms is the same gesture's)
await page.click('#mail-discard');
await page.waitForFunction(() => document.querySelector('#answer-msg')?.textContent === 'Discarded.');
assert.deepEqual([posted[2].path, posted[2].id], ['/api/outbox/discard', 10]);

// a send that broke off: the next poll's 'may or may not have gone' shows on the card at once, the board's edits kept
cards = [{ ...card, id: 11, title: 'A third email', mail: { ...mail, id: 6, subject: 'A third email' } }];
const poll = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await poll();
await page.waitForFunction(() => document.querySelector('.req h3')?.textContent === 'A third email');
await page.fill('#mail-text', 'Dear legal team,\n\nHere it is, at last.');
await page.click('#mail-send');
await page.waitForFunction(() => /^Could not reach/.test(document.querySelector('#answer-msg')?.textContent ?? ''));
cards = [{ ...cards[0], mail: { ...cards[0].mail, text: 'Dear legal team,\n\nHere it is, at last.', doubt: 'It may or may not have gone (the email service didn’t answer in time).' } }];
await poll();
await page.waitForFunction(() => /^It may or may not have gone/.test(document.querySelector('#mail-hint')?.textContent ?? ''));
assert.match(await page.inputValue('#mail-text'), /at last/);

// an email an agent signs: the card says who, and the board's missing name doesn't hold it back
await page.evaluate(() => document.querySelectorAll('#mail-subject, #mail-text').forEach(f => { f.value = f.defaultValue; f.blur(); }));   // (the board's edits hold a redraw back)
cards = [{ ...card, id: 12, title: 'Even kennismaken', mail: { ...mail, id: 7, subject: 'Even kennismaken', name: null, signed: 'Juno',
  signoff: 'Juno, namens de crew van Testco\n(Geschreven door een AI-agent.)' } }];
await poll();
await page.waitForFunction(() => document.querySelector('.req h3')?.textContent === 'Even kennismaken');
assert.match(await page.textContent('.mailto'), /Signed by\s*Juno, an AI agent/);
assert.match(await page.textContent('.mail-sign'), /^Juno, namens de crew/);
assert.equal(await page.textContent('#mail-hint'), 'Nothing goes out until you send it.');

// with the company's look: the letter in a frame instead of the bare sign-off, drawn from the card's boxes as it opens (never
// from an edit the coordinator kept from before), redrawn once the board stops typing
await page.evaluate(() => document.querySelectorAll('#mail-subject, #mail-text').forEach(f => { f.value = f.defaultValue; f.blur(); }));
cards = [{ ...card, id: 13, title: 'Kennismaken', mail: { ...mail, id: 8, subject: 'Kennismaken', preview: true } },
  { ...card, id: 14, title: 'Nog een brief', mail: { ...mail, id: 9, subject: 'Nog een brief', text: 'Beste B,', preview: true } }];
await poll();
await page.waitForFunction(() => document.querySelector('.req h3')?.textContent === 'Kennismaken');
// (the frame is sandboxed, so its page is another origin's: read it through Playwright's frame)
const letter = async n => { while (!/as it goes \((\d+)\)/.test(await page.frame({ url: /\/api\/outbox\/preview/ })?.textContent('body').catch(() => '') ?? '')
  || Number(RegExp.$1) < n) await page.waitForTimeout(100); };
await letter(1);
assert.deepEqual([previews, await page.locator('.mail-sign').count()], [[{ id: 13, subject: 'Kennismaken', text: mail.text }], 0]);
assert.match(frames[0], /^\?id=13&at=\d+$/);
await page.fill('#mail-text', 'Beste allemaal,\n\nTot snel,');
await letter(2);
assert.deepEqual(previews[1], { id: 13, subject: 'Kennismaken', text: 'Beste allemaal,\n\nTot snel,' });
assert.match(frames[1], /^\?id=13&at=\d+$/);
// an edit, then Next before the redraw: the next card draws its own words, and the first card's redraw never posts them
await page.fill('#mail-text', 'Beste allemaal, half');
await page.click('[data-step="1"]');
await page.waitForFunction(() => document.querySelector('.req h3')?.textContent === 'Nog een brief');
await letter(3);
await page.waitForTimeout(1000);
assert.deepEqual(previews.slice(2), [{ id: 14, subject: 'Nog een brief', text: 'Beste B,' }]);
assert.equal(frames.length, 3);
await page.screenshot({ path: `${process.env.TMPDIR ?? '/tmp'}/outbox-check-letter.png`, fullPage: true });

// (serviceWorkers: 'block' has Playwright read navigator.serviceWorker in every frame, which a sandboxed one refuses)
assert.deepEqual(errors.filter(e => !/context is sandboxed/.test(e)), []);
await browser.close(); server.close();
console.log('outbox-check: ok');
