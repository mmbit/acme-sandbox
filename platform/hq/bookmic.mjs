// book-check.mjs's stories of the microphone, each on an iPad mini. Only a tap on a mic may bring up the browser's
// question, so nothing else asks for it. On HQ's page a circle or the pen held still asks nothing, and in the book a
// line, a lifted finger or a double tap held asks nothing either: that hold's slip says to tap a mic first. Each ask is
// refused, as the board might. Once a tap has allowed it, every recorder on HQ's page may use it, even where the browser
// can't say so. A page in HQ's viewer that posts review mode's ask, by itself or from its own button's tap, only brings
// up Talk on HQ's bar: HQ records for it only at the board's tap on Talk, and the page hears nothing back before.
// (its helpers from bookkit.mjs)
import assert from 'node:assert/strict';
import { QUIET_MS, touchOf } from './bookstrip.mjs';
import { freePage, paperBox } from './bookmouse.mjs';
import { MINI, chromiumPen, pressAlong, ui } from './bookkit.mjs';
import { PREVIEW, previewServed } from './bookscrap.mjs';

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
    'a page in HQ’s viewer asking for the microphone from its own button’s tap: Talk shows, HQ records nothing and answers only the ask’s end':
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
    await penPressed(page, at, ['pointerdown', 'pointerup', 'pointerdown']);
    await page
      .locator('#book .bk-voice[data-state="said"]', { hasText: 'Tap a mic once' })
      .waitFor({ timeout: 15_000 });
    await penPressed(page, at, ['pointerup']);
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

// The page in HQ's viewer posts review mode's ask for the microphone from its own button, with HQ's microphone allowed,
// and the board taps that button: the tap activates HQ's window too, and still HQ records nothing and tells the page
// nothing but its ask's end, its Talk waiting on the bar for a tap of its own. Talk the page flickers never comes under
// the board's tap on the address or Note either (flickered). The ask comes as review mode's does, with the page's number
// and a line of its own (HQ's framemic.js).
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
    await previewServed(c, context);
    await page.evaluate(url => import('/shell/desk.js').then(desk => desk.openLink(url)), `${PREVIEW}/basket`);
    await page.waitForSelector('#viewer .bar .pin:not([hidden])', { timeout: 15_000 }); // (review mode said hello)
    const frame = page.frame({ url: /scrap\.preview\.test/ });
    await buyAsks(frame, c.base);
    await frame.locator('#buy').click();
    await page.locator('#viewer .bar .talk:not([hidden])').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(2500);
    assert.equal(
      await page.locator('#viewer .bar .talk[data-phase=live]').count(),
      0,
      'Talk waits for the board’s tap',
    );
    await frame.evaluate(() => window.line.postMessage({ mic: 'stop' }));
    await page.locator('#viewer .bar .talk').waitFor({ state: 'hidden', timeout: 15_000 });
    await flickered(page, frame, c.base, context);
    assert.equal(await page.evaluate(() => window.micsAsked), 0, 'HQ never started its microphone');
    const back = await frame.evaluate(() => window.heardBack);
    assert.ok(
      back.length && back.every(m => m.dropped || m.done === null),
      `the page heard only its ask’s end: ${JSON.stringify(back)}`,
    );
    c.noErrorsIn(errors.filter(e => !/Refused|getUserMedia|Microphone/.test(e)));
  } finally {
    await done();
  }
}

// The page's own Buy button, posting review mode's ask with a line of its own (window.ask, window.line its end), and
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
      parent.postMessage({ hq: 'review', mic: 'start', doc: 7 }, hq, [port2]);
    };
    const buy = document.createElement('button');
    buy.id = 'buy';
    buy.textContent = 'Buy';
    buy.onclick = () => window.ask();
    document.body.prepend(buy);
  }, hq);

// The page flickers Talk (asks and takes it back), with Note gone and back (goodbye and hello) in turn, and each time Talk
// shows the board taps where the address ended before Talk's first ask, or where it ends with Note gone: the address or
// Note gets the tap, never Talk
async function flickered(page, frame, hq, context) {
  context.on('page', tab => tab.close()); // (the address's taps open the page in the browser)
  const talk = page.locator('#viewer .bar .talk'),
    tell = d => frame.evaluate(([hq, d]) => parent.postMessage({ hq: 'review', ...d }, hq), [hq, d]),
    where = await page.locator('#viewer .bar .where').boundingBox(),
    slot = await talk.boundingBox(),
    spots = [
      [where.x + where.width - 3, where.y + where.height / 2],
      [slot.x - 3, slot.y + slot.height / 2],
    ];
  for (let i = 0; i < 4; i++) {
    await tell(i % 2 ? { hello: 1, doc: 7 } : { bye: 1, doc: 7 });
    await frame.evaluate(() => window.ask());
    await talk.waitFor({ state: 'visible', timeout: 15_000 });
    await page.mouse.click(...spots[Math.floor(i / 2)]);
    await frame.evaluate(() => window.line.postMessage({ mic: 'cancel' }));
    await talk.waitFor({ state: 'hidden', timeout: 15_000 });
  }
  assert.deepEqual(await talk.boundingBox(), slot, 'Talk keeps its slot');
}

// The pen's presses at a point, dispatched in the page as the browser would hand them over
const penPressed = (page, [x, y], types) =>
  page.evaluate(
    ([x, y, types]) => {
      for (const type of types)
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
          new PointerEvent(type, {
            pointerId: 7,
            pointerType: 'pen',
            isPrimary: true,
            clientX: x,
            clientY: y,
            buttons: type === 'pointerup' ? 0 : 1,
            bubbles: true,
            composed: true,
            cancelable: true,
          }),
        );
    },
    [x, y, types],
  );

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
