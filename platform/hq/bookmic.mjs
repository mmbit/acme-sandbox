// book-check.mjs's stories of the microphone, each on an iPad mini. Only a tap on a mic may bring up the browser's
// question, so nothing else asks for it. On HQ's page a circle or the pen held still asks nothing, and in the book a
// line, a lifted finger or a double tap held asks nothing either: that hold's slip says to tap a mic first. Each ask is
// refused, as the board might. Once a tap has allowed it, every recorder on HQ's page may use it, even where the browser
// can't say so. A page in HQ's viewer that posts review mode's offer, by itself or from its own button's tap, only
// brings up HQ's mic key where it says: HQ records for it only at the board's tap on that key, never one in its first
// half second there, and the page hears nothing back before.
// (its helpers from bookkit.mjs)
import assert from 'node:assert/strict';
import { freePage, paperBox } from './bookmouse.mjs';
import { voiceServed } from './bookvoice.mjs';
import { MINI, PREVIEW, QUIET_MS, chromiumPen, pressAlong, previewServed, touchOf, ui } from './bookkit.mjs';

const HELD = [250, 620]; // (where the pen's held still on HQ's page, clear of the book)

// c: book-check's { hqIn, base, reviewJs, posts, settled, ring, noErrorsIn, notebook, pages }
export function micStories(c) {
  return {
    'the microphone not yet allowed: only the post-it’s mic asks for it, once tapped, and a refusal is not asked again':
      browser => onHq({ ...c, browser }),
    'the microphone not yet allowed: a line drawn, a finger lifted or a double tap held in the book never asks for it, the hold says to tap a mic':
      browser => inBook({ ...c, browser }),
    'the microphone allowed by the post-it’s mic, the browser not saying: a press held in the book listens': browser =>
      across({ ...c, browser }),
    'a page in HQ’s viewer offering its mic from its own button’s tap: HQ’s key shows, records nothing, takes no tap as it moves, and answers only the offer’s end':
      browser => pagePosted({ ...c, browser }),
  };
}

async function onHq(c) {
  const { page, errors, done } = await unallowed(c, MINI);
  const asked = () => page.evaluate(() => window.micsAsked),
    heldStill = async () => {
      await pressAlong(page, [HELD], { lift: false });
      await page.waitForTimeout(2000);
      assert.equal(await page.locator(ui('.listen:not([hidden])')).count(), 0, 'the pen held still listens to nothing');
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
    // (the double tap in one evaluate: on a loaded worker one CDP press after another can miss its window)
    const held = await pressAlong(page, [at], { lift: false, doubleTap: true });
    await page
      .locator('#book .bk-voice[data-state="said"]', { hasText: 'Tap a mic once' })
      .waitFor({ timeout: 15_000 });
    await held.up();
    await page.waitForTimeout(QUIET_MS);
    assert.equal(await page.evaluate(() => window.micsAsked), 0, 'nothing asked for the microphone');
    assert.deepEqual(errors, []);
  } finally {
    await done();
  }
}

async function across(c) {
  freePage(c); // (the book opens on it: paper a voice note can be held on)
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
    // (a mouse's press held still, a microphone connected: the book's hold with no tap's timing in it)
    const paper = await paperBox(page);
    await page.mouse.move(paper.x + paper.width / 2, paper.y + 200);
    await page.mouse.down();
    await page.locator('#book .bk-voice').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => window.micsAsked === 2, null, { timeout: 15_000 }); // (the book's recording)
    await page.mouse.up();
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
  await context.addInitScript(() => {
    window.micsAsked = 0;
    // (on the prototype: WebKit's own can't be written over on the object)
    Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
      configurable: true,
      value: async () => {
        window.micsAsked++;
        throw new DOMException('Refused', 'NotAllowedError');
      },
    });
  });
  if (mic) await context.addInitScript(mic);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${c.base}/?intro=0`);
  await page.waitForSelector('#loading.gone', { state: 'attached' });
  await c.settled(page, 'open');
  return { page, errors, context, done: () => context.close() };
}
