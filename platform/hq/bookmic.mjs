// book-check.mjs's stories of the microphone, not yet allowed, held like an iPad mini: nothing asks for it but a tap on
// a mic (the board, call 158). On HQ's page, not a ring and not the pen held
// still, only the post-it's mic, tapped, asks, and once refused nothing asks again on its own; in the book, not a line
// drawn, a finger lifted or a double tap held, which is then no voice note. Each ask is refused, as the board would.
// Once allowed, it's allowed for every recorder on HQ's page: the post-it's mic recorded once, where the browser can't
// say, and a press held in the book is a voice note. And HQ's allowed state is the viewer's: reset in the
// browser, a held start from the viewer's page asks nothing.
import assert from 'node:assert/strict';
import { MINI, QUIET_MS, penOf, touchOf } from './bookstrip.mjs';
import { freePage, paperBox } from './bookmouse.mjs';

const HELD = [250, 620]; // (where the pen's held still on HQ's page, clear of the book)
const ui = s => `review-mode >> css=${s}`;

// c: book-check's { hqIn, base, MINI, settled, penOn, ring, noErrorsIn, notebook, pages }
export function micStories(c) {
  return {
    'the microphone not yet allowed: only the post-it’s mic asks for it, once tapped, and a refusal is not asked again':
      browser => onHq({ ...c, browser }),
    'the microphone not yet allowed: a line drawn, a finger lifted or a double tap held in the book never asks for it':
      browser => inBook({ ...c, browser }),
    'the microphone allowed by the post-it’s mic, the browser not saying: a press held in the book listens': browser =>
      across({ ...c, browser }),
    'HQ’s microphone reset in the browser: a held start from the viewer’s page asks nothing, a tap’s still asks':
      browser => reset({ ...c, browser }),
  };
}

async function onHq(c) {
  const { page, errors, done } = await unallowed(c, c.MINI);
  const asked = () => page.evaluate(() => window.micsAsked),
    heldStill = async () => {
      await c.penOn(page)([HELD], { lift: false });
      await page.waitForTimeout(2000);
      assert.equal(await page.locator(ui('.listen:not([hidden])')).count(), 0, 'the pen held still listens to nothing');
      await page.evaluate(() => window.__lift());
    };
  try {
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await heldStill();
    assert.equal(await asked(), 0, 'the pen held still asks for nothing');
    await c.penOn(page)(c.ring(400, 640, 80, 45));
    await page.locator(ui('.sheet')).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(1000);
    assert.equal(await asked(), 0, 'a ring asks for nothing');
    await page.locator(ui('.sheet .mic')).dispatchEvent('click'); // (a tap: no navigation to wait for)
    await page.locator(ui('.msg'), { hasText: /microphone is blocked/ }).waitFor({ timeout: 15_000 });
    assert.equal(await asked(), 1, 'the mic tapped asks, once');
    // (held still with the post-it open: once the mic was tapped it used to tap it again)
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
      pen = penOf(cdp),
      touch = touchOf(cdp),
      paper = await paperBox(page),
      at = [paper.x + paper.width / 2 - 60, paper.y + 200];
    await pen.down([at[0], at[1] + 120]);
    for (let i = 1; i <= 12; i++) await pen.move([at[0] + i * 10, at[1] + 120]);
    await pen.up([at[0] + 120, at[1] + 120]);
    await touch.stroke([[at[0], at[1] + 200]], [[at[0] + 120, at[1] + 200]]);
    await pen.tap(at);
    await page.waitForTimeout(120);
    await pen.down(at);
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('#book .bk-voice').count(), 0, 'a double tap held is no voice note');
    await pen.up(at);
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
    await c.penOn(page)(c.ring(400, 640, 80, 45));
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

async function reset(c) {
  const { page, errors, done } = await unallowed(c, MINI, {}, () => {
    window.micStatus = { state: 'granted', onchange: null };
    const query = Permissions.prototype.query;
    Object.defineProperty(Permissions.prototype, 'query', {
      configurable: true,
      value(d) {
        return d?.name === 'microphone' ? Promise.resolve(window.micStatus) : query.call(this, d);
      },
    });
  });
  try {
    // (the viewer's page's asks, as review mode's dictation.js sends them to desk.js, answered into replies)
    const heard = await page.evaluate(async () => {
      const { frameMic, stopFrameMic } = await import(new URL('shell/framemic.js', location.href).href),
        replies = [],
        viewer = { postMessage: d => replies.push(d.mic) };
      frameMic({ mic: 'state', id: 0 }, viewer, '*', 'en');
      window.micStatus.state = 'prompt';
      window.micStatus.onchange();
      frameMic({ mic: 'start', id: 1, held: true }, viewer, '*', 'en');
      await new Promise(resolve => setTimeout(resolve, 500));
      const held = window.micsAsked;
      frameMic({ mic: 'start', id: 2, held: false }, viewer, '*', 'en');
      await new Promise(resolve => setTimeout(resolve, 500));
      stopFrameMic();
      return { replies, held, tapped: window.micsAsked };
    });
    assert.deepEqual(heard.replies, [
      { id: 0, granted: true },
      { id: 1, granted: false, failed: 'held' },
      { id: 2, granted: false, failed: 'NotAllowedError' },
    ]);
    assert.equal(heard.held, 0, 'the held start asks nothing');
    assert.equal(heard.tapped, 1, 'a tap’s start asks');
    c.noErrorsIn(errors.filter(e => !/Refused/.test(e)));
  } finally {
    await done();
  }
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
