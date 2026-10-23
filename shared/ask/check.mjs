#!/usr/bin/env node
// The button that asks once more (ask.js), in Chromium on a page of its own: the first tap asks in the page's live
// region and acts on nothing, a second tap within 500 ms (a double tap) does nothing, a later one acts once and drops
// back; it drops back by itself after 8 s, on a tap elsewhere (which still lands where it was aimed), on Tab away and
// when the page hides the button; a message the page writes meanwhile stays; a state that asks nothing acts at once;
// words are read in the page's current language; a steady one asks without moving the buttons beside it.
//   node shared/ask/check.mjs        Exit 1 on any failure.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { playwright } from '../demo/core.mjs';

const PAGE = `<!doctype html><meta charset="utf-8">
<button id="go">Cancel</button> <button id="other">Other</button> <button id="nl">nl</button> <button id="en">en</button>
<p id="ask" hidden></p>
<button id="hold">Go</button> <button id="next">Next</button> <p id="held"></p>
<script type="module">
import { askAgain } from '/ask.js';
const WORDS = { en: ['Cancel', 'Tap again to cancel', 'Cancel it?'], nl: ['Annuleren', 'Tik nog eens', 'Annuleren?'] };
let lang = 'en';
for (const to of ['nl', 'en'])
  document.querySelector('#' + to).onclick = () => {
    lang = to;
    window.ask.show(); // (a page repaints its words after a switch)
  };
const word = i => () => WORDS[lang][i];
window.acted = 0;
window.others = 0;
document.querySelector('#other').onclick = () => window.others++;
window.asking = true;
window.ask = askAgain(document.querySelector('#go'), {
  status: document.querySelector('#ask'),
  label: word(0),
  again: word(1),
  question: word(2),
  asks: () => window.asking,
  act: () => window.acted++,
});
askAgain(document.querySelector('#hold'), {
  status: document.querySelector('#held'),
  label: 'Go',
  again: 'Tap again to go',
  question: 'Go?',
  steady: true,
  act: () => {},
});
</script>`;

const server = createServer((req, res) => {
  const ask = req.url === '/ask.js';
  res.writeHead(200, { 'content-type': ask ? 'text/javascript' : 'text/html' });
  res.end(ask ? readFileSync(new URL('./ask.js', import.meta.url)) : PAGE);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const { chromium } = playwright();
const browser = await chromium.launch();
let failed = 0;
const check = (ok, what, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};

try {
  const page = await browser.newPage();
  page.on('pageerror', e => check(false, 'no page error', e.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ask);
  const state = () =>
    page.evaluate(() => ({
      label: document.querySelector('#go').textContent,
      ask: document.querySelector('#ask').textContent,
      hidden: document.querySelector('#ask').hidden,
      acted: window.acted,
      armed: window.ask.armed,
    }));
  const arm = async () => {
    await page.click('#go');
    return state();
  };
  const plain = s => s.label === 'Cancel' && s.ask === '' && s.hidden && !s.armed;

  check((await page.getAttribute('#ask', 'role')) === 'status', 'the question goes in a live region (role="status")');
  let s = await arm();
  check(
    s.label === 'Tap again to cancel' && s.ask === 'Cancel it?' && !s.hidden && s.armed && s.acted === 0,
    'the first tap asks, in place',
    s,
  );
  await page.click('#go');
  s = await state();
  check(s.armed && s.acted === 0, 'a second tap within 500 ms (a double tap) does nothing', s);
  await page.clock.runFor(600);
  await page.click('#go');
  s = await state();
  check(plain(s) && s.acted === 1, 'a later tap acts once and drops back', s);

  await page.dblclick('#go');
  s = await state();
  check(s.armed && s.acted === 1, 'a double click only asks', s);
  await page.clock.runFor(8100);
  check(plain(await state()), 'it drops back by itself after 8 s', await state());

  await arm();
  await page.click('#other'); // (beside it: it moves as the label shrinks)
  s = await state();
  check(
    plain(s) && (await page.evaluate(() => window.others)) === 1,
    'a tap anywhere else drops it back, and lands',
    s,
  );
  await arm();
  await page.click('#nl');
  s = await state();
  check(s.label === 'Annuleren' && !s.armed, 'a language switch drops it back, in the new language', s);
  s = await arm();
  check(s.label === 'Tik nog eens' && s.ask === 'Annuleren?', 'it asks in the page language of the moment', s);
  await page.click('#en');

  await page.focus('#go');
  await arm();
  await page.keyboard.press('Tab');
  check(plain(await state()), 'Tab away (the button losing focus) drops it back', await state());

  await arm();
  await page.evaluate(() => (document.querySelector('#go').hidden = true));
  await page.waitForFunction(() => !window.ask.armed);
  s = await state();
  check(s.ask === '' && s.hidden, 'the page hiding the button drops it back, with its question', s);
  await page.evaluate(() => (document.querySelector('#go').hidden = false));

  await arm();
  await page.evaluate(() => (document.querySelector('#ask').textContent = 'Sending…'));
  await page.evaluate(() => window.ask.disarm());
  s = await state();
  check(s.ask === 'Sending…' && !s.hidden && s.label === 'Cancel', 'a message the page wrote meanwhile stays', s);

  await page.evaluate(() => (window.asking = false));
  await page.click('#go');
  s = await state();
  check(!s.armed && s.acted === 2, 'a state that asks nothing acts at once', s);

  const next = () => page.evaluate(() => document.querySelector('#next').getBoundingClientRect().left);
  const resting = await next();
  await page.click('#hold');
  const asking = await next();
  check(
    (await page.textContent('#hold')) === 'Tap again to go' && asking === resting,
    'a steady one asks without moving the button beside it',
    { resting, asking },
  );
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
