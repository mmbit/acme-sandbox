#!/usr/bin/env node
// The pen in review mode, held like an iPad mini (touch, 744 × 1133): a pen's tap stays the page's, a pen drawn across
// the page starts a note right there, its lines stay open and keep coming until the note goes, a resting palm draws
// nothing once a pen has, the strip's inks and undo, and the note carries the lines (pressure and time) and a screenshot
// with them on it, and the post-it shows one Send and Cancel. The pin drags from its menu's handle too, and a tap on
// the handle still opens the menu. The mic button (never the mark) starts the mic, and the words come in live from a stand-in voice line
// as they're said, the clip taking over where the line can't be reached. Then the same on HQ itself in each of its looks, for the eye. Then
// an invited reviewer's (review mode as the coordinator serves it on a share's session) gets the same pen: pressure,
// open lines, inks, undo (the strip's and Cmd+Z), the note carrying its lines, and live words, with no language asked
// for by the page.
//   node shared/review/pen-check.mjs [--shots dir]
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { playwright, errorsOf, until } from '../browser/browser.mjs';
import { serve, ROOT } from '../../platform/hq/serve.mjs';
import { fulfilPart } from './parts.mjs';

const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shots) await mkdir(shots, { recursive: true });
const shot = async (name, page) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const PRODUCT = 'https://hello.preview.test';
const server = await serve(),
  base = `http://localhost:${server.address().port}`;
const reviewJs = (await readFile(`${ROOT}/shared/review/review.js`, 'utf8')).replace('{{HQ_ORIGIN}}', base);
// an invited reviewer's, as feedback.ts product() serves it to a share's session: the company's name in (here the
// product's).
const outsiderJs = reviewJs.replace('{{OUTSIDE}}', 'Hello');
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hello</title>
  <style>body { font: 20px system-ui; margin: 32px; background: #fdfaf3; } h1 { margin-top: 90px; font-size: 44px; } main { height: 2400px; }
    button { font: inherit; padding: 14px 24px; border-radius: 12px; border: 0; background: #2b2230; color: #fff; }</style>
  <main><h1>Hello, whoever you are</h1><p>A little card for a friend, folded by hand.</p>
  <button id="buy" onclick="this.dataset.taps = (+this.dataset.taps || 0) + 1">Order now</button></main>
  <script src="/__review/review.js" defer></script>`;

// ---- the coordinator, played: the notes, the clip's transcript, and the voice line's live words (dictations: the
// address each was opened at)
const posted = [],
  clips = [],
  dictations = [];
const SLOW_MS = 2000;
let line = 'live',
  frames = 0,
  ended = 0;
const browser = await playwright().chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
// An iPad mini of its own (its own storage), on the product's page with review mode served as `tool`: the page, its errors
// and the input it takes, and where the page's headline and button are.
let page, errors, cdp, h1, buy;
async function device(tool) {
  const context = await browser.newContext({
    viewport: { width: 744, height: 1133 },
    deviceScaleFactor: 2,
    hasTouch: true,
    permissions: ['microphone'],
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    const a = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (o) {
      return a.call(this, { ...o, mode: 'open' });
    };
  });
  await context.routeWebSocket(/\/__review\/dictate(\?.*)?$/, coordinator);
  await context.route(`${PRODUCT}/**`, r => product(r, tool));
  page = await context.newPage();
  errors = errorsOf(page);
  cdp = await context.newCDPSession(page);
  await page.goto(`${PRODUCT}/`);
  await page.waitForFunction(
    () => document.querySelector('review-mode')?.shadowRoot.querySelectorAll('.strip .pot').length === 5,
    null,
    { timeout: 10_000 },
  );
  h1 = await page.locator('h1').boundingBox();
  buy = await page.locator('#buy').boundingBox();
  return context;
}
function coordinator(ws) {
  dictations.push(ws.url());
  if (line === 'down') return ws.close({ code: 1011 });
  // (the look before last ends a phrase the last one goes on with: a word revised in punctuation and case is the same word)
  const words = ['Make the', 'Make the Headline.', 'Make the headline bigger.'];
  let said = 0;
  ws.onMessage(m => {
    if (typeof m !== 'string') {
      // the microphone, as 16 kHz PCM: a word or two each half second of it
      frames += m.length;
      if (said < 2 && frames > (said + 1) * 16000)
        ws.send(JSON.stringify({ type: 'heard', text: words[said++], partial: said < 2 }));
      return;
    }
    if (JSON.parse(m).type !== 'end') return;
    ended++;
    const last = () => {
      ws.send(JSON.stringify({ type: 'heard', text: words[2], partial: false }));
      ws.send(JSON.stringify({ type: 'done' }));
    };
    // (slow: the last phrase comes a while after the stop, as a long one does)
    if (line === 'slow') setTimeout(last, SLOW_MS);
    else last();
  });
}
function product(r, tool) {
  const path = new URL(r.request().url()).pathname;
  if (fulfilPart(r, path, tool)) return;
  if (path === '/__review/coach') return r.fulfill({ json: { show: false } });
  if (path === '/__review/mine') return r.fulfill({ json: { notes: posted.length } });
  if (path === '/__review/notes') {
    posted.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true, id: posted.length } });
  }
  if (path === '/__review/voice') {
    clips.push(r.request().postDataBuffer()?.length ?? 0);
    return r.fulfill({ json: { text: 'Words from the clip' } });
  }
  return r.fulfill({ contentType: 'text/html', body: PAGE });
}
const ui = fn => page.evaluate(fn);
const inUi = s => `review-mode >> css=${s}`;

// a pen, as Chromium's input reports one: pressure from the force, a line of points between where it goes
const pen = async (points, { force = p => 0.3 + 0.5 * p, type = 'pen' } = {}) => {
  const [x0, y0] = points[0];
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: x0,
    y: y0,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: type,
    force: force(0),
  });
  for (let i = 1; i < points.length; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: points[i][0],
      y: points[i][1],
      button: 'left',
      buttons: 1,
      pointerType: type,
      force: force(i / points.length),
    });
  }
  const [x1, y1] = points.at(-1);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: x1,
    y: y1,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: type,
    force: 0,
  });
};
const across = (x0, y0, x1, y1, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const loop = (cx, cy, rx, ry, n = 40) =>
  Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * 6.1), cy + ry * Math.sin((i / n) * 6.1)]);
const state = () =>
  ui(() => {
    const r = document.querySelector('review-mode').shadowRoot;
    return {
      veil: !r.querySelector('.veil').hidden,
      sheet: !r.querySelector('.sheet').hidden,
      marked: r.querySelector('.veil').classList.contains('marked'),
    };
  });
// the ink on screen at a point, as [r, g, b, a]
const inkAt = (x, y) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('review-mode').shadowRoot.querySelector('.ink'),
        k = c.width / c.getBoundingClientRect().width;
      return [...c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data];
    },
    [x, y],
  );
const red = ([r, g, b, a]) => a > 200 && r > 200 && g < 140 && b < 140,
  blue = ([r, , b, a]) => a > 200 && b > 180 && r < 120,
  black = ([r, g, b, a]) => a > 200 && r < 80 && g < 60 && b < 80;

// ---- the board's iPad
const context = await device(reviewJs);
await penNote({ board: true });
await writingArea();

// ---- a note drawn with the pen, sent (board: the board's; else an invited reviewer's, told once what goes with a
// note).
async function penNote({ board }) {
  // a pen's tap is the page's own: the button takes it, and review mode stays out of the way
  await pen([
    [buy.x + 40, buy.y + 20],
    [buy.x + 41, buy.y + 20],
  ]);
  assert.equal(await page.$eval('#buy', b => b.dataset.taps), '1', "a pen's tap reaches the page");
  assert.deepEqual(await state(), { veil: false, sheet: false, marked: false }, 'and starts nothing');

  // ---- drawn across the page, the pen starts a note right there: the line from where it touched, open, pressure-shaped
  await pen(loop(h1.x + 160, h1.y + h1.height / 2, 200, 50));
  await page.waitForFunction(() => !document.querySelector('review-mode').shadowRoot.querySelector('.sheet').hidden);
  assert.deepEqual(
    await state(),
    { veil: true, sheet: true, marked: true },
    'the first line opens the note, and the page stays drawable',
  );
  if (!board)
    assert.match(
      await page.locator(inUi('.msg')).innerText(),
      /picture of the screen go to the crew/,
      'an invited reviewer hears what goes with a note',
    );
  assert.ok(red(await inkAt(h1.x + 360, h1.y + h1.height / 2)), 'the line is on screen where it was drawn');
  assert.ok(
    !red(await inkAt(h1.x + 160 + 200 * Math.cos(6.1) - 2, h1.y + h1.height / 2 + 50 * Math.sin(6.1) - 30)),
    'and it stays open: nothing closes it',
  );
  // more lines, as many as wanted, until the note goes: a cross-out
  await pen(across(h1.x + 20, h1.y + 120, h1.x + 300, h1.y + 120));
  assert.ok(red(await inkAt(h1.x + 160, h1.y + 120)), 'a second line joins the first');
  // a palm resting on the screen draws nothing once the pen has drawn
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 700 }] });
  for (let i = 1; i <= 10; i++)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 500 + i * 12, y: 700 + i * 4 }],
    });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal((await inkAt(560, 720))[3], 0, 'a palm draws nothing');
  await page.waitForTimeout(1200); // (Chromium's fling after a scripted swipe takes the next tap)
  // another ink from the strip, and undo takes the last line back
  await page.locator(inUi('.strip .pot[aria-label=Blue]')).tap();
  await pen(across(h1.x + 20, h1.y + 200, h1.x + 300, h1.y + 200));
  assert.ok(blue(await inkAt(h1.x + 160, h1.y + 200)), 'the blue ink draws blue');
  await shot('pen-note-ipad', page);
  await page.locator(inUi('.strip .undo')).tap();
  assert.equal((await inkAt(h1.x + 160, h1.y + 200))[3], 0, 'undo takes the last line back');
  assert.ok(red(await inkAt(h1.x + 160, h1.y + 120)), 'and leaves the others');
  await penTools();
  assert.deepEqual(
    await page.locator(inUi('.sheet .row button:visible')).allInnerTexts(),
    ['', 'Cancel', board ? 'Save' : 'Pin it'],
    'the post-it: the mic, Cancel and one Send',
  );
  await page.locator(inUi('textarea')).fill('Bigger, and lose the second line');
  await page.locator(inUi('.send')).tap();
  await page.waitForFunction(
    () => document.querySelector('review-mode').shadowRoot.querySelector('.sheet').hidden,
    null,
    { timeout: 20_000 },
  );
  const sent = posted.at(-1);
  assert.equal(sent.element.kind, 'circle');
  assert.equal(sent.element.ink.length, 2, 'the note carries its two lines');
  const [first] = sent.element.ink;
  assert.equal(first.color, '#ff5a5f');
  assert.ok(new Set(first.points.map(p => p[2])).size > 5, "the pen's pressure goes with each point");
  assert.ok(
    first.points.at(-1)[3] > 0 && first.points.every((p, i, all) => !i || p[3] >= all[i - 1][3]),
    'and its time, for a replay',
  );
  assert.ok(sent.element.area.w > 300 && sent.element.area.h > 100, 'the area holds every line');
  // the screenshot has them on it, where they were
  const onShot = await page.evaluate(
    async ([url, x, y]) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
        g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const k = img.width / innerWidth;
      return [...g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data];
    },
    [sent.shot, h1.x + 160, h1.y + 120],
  );
  assert.ok(onShot[0] > 200 && onShot[1] < 150, `the screenshot carries the ink (${onShot})`);
  assert.deepEqual(await state(), { veil: false, sheet: false, marked: false }, 'sent, the page is the page again');
  assert.equal((await inkAt(h1.x + 160, h1.y + 120))[3], 0, 'and the ink is gone with the note');
}

// ---- the strip's tools with the Pencil: on an iPad a touch whose move the page refuses is no tap, so the Pencil's
// moves are refused on the page and never on the strip; then its taps choose an ink, the eraser takes lines out, and
// Undo brings them back
async function penTools() {
  const refused = s =>
    page.evaluate(s => {
      const r = document.querySelector('review-mode').shadowRoot,
        el = r.querySelector(s),
        b = el.getBoundingClientRect(),
        // (Chromium's touches have no touchType: the Pencil's, as Safari gives it)
        touch = Object.defineProperty(
          new Touch({ identifier: 7, target: el, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 }),
          'touchType',
          { value: 'stylus' },
        ),
        fire = type =>
          el.dispatchEvent(
            new TouchEvent(type, {
              touches: [touch],
              changedTouches: [touch],
              bubbles: true,
              composed: true,
              cancelable: true,
            }),
          );
      fire('touchstart');
      const moved = !fire('touchmove');
      fire('touchend');
      return moved;
    }, s);
  assert.equal(await refused('.strip .pot[aria-label=Black]'), false, "the Pencil's move on an ink is never refused");
  assert.equal(await refused('.strip .undo'), false, 'nor on Undo');
  assert.equal(await refused('.sheet textarea'), false, 'nor on the post-it');
  assert.equal(await refused('.veil'), true, 'and is on the page being marked, which never scrolls under it');
  const tap = async s => {
    const b = await page.locator(inUi(s)).boundingBox();
    await pen([
      [b.x + b.width / 2, b.y + b.height / 2],
      [b.x + b.width / 2 + 1, b.y + b.height / 2],
    ]);
  };
  await tap('.strip .pot[aria-label=Black]');
  await pen(across(h1.x + 20, h1.y + 240, h1.x + 300, h1.y + 240));
  assert.ok(black(await inkAt(h1.x + 160, h1.y + 240)), "the Pencil's tap on Black: it draws black");
  await tap('.strip .eraser');
  assert.equal(
    await page.locator(inUi('.strip .eraser')).getAttribute('aria-pressed'),
    'true',
    'the eraser is in hand',
  );
  await pen(across(h1.x + 160, h1.y + 90, h1.x + 160, h1.y + 260));
  assert.equal((await inkAt(h1.x + 160, h1.y + 240))[3], 0, 'the eraser passed across it, the black line goes');
  assert.equal((await inkAt(h1.x + 160, h1.y + 120))[3], 0, 'and the red cross-out it passed');
  assert.ok(red(await inkAt(h1.x + 360, h1.y + h1.height / 2)), 'and the ring it missed stays');
  await tap('.strip .undo');
  assert.ok(black(await inkAt(h1.x + 160, h1.y + 240)), "the Pencil's tap on Undo brings back what was erased");
  assert.ok(red(await inkAt(h1.x + 160, h1.y + 120)), 'all of it');
  await tap('.strip .undo');
  assert.equal((await inkAt(h1.x + 160, h1.y + 240))[3], 0, 'and again takes the black line back');
  await tap('.strip .pot[aria-label=Blue]'); // (the ink last chosen before: the mouse's rectangle draws in it)
  assert.equal(
    await page.locator(inUi('.strip .eraser')).getAttribute('aria-pressed'),
    'false',
    'an ink tapped puts the eraser down',
  );
}

// ---- the post-it's writing area: the iPad's handwriting (Scribble) looks for a field in a box round the pen's start,
// and stops at the first thing over it whose box fills that box: nothing that takes a touch may, anywhere on the words'
// field, the photo's framed screenshot included (wider than the photo, clipped only to the eye). The pen there brings no
// keyboard, a finger's tap does; and the post-it names the page: Home, never a lone "/"
async function writingArea() {
  // (the board's: its big button circled, so the photo's framed screenshot is many times the photo's size)
  await pen(loop(buy.x + buy.width / 2, buy.y + buy.height / 2, buy.width / 2 + 24, buy.height / 2 + 20));
  await page.waitForFunction(
    () => {
      const r = document.querySelector('review-mode').shadowRoot;
      return !r.querySelector('.sheet').hidden && r.querySelector('.polaroid:not(.busy) canvas.framed');
    },
    null,
    { timeout: 10_000 },
  );
  const over = await ui(() => {
    const r = document.querySelector('review-mode').shadowRoot,
      field = r.querySelector('.sheet textarea'),
      f = field.getBoundingClientRect(),
      found = [];
    for (const side of [40, 120])
      for (let x = f.left; x + side <= f.right; x += 20) {
        const y = f.top + f.height / 2 - side / 2;
        for (const el of r.querySelectorAll('.sheet *')) {
          if (el === field || el.contains(field) || getComputedStyle(el).pointerEvents === 'none') continue;
          const b = el.getBoundingClientRect();
          if (b.left <= x && b.top <= y && b.right >= x + side && b.bottom >= y + side)
            found.push(`${el.className || el.tagName} over ${Math.round(x - f.left)}px in (${side}px)`);
        }
      }
    return [...new Set(found)];
  });
  assert.deepEqual(over, [], 'nothing hides the words’ field from the handwriting, end to end');
  const mode = () => page.locator(inUi('.sheet textarea')).getAttribute('inputmode');
  assert.equal(await mode(), 'none', 'the pen on the field brings no keyboard');
  await page.locator(inUi('.sheet textarea')).tap();
  assert.equal(await mode(), null, "a finger's tap asks for it");
  await page.locator(inUi('.sheet textarea')).blur();
  assert.equal(await mode(), 'none', 'and once the field is left, the pen brings none again');
  assert.equal(await page.locator(inUi('.sheet .page')).innerText(), 'Home', 'the post-it names the home page');
  await page.locator(inUi('[data-cancel]')).tap();
}

// ---- the pin drags from its menu's handle, with a mouse and a finger, and a tap on the handle still opens the menu
const dockAt = () =>
  page.evaluate(() => {
    const r = document.querySelector('review-mode').shadowRoot.querySelector('.fab').getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y)];
  });
const more = await page.locator(inUi('.more')).boundingBox(),
  [fx, fy] = await dockAt();
await page.mouse.move(more.x + 18, more.y + 18);
await page.mouse.down();
await page.mouse.move(more.x - 100, more.y - 300, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500); // (it rests where it's let go)
const [mx, my] = await dockAt();
assert.ok(
  Math.abs(mx - (fx - 118)) < 4 && Math.abs(my - (fy - 318)) < 4,
  `the pin moved with its handle, from where it was held (${fx},${fy} → ${mx},${my})`,
);
assert.equal(await page.locator(inUi('.menu')).isVisible(), false, 'a drag opens no menu');
const touch = await page.locator(inUi('.more')).boundingBox();
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touch.x + 18, y: touch.y + 18 }] });
for (let i = 1; i <= 8; i++)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: touch.x + 18, y: touch.y + 18 + i * 25 }],
  });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(1200);
const [, ty] = await dockAt();
assert.ok(Math.abs(ty - (my + 200)) < 4, `a finger drags it too (${my} → ${ty})`);
await page.locator(inUi('.more')).tap();
assert.equal(await page.locator(inUi('.menu')).isVisible(), true, 'a tap on the handle opens the menu');

await page.locator(inUi('.more')).tap(); // (shut)
await dictated();

// ---- the mark starts no mic: its button does, and the words come in as they're said (the board, call 154)
async function dictated() {
  frames = 0;
  ended = 0;
  clips.length = 0;
  await pen(loop(h1.x + 160, h1.y + h1.height / 2, 180, 45));
  await page.locator(inUi('.sheet')).waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
  assert.equal(frames, 0, 'the mark records nothing by itself');
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('review-mode').shadowRoot.querySelector('.mic').classList.contains('on'),
    ),
    false,
    'its mic waits for a tap',
  );
  await page.locator(inUi('.mic')).tap();
  await page.waitForFunction(() =>
    document.querySelector('review-mode').shadowRoot.querySelector('.mic').classList.contains('on'),
  );
  await page.waitForFunction(
    () => document.querySelector('review-mode').shadowRoot.querySelector('textarea').value === 'Make the Headline.',
    null,
    { timeout: 15_000 },
  );
  assert.ok(frames > 30000, `the audio goes as it's heard (${frames} bytes so far)`);
  await page.locator(inUi('.mic')).tap();
  await page.waitForFunction(
    () =>
      document.querySelector('review-mode').shadowRoot.querySelector('textarea').value === 'Make the headline bigger.',
    null,
    { timeout: 10_000 },
  );
  assert.equal(ended, 1, 'the stop asks for the last phrase');
  assert.deepEqual(clips, [], 'with the line up, no clip goes');
}
await shot('pen-dictated-ipad', page);
// the line down: the clip's words, after what was there
line = 'down';
await page.locator(inUi('.mic')).tap();
await page.waitForTimeout(1500);
await page.locator(inUi('.mic')).tap();
await page.waitForFunction(
  () => /Words from the clip$/.test(document.querySelector('review-mode').shadowRoot.querySelector('textarea').value),
  null,
  { timeout: 10_000 },
);
assert.equal(await page.locator(inUi('textarea')).inputValue(), 'Make the headline bigger. Words from the clip');
assert.equal(clips.length, 1, 'the clip goes once');
// what the reviewer types while the mic is on stays, and only the words heard after it go in
line = 'up';
await page.locator(inUi('.mic')).tap();
await page.waitForFunction(
  () => / Make the Headline\.$/.test(document.querySelector('review-mode').shadowRoot.querySelector('textarea').value),
  null,
  { timeout: 10_000 },
);
await page.locator(inUi('textarea')).fill('Words from the clip, then make the logo');
await page.locator(inUi('.mic')).tap();
await page.waitForFunction(
  () => /bigger\.$/.test(document.querySelector('review-mode').shadowRoot.querySelector('textarea').value),
  null,
  { timeout: 10_000 },
);
assert.equal(await page.locator(inUi('textarea')).inputValue(), 'Words from the clip, then make the logo bigger.');
await page.locator(inUi('[data-cancel]')).tap();
// a note cancelled while its stop waits for the last phrase: those words go in no note
line = 'slow';
ended = 0;
await pen(loop(h1.x + 160, h1.y + h1.height / 2, 180, 45));
await page.locator(inUi('.mic')).tap();
await page.waitForFunction(
  () => document.querySelector('review-mode').shadowRoot.querySelector('textarea').value === 'Make the Headline.',
  null,
  { timeout: 15_000 },
);
await page.locator(inUi('.mic')).tap();
for (let i = 0; i < 50 && !ended; i++) await page.waitForTimeout(100);
assert.equal(ended, 1, 'the stop asks for the last phrase');
await page.locator(inUi('[data-cancel]')).tap();
await page.waitForTimeout(SLOW_MS + 1000);
assert.equal(await page.locator(inUi('textarea')).inputValue(), '', "a cancelled note's last words go in no note");
line = 'up';
assert.deepEqual(errors, []);

// ---- a mouse: the pin starts it, a drag draws (Shift a rectangle), and a click as the first mark still pins
await page.setViewportSize({ width: 1280, height: 800 });
await page.locator(inUi('.fab')).click({ force: true });
await page.mouse.move(100, 160);
await page.mouse.down();
await page.mouse.move(300, 180, { steps: 10 });
await page.mouse.up();
await page.waitForFunction(() => !document.querySelector('review-mode').shadowRoot.querySelector('.sheet').hidden);
await page.keyboard.down('Shift');
await page.mouse.move(80, 300);
await page.mouse.down();
await page.mouse.move(400, 360, { steps: 6 });
await page.mouse.up();
await page.keyboard.up('Shift');
assert.ok(
  blue(await inkAt(240, 300)) && blue(await inkAt(400, 330)),
  'Shift draws a rectangle, as a line (in the ink last chosen)',
);
await page.keyboard.press('ControlOrMeta+z');
assert.equal((await inkAt(240, 300))[3], 0, 'Cmd or Ctrl+Z takes it back');
// the strip's inks, eraser and Undo with a mouse too, and the page named
const mouseLine = async (x0, y0, x1, y1) => {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
};
await page.locator(inUi('.strip .pot[aria-label=Black]')).click();
await mouseLine(100, 240, 300, 240);
assert.ok(black(await inkAt(200, 240)), 'a click on Black: it draws black');
await page.locator(inUi('.strip .eraser')).click();
await mouseLine(200, 140, 200, 260);
assert.equal((await inkAt(200, 240))[3] + (await inkAt(200, 170))[3], 0, 'the eraser takes both lines it crosses');
await page.locator(inUi('.strip .undo')).click();
assert.ok(black(await inkAt(200, 240)) && blue(await inkAt(200, 170)), 'and Undo brings them back');
await page.locator(inUi('.strip .pot[aria-label=Blue]')).click();
assert.equal(await page.locator(inUi('.sheet .page')).innerText(), 'Home', 'the post-it names the home page');
// a note keeps 64 lines (the coordinator's cap), and the pen says so rather than drop one unseen
for (let i = 0; i < 64; i++) {
  const x = 20 + (i % 7) * 48,
    y = 340 + Math.floor(i / 7) * 45; // (left of the sheet)
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y + 30, { steps: 3 });
  await page.mouse.up();
}
assert.match(await page.locator(inUi('.msg')).innerText(), /64 lines at most/, 'the 65th line is refused, and said');
await page.keyboard.press('Escape');
await page.locator(inUi('.fab')).click({ force: true });
await page.mouse.click(buy.x + 30, buy.y + 20);
await page.waitForFunction(() => !document.querySelector('review-mode').shadowRoot.querySelector('.sheet').hidden);
assert.match(
  await page.locator(inUi('.chip')).innerText(),
  /<button>/,
  'a click as the first mark pins what it was on',
);
await page.keyboard.press('Escape');
assert.deepEqual(errors, []);

// ---- on HQ itself, in each look, for the eye: the strip and a line over HQ's own screen
if (shots) {
  const hqPage = await context.newPage();
  await context.route(`${base}/__review/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, reviewJs)) return;
    if (path === '/__review/mine') return r.fulfill({ json: { notes: 0 } });
    return r.fulfill({ json: { show: false } });
  });
  await hqPage.setViewportSize({ width: 744, height: 1133 });
  for (const look of ['brownstone', 'wire', 'holo']) {
    await hqPage.goto(`${base}/?intro=0&renderer=${look}`);
    await until(hqPage, '#loading.gone');
    await hqPage.waitForSelector('review-mode .fab');
    await hqPage.waitForFunction(
      () => document.querySelector('review-mode').shadowRoot.querySelectorAll('.strip .pot').length === 5,
    );
    await hqPage.locator('review-mode >> css=.fab').click({ force: true });
    const hcdp = await context.newCDPSession(hqPage);
    const d = loop(372, 300, 220, 60);
    await hcdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: d[0][0],
      y: d[0][1],
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'pen',
      force: 0.4,
    });
    for (const [x, y] of d.slice(1))
      await hcdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left',
        buttons: 1,
        pointerType: 'pen',
        force: 0.5,
      });
    await hcdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: d.at(-1)[0],
      y: d.at(-1)[1],
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'pen',
      force: 0,
    });
    await hqPage.waitForTimeout(900);
    await shot(`hq-${look}-pen`, hqPage);
    await hqPage.keyboard.press('Escape');
  }
}

// ---- an invited reviewer's iPad: review mode as a share's session gets it, the same pen
await device(outsiderJs);
dictations.length = 0;
await penNote({ board: false });
await dictated();
assert.ok(
  dictations.every(url => new URL(url).search === ''),
  `the page asks for no language: the coordinator decides it, none for an outsider (${dictations})`,
);
await pen(across(h1.x + 20, h1.y + 200, h1.x + 300, h1.y + 200));
assert.ok(blue(await inkAt(h1.x + 160, h1.y + 200)), 'another line on the open note, in the ink last chosen');
await page.keyboard.press('ControlOrMeta+z');
assert.equal((await inkAt(h1.x + 160, h1.y + 200))[3], 0, 'and Cmd or Ctrl+Z takes it back');
await shot('pen-outsider-ipad', page);
await page.locator(inUi('[data-cancel]')).tap();
assert.deepEqual(errors, []);

await browser.close();
server.close();
console.log(
  `pen-check: a pen's tap is the page's, a pen line starts a note where it's drawn, open lines until it goes, a palm draws nothing, inks and undo, the lines (pressure, time) and a screenshot with them on the note, the pin dragged by its handle (mouse and finger) and the handle's tap opening the menu, the mic started by its button, never the mark, live words and the clip when the line is down, a mouse's lines, rectangle, Cmd+Z, inks, eraser and pin; the Pencil's taps on the strip, its eraser and Undo, the post-it's writing area clear for the handwriting with no keyboard for the pen, and the home page named${shots ? `, HQ in each look` : ''}, and the same pen for an invited reviewer (no language of ours)${shots ? ` (screenshots in ${shots})` : ''}`,
);
