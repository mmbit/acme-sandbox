#!/usr/bin/env node
// A new company's first visit: HQ opens on the intercom, which asks the language before anything is said, each by its
// own name. Picking one saves it as the company's language and sends its name as the board's first line; a save that
// fails sends nothing and leaves the choice open. The voice note hears the picked language at once, without the
// intercom opening again. A company with a team opens as it always does.
//   node platform/hq/welcome-check.mjs [--shots dir]
// HQ on its own files with a fake /api (so it isn't in dev mode), at a phone's size, in the new company's theme
// (template/theme/hq.yaml): Wire in its Day and Night by the device. Chromium's fake microphone (its beeps) is the board
// talking.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../coordinator/node_modules/yaml/dist/index.js';
import { serve, ROOT } from './serve.mjs';
import { playwright, openPage } from '../../shared/browser/browser.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const theme = parse(readFileSync(join(ROOT, 'template/theme/hq.yaml'), 'utf8'));
const languages = [
  { code: 'en', name: 'English', own: 'English' },
  { code: 'nl', name: 'Dutch', own: 'Nederlands' },
  { code: 'de', name: 'German', own: 'Deutsch' },
];
let welcome = true,
  saveDown = true;
const messages = [],
  saved = [],
  heard = []; // the languages /api/voice was asked to transcribe in

const browser = await playwright().chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const { context, page, errors } = await openPage(browser, {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
await context.route(`${base}/api/**`, async r => {
  const path = new URL(r.request().url()).pathname,
    get = r.request().method() === 'GET';
  if (path === '/api/org') return r.fulfill({ response: await r.fetch({ url: `${base}/mock/org.json` }) });
  if (path === '/api/gazette') return r.fulfill({ json: [] });
  if (path === '/api/brand') return r.fulfill({ json: { brand: {}, theme } });
  if (path === '/api/language' && get) return r.fulfill({ json: { lang: 'en', languages } });
  if (path === '/api/language') {
    if (saveDown) return r.fulfill({ status: 503, body: '' });
    saved.push(r.request().postDataJSON().lang);
    return r.fulfill({ json: { lang: saved.at(-1) } });
  }
  if (path === '/api/voice') {
    heard.push(new URL(r.request().url()).searchParams.get('lang'));
    return r.fulfill({ json: { text: 'hallo' } });
  }
  if (path === '/api/chat' && get)
    return r.fulfill({ json: { messages, thinking: false, welcome: welcome && !messages.length } });
  if (path === '/api/chat') {
    messages.push({
      id: messages.length + 1,
      ts: new Date().toISOString(),
      who: 'board',
      text: r.request().postDataJSON().text,
    });
    return r.fulfill({ json: { messages, thinking: true, welcome: false } });
  }
  return r.fulfill({ status: 404, body: '' });
});
const hq = `${base}/?intro=0${process.env.LOOK ? `&renderer=${process.env.LOOK}` : ''}`;
const picks = () => page.$$eval('#chat .hint .langs button', l => l.map(b => b.textContent));

await page.goto(hq);
await page.waitForSelector('#chat .hint .langs button');
assert.deepEqual(
  await picks(),
  ['English', 'Nederlands', 'Deutsch'],
  'the intercom opens by itself on the languages, each in itself',
);
// the template's colourways, Day on a light device and Night on a dark one (scene.js colourway())
const worn = () => page.evaluate(() => ['--k-ground', '--k-accent'].map(k => document.body.style.getPropertyValue(k)));
if (shots) mkdirSync(shots, { recursive: true });
for (const [scheme, way] of [
  ['light', 'day'],
  ['dark', 'night'],
]) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.reload();
  await page.waitForSelector('#chat .hint .langs button');
  const { ground, accent } = theme.wire.colourways.find(w => w.id === way);
  assert.deepEqual(await worn(), [ground, accent], `a ${scheme} device wears the template's ${way}`);
  if (shots) await page.screenshot({ path: `${shots}/welcome-${scheme}.png` });
}

await page.click('#chat .hint .langs button:has-text("Nederlands")');
await page.waitForSelector('#dir-msg.err');
assert.equal(messages.length, 0, "a language that wasn't saved sends no line");
assert.equal(await page.$$eval('#chat .hint .langs button:disabled', l => l.length), 0, 'and the choice is open again');

saveDown = false;
await page.click('#chat .hint .langs button:has-text("Nederlands")');
await page.waitForSelector('#chat li.me');
assert.deepEqual(saved, ['nl'], 'the code is saved as the company language');
assert.deepEqual(
  messages.map(m => m.text),
  ['Nederlands'],
  "and the language's own name is the board's first line",
);
assert.deepEqual(await picks(), [], 'the choice is gone once the conversation starts');

// held to talk, in the same intercom: the transcriber is asked in the picked language
const mic = await page.$('#mic');
assert.equal(await mic.isDisabled(), false, 'the mic can record here');
const box = await mic.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForSelector('#voicebar:not([hidden])');
await page.waitForTimeout(3000);
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#dir-title').value.includes('hallo'));
assert.ok(heard.length, 'the recording went to the transcriber');
assert.deepEqual([...new Set(heard)], ['nl'], 'in the picked language, not the one the intercom opened with');

welcome = false;
messages.length = 0;
await page.goto(hq);
await page.waitForSelector('#btn-intercom');
await page.waitForTimeout(1000);
assert.equal(await page.$('#chat'), null, 'a company with a team opens on HQ, not the intercom');

assert.deepEqual(errors, []);
await context.unrouteAll({ behavior: 'ignoreErrors' }); // (HQ's polls still under way)
await browser.close();
server.close();
console.log('welcome-check: ok');
