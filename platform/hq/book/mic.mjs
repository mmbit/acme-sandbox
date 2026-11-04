// node platform/hq/book-check.mjs --stories 'microphone|live call' [--webkit]
// The book's mic tapped and a spot held uses the call's live microphone on both iPad mini orientations and desktop.
// Only a mic's tap asks permission: nothing drawn or held in the book does, a double tap held there saying to tap the
// mic once. A refusal is not asked again, and a stream allowed by one recorder can serve another.
// A preview offers its mic over a message port, but HQ records only at a tap on its own key after it stops moving.
import assert from 'node:assert/strict';
import { freePage, paperBox } from './mouse.mjs';
import { microphone, voiceServed, SAID } from './voice.mjs';
import { playLine } from './call.mjs';
import { press } from './bar.mjs';
import { DESKTOP, MINI, UPRIGHT, QUIET_MS, chromiumPen, pressAlong, say, touchOf, ui } from './kit.mjs';
import { PREVIEW, previewServed } from './preview.mjs';
import { watchedPage } from './start.mjs';

const HELD = [250, 620]; // (where the pen's held still on HQ's page, clear of the book)

// c: book-check's { hqIn, base, reviewJs, posts, settled, ring, noErrorsIn, notebook, pages }
export function micStories(c) {
  return {
    ...Object.fromEntries(
      [MINI, UPRIGHT, DESKTOP].map(viewport => [
        `a voice note uses the live call microphone without a switch at ${viewport.width} × ${viewport.height}`,
        browser => onCall({ ...c, browser }, viewport),
      ]),
    ),
    'the microphone not yet allowed: only the post-it’s mic asks for it, once tapped, and a refusal is not asked again':
      browser => onHq({ ...c, browser }),
    'the microphone not yet allowed: a line drawn, a finger lifted or a press held in the book never asks for it, the book’s mic asks once tapped':
      browser => inBook({ ...c, browser }),
    'the microphone allowed by the post-it’s mic, the browser not saying: the book’s mic opens it at its tap':
      browser => across({ ...c, browser }),
    'a page in HQ’s viewer offering its mic from its own button’s tap: HQ’s key shows, records nothing, takes no tap as it moves, and answers only the offer’s end':
      browser => pagePosted({ ...c, browser }),
  };
}

// The call owns the only opened microphone. Safari need not expose its permission or enumerate it by name.
async function onCall(c, viewport) {
  const context = await c.hqIn(c.browser, viewport, { hasTouch: true, notebooks: {} });
  await context.clearPermissions();
  await playLine(context);
  await callMic(context);
  await context.route(`${c.base}/api/voice**`, r => r.fulfill({ json: { text: SAID } }));
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=brownstone`);
    await page.waitForSelector('#loading.gone');
    await page.locator('#call').dispatchEvent('click');
    // (picked up: the key there and enabled, never a call already over)
    await page.waitForFunction(() => document.querySelector('#call-screenshare')?.disabled === false);
    await page.evaluate(() => import('/shell/call.js').then(call => call.minimiseCall()));
    if (await page.evaluate(() => document.documentElement.dataset.book === 'folded'))
      await page.locator('#book .bk-lip').dispatchEvent('click');
    await c.settled(page, viewport.width > viewport.height ? 'open' : 'spread');
    await callTapped(page, true);
    await callTapped(page);
    await page.locator('#book .bk-typed', { hasText: SAID }).waitFor();
    assert.equal(await page.evaluate(() => window.micsAsked), 1, 'the voice note opens no second microphone');
    assert.equal(
      await page.evaluate(() => window.callTrack.readyState),
      'live',
      'finishing the note keeps the call mic',
    );
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

// (on MediaDevices' prototype: WebKit may let the page's navigator.mediaDevices go and make it again, without what was
// set on it, when nothing in the page holds it)
async function callMic(context) {
  await context.addInitScript(() => {
    const microphone = MediaDevices.prototype.getUserMedia;
    window.micsAsked = 0;
    MediaDevices.prototype.getUserMedia = async () => {
      if (++window.micsAsked > 1) throw new Error('The call already owns the microphone');
      const stream = await microphone();
      window.callTrack = stream.getAudioTracks()[0];
      return stream;
    };
    MediaDevices.prototype.enumerateDevices = async () => [];
    Object.defineProperty(Permissions.prototype, 'query', {
      configurable: true,
      value: () => Promise.reject(new TypeError('microphone')),
    });
  });
}

// The book's mic tapped, then a spot held: recording at once, with no switch-on prompt; Escape lets it go, or letting
// go lands the words
async function callTapped(page, cancel = false) {
  await press(page, 'Voice note');
  const paper = await paperBox(page),
    at = [paper.x + paper.width * 0.3, paper.y + paper.height * 0.5];
  await finger(page, 'pointerdown', at);
  const words = page.locator('#book .bk-heard');
  await words.waitFor({ timeout: 1000 });
  await page.waitForTimeout(1200);
  assert.equal(
    await page.locator('#book .bk-mic').getAttribute('data-listening'),
    '',
    'a spot held records without a switch-on prompt',
  );
  if (cancel) {
    await page.keyboard.press('Escape');
    await words.waitFor({ state: 'detached' });
  }
  await finger(page, 'pointerup', at);
  if (cancel)
    assert.equal(await page.evaluate(() => window.callTrack.readyState), 'live', 'cancelling keeps the call mic');
}
// A finger's pointer event as Safari hands it over, on what's at its point
const finger = (page, type, [x, y]) =>
  page.evaluate(
    ({ type, x, y }) =>
      document.elementFromPoint(x, y).dispatchEvent(
        new PointerEvent(type, {
          ...{ pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y },
          ...{ buttons: type === 'pointerup' ? 0 : 1, bubbles: true, composed: true, cancelable: true },
        }),
      ),
    { type, x, y },
  );

async function onHq(c) {
  const { page, errors, done } = await unallowed(c, MINI);
  const asked = () => page.evaluate(() => window.micsAsked),
    heldStill = async () => {
      const shut = await page.locator(ui('.sheet')).isHidden();
      await pressAlong(page, [HELD], { lift: false });
      await page.waitForTimeout(2000);
      assert.equal(await page.locator(ui('.sheet')).isHidden(), shut, 'the pen held still opens and closes nothing');
      await page.evaluate(() => window.__lift());
    };
  try {
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await heldStill();
    assert.equal(await asked(), 0, 'the pen held still asks for nothing');
    await pressAlong(page, c.ring(400, 640, 80, 45));
    await page.locator(ui('.sheet')).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(1000);
    assert.equal(await asked(), 0, 'a ring asks for nothing');
    await page.locator(ui('.sheet .mic')).dispatchEvent('click'); // (a tap: no navigation to wait for)
    await page.locator(ui('.msg'), { hasText: /microphone is blocked/ }).waitFor({ timeout: 15_000 });
    assert.equal(await asked(), 1, 'the mic tapped asks, once');
    await heldStill();
    assert.equal(await asked(), 1, 'refused, nothing asks again on its own');
    c.noErrorsIn(errors.filter(e => !/Refused/.test(e)));
  } finally {
    await done();
  }
}

async function inBook(c) {
  const { page, errors, done, context } = await unallowed(c, MINI, { hasTouch: true, deviceScaleFactor: 1 });
  try {
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    const cdp = await context.newCDPSession(page),
      pen = chromiumPen(cdp),
      touch = touchOf(cdp),
      paper = await paperBox(page),
      at = [paper.x + paper.width / 2 - 60, paper.y + 200];
    await pen.down([at[0], at[1] + 120]);
    for (let i = 1; i <= 12; i++) await pen.move([at[0] + i * 10, at[1] + 120]);
    await pen.up([at[0] + 120, at[1] + 120]);
    await touch.stroke([[at[0], at[1] + 200]], [[at[0] + 120, at[1] + 200]]);
    // the Pencil held still a second and a half: no voice note, nothing asked
    const held = await pressAlong(page, [at], { lift: false });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#book .bk-heard').count(), 0, 'a press held still listens to nothing');
    await held.up();
    // a double tap held: before the microphone is allowed it listens to nothing, a toast saying to tap the mic once
    const twice = [at[0], at[1] + 60];
    await pen.tap(twice);
    await pen.down(twice);
    await page.locator('.toast', { hasText: say('micFirstTap') }).waitFor({ timeout: 5000 });
    await pen.up(twice);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(await page.evaluate(() => window.micsAsked), 0, 'nothing asked for the microphone');
    // the book's mic tapped asks, once, and says it's blocked when refused
    await press(page, 'Voice note');
    await page.locator('.toast', { hasText: 'blocked' }).waitFor({ timeout: 15_000 });
    assert.equal(await page.evaluate(() => window.micsAsked), 1, 'the mic tapped asked, once');
    c.noErrorsIn(errors.filter(e => !/Refused/.test(e)));
  } finally {
    await done();
  }
}

async function across(c) {
  freePage(c); // (the book opens on it: paper a voice note can land on)
  const { page, errors, done } = await unallowed(c, MINI, {}, () => {
    // (the browser can't say: the 'microphone' permission unknown, as where the query rejects)
    const query = Permissions.prototype.query;
    Object.defineProperty(Permissions.prototype, 'query', {
      configurable: true,
      value(d) {
        return d?.name === 'microphone' ? Promise.reject(new TypeError('microphone')) : query.call(this, d);
      },
    });
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      value: async () => {
        window.micsAsked++;
        return new AudioContext().createMediaStreamDestination().stream;
      },
    });
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'mic', label: '' }];
  });
  try {
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await pressAlong(page, c.ring(400, 640, 80, 45));
    await page.locator(ui('.sheet')).waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator(ui('.sheet .mic')).dispatchEvent('click');
    await page.locator(ui('.sheet .mic.on')).waitFor({ timeout: 15_000 });
    await page.locator(ui('.sheet .mic')).dispatchEvent('click');
    assert.equal(await page.evaluate(() => window.micsAsked), 1, 'the post-it’s mic recorded');
    await press(page, 'Voice note');
    await page.waitForFunction(() => window.micsAsked === 2, null, { timeout: 15_000 }); // (opened at the mic's tap)
    assert.equal(await page.locator('#book .bk-mic').getAttribute('aria-pressed'), 'true', 'the mic waits for a spot');
    await press(page, 'Voice note');
    assert.equal(await page.locator('#book .bk-mic').getAttribute('aria-pressed'), 'false', 'tapped again, it lets go');
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// The page in HQ's viewer posts review mode's offer of its mic from its own button, with HQ's microphone allowed, and
// the board taps that button: the tap activates HQ's window too, and still HQ records nothing and tells the page nothing
// but its offer's end, its key waiting for a tap of its own. The page moving the key under the board's tap gets that tap
// taken by nothing (moved). The offer comes as review mode's does, with the page's number and a line of its own (HQ's
// framemic.js).
async function pagePosted(c) {
  const { page, errors, done, context } = await unallowed(c, MINI, {}, () => {
    Object.defineProperty(Permissions.prototype, 'query', {
      configurable: true,
      value: async () => ({ state: 'granted', onchange: null }),
    });
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      value: async () => {
        window.micsAsked++;
        return new AudioContext().createMediaStreamDestination().stream;
      },
    });
  });
  try {
    await voiceServed(c, context);
    await previewServed(c, context);
    await page.evaluate(url => import('/shell/desk.js').then(desk => desk.openLink(url)), `${PREVIEW}/basket`);
    await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 }); // (review mode said hello)
    const frame = page.frame({ url: /scrap\.preview\.test/ });
    await buyAsks(frame, c.base);
    await frame.locator('#buy').click();
    const key = page.locator('#viewer > .framemic');
    await key.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(2500);
    assert.equal(await key.getAttribute('data-phase'), 'ready', 'the key waits for the board’s tap');
    await frame.evaluate(() => window.line.postMessage({ mic: 'stop' }));
    await moved(page, frame, key);
    await frame.evaluate(() => window.line.postMessage({ mic: 'cancel' }));
    await key.waitFor({ state: 'detached', timeout: 15_000 });
    assert.equal(await page.evaluate(() => window.micsAsked), 0, 'HQ never started its microphone');
    const back = await frame.evaluate(() => window.heardBack);
    assert.ok(
      back.length && back.every(m => m.dropped || m.done === null),
      `the page heard only its offer’s end: ${JSON.stringify(back)}`,
    );
    c.noErrorsIn(errors.filter(e => !/Refused|getUserMedia|Microphone/.test(e)));
  } finally {
    await done();
  }
}

// The page's own Buy button, posting review mode's offer with a line of its own (window.ask, window.line its end), and
// everything said back to the page, on that line or its window, kept in window.heardBack
const buyAsks = (frame, hq) =>
  frame.evaluate(hq => {
    window.heardBack = [];
    const heard = e => e.data?.mic && window.heardBack.push(e.data.mic);
    addEventListener('message', heard);
    window.ask = () => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = heard;
      window.line = port1;
      parent.postMessage({ hq: 'review', mic: 'offer', doc: 7, at: { x: 20, y: 20, w: 52, h: 52 } }, hq, [port2]);
    };
    const buy = document.createElement('button');
    buy.id = 'buy';
    buy.textContent = 'Buy';
    buy.onclick = () => window.ask();
    document.body.prepend(buy);
  }, hq);

// The page moves HQ's key to where the board is about to tap: the tap, at once, is taken by nothing
async function moved(page, frame, key) {
  const was = await key.boundingBox();
  await frame.evaluate(() => window.line.postMessage({ mic: 'at', at: { x: 160, y: 120, w: 52, h: 52 } }));
  await page.waitForFunction(x => document.querySelector('#viewer > .framemic').getBoundingClientRect().x !== x, was.x);
  await key.click();
  assert.equal(await key.getAttribute('data-phase'), 'ready', 'a tap as the key moves under it isn’t taken');
}

// HQ with the microphone not allowed, each time the page asks for it counted (window.micsAsked) and refused; mic: what
// the browser's microphone does instead, if anything
async function unallowed(c, viewport, more, mic) {
  const context = await c.hqIn(c.browser, viewport, more);
  await context.clearPermissions();
  await microphone(context, false);
  if (mic) await context.addInitScript(mic);
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone', { state: 'attached' });
  await c.settled(page, 'open');
  return { page, errors, context, done: () => context.close() };
}
