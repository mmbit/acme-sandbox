// book-check.mjs's steps for HQ's mic key, which records for the post-it's mic in HQ's viewer (shell/framemic.js): it
// lies over the post-it's mic while the post-it is open, only its tap records, at once, the words come into the post-it
// as they're said, and the offer goes with the page that made it. HQ records the microphone voiceServed plays over the
// stand-in voice line (bookvoice.mjs).
import assert from 'node:assert/strict';
import { until } from './bookkit.mjs';
import { transcriber } from './bookvoice.mjs';

const KEY = '#viewer > .framemic';
// The post-it's mic in HQ's viewer, whose frame has no microphone: HQ's own key lies over it as the post-it opens and
// records nothing by itself; one tap on it records at once, shows it's listening, and the words come into the post-it
// as they're said; tapped again it stops, ready for another go
export async function talkedInViewer({ page, shot, named }, frame, sheet) {
  const key = page.locator(KEY),
    mic = sheet.locator('.mic'),
    asked = () => counted(page, 'micsAsked'),
    said = () => sheet.locator('textarea').inputValue(),
    heard = (re, what) => until(async () => re.test(await said()), what),
    from = await asked();
  await key.waitFor({ state: 'visible' });
  await until(async () => {
    const [k, m] = [await key.boundingBox(), await mic.boundingBox()];
    return Math.abs(k.x - m.x) < 2 && Math.abs(k.y - m.y) < 2 && Math.abs(k.width - m.width) < 2;
  }, "HQ's key lying over the post-it's mic");
  await page.waitForTimeout(800); // (past the key's first half second, when a tap isn't taken)
  assert.equal(await asked(), from, 'nothing records before the tap');
  await key.click();
  assert.equal(await key.getAttribute('data-phase'), 'live', "one tap: HQ's key is listening");
  await until(async () => (await asked()) === from + 1, "HQ's key recording");
  await shot(named('viewer-talk'), page);
  await heard(/^Make this$/, 'the words coming into the post-it as they’re said');
  await key.click();
  await until(async () => /^Check the words/.test(await sheet.locator('.msg').innerText()), 'the words to check');
  assert.equal(await said(), 'Make this headline shorter', 'stopped at the key, the words stay');
  assert.equal(await key.getAttribute('data-phase'), 'ready', 'the key ready for another go');
  assert.equal(await counted(frame, '__micHeard'), 0, "HQ answers on the offer's line alone, never the window");
}
// The page's own code offering HQ its mic's place, as review mode does: with a line for the answers (window.__ask, its
// end)
const ownOffer = frame =>
  frame.evaluate(() => {
    const line = new MessageChannel();
    window.__ask = line.port1;
    parent.postMessage({ hq: 'review', mic: 'offer', doc: 1, at: { x: 24, y: 24, w: 52, h: 52 } }, '*', [line.port2]);
  });
// Every page's goodbye held back once window.__noBye is set there (a listener ahead of review mode's: the browser calls
// a window's listeners in the order they were added), the mic's messages any page hears on its window counted
// (window.__micHeard), the microphone's tracks stopped counted (window.__stops), and a page asked for with ?held kept
// from its load event by a picture askLeftBehind holds. Before the page loads.
export const pagesWatched = page =>
  page.addInitScript(() => {
    addEventListener('pagehide', e => window.__noBye && e.stopImmediatePropagation());
    addEventListener('message', e => e.data?.mic && (window.__micHeard = (window.__micHeard ?? 0) + 1));
    // (HQ's viewer: when its frame last loaded a page, and when review mode there last said hello: askable.)
    addEventListener('message', e => e.data?.hq === 'review' && e.data.hello && (window.__hello = performance.now()));
    document.addEventListener(
      'load',
      e => e.target.tagName === 'IFRAME' && (e.target.__loaded = performance.now()),
      true,
    );
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      window.__stops = (window.__stops ?? 0) + 1;
      return stop.call(this);
    };
    if (location.search === '?held') (window.__held = new Image()).src = '/held.png';
  });
// A page's offer left behind: the frame goes to another page, the offering page's goodbye never comes (Chromium drops it
// as a page unloads) and the next page's load event is held back (a slow picture). As that page says hello, HQ's key
// goes with the page that offered, waiting for the board's tap, listening (its recording ends unheard) or writing its
// words, before the load event (framemic.js). pagesWatched first, and bookvoice.mjs's voiceServed: its voice line
// keeps the busy phase's last words waiting (transcriber.held). One route holds each phase's picture (picture.held): a page route spent
// ({ times: 1 }) and the next added as it goes can leave neither in place, and the next page loads at once.
export async function askLeftBehind(page, frame) {
  const picture = { held: null },
    pictured = async r => {
      await picture.held;
      await r.fulfill({ status: 404 });
    };
  await page.evaluate(() => {
    window.__byes = 0;
    addEventListener('message', e => e.data?.bye && window.__byes++);
  });
  await page.route('**/held.png', pictured);
  await askable(page);
  for (const phase of ['ready', 'live', 'busy']) await leftAt(page, frame, phase, picture);
  await page.unroute('**/held.png', pictured); // (no picture asked for any more)
  assert.equal(await counted(page, '__byes'), 0, 'the pages left without their goodbyes');
  await page.waitForSelector('#viewer .bar .pin:not([hidden])'); // (the new page's review mode.)
}
// The page's offer in one phase (ready: waiting for the tap, live, or busy: its words being written, transcriber.held
// keeping them), and the frame gone to a page held from its load event
async function leftAt(page, frame, phase, picture) {
  const key = page.locator(KEY);
  picture.held = held();
  await ownOffer(frame);
  await key.waitFor({ state: 'visible' });
  if (phase !== 'ready') await recording(page, key, phase);
  assert.equal(await key.getAttribute('data-phase'), phase);
  const stops = await counted(page, '__stops');
  await frame.evaluate(() => {
    window.__noBye = true;
    setTimeout(() => (location.href = '/basket?held'));
  });
  await key.waitFor({ state: 'detached' });
  assert.equal(
    await frame.evaluate(() => location.search === '?held' && document.readyState !== 'complete'),
    true,
    `${phase}: the key went as the next page said hello, before its load event`,
  );
  if (phase === 'live')
    await until(async () => (await counted(page, '__stops')) > stops, 'its recording ending unheard');
  const loads = await page.evaluate(() => performance.now());
  picture.held.release();
  transcriber.held?.release();
  transcriber.held = null;
  await askable(page, loads);
}
// The page in HQ's viewer loaded (since: HQ's clock, ms) and its hello to HQ's ask on that load heard: the load drops
// any ask, and the hello one from another page than its own (framemic.js), so an ask before it could go unseen
const askable = (page, since = 0) =>
  page.waitForFunction(since => {
    const loaded = document.querySelector('#viewer iframe')?.__loaded;
    return loaded > since && window.__hello > loaded;
  }, since);
// HQ's key tapped and listening, its level read (the microphone live); for busy, the voice line's last words kept
// waiting (transcriber.held), and the key tapped again: it's writing them
async function recording(page, key, phase) {
  await page.waitForTimeout(800); // (past the key's first half second, when a tap isn't taken)
  if (phase === 'busy') transcriber.held = held();
  await key.click();
  await page.waitForFunction(key => document.querySelector(key).style.getPropertyValue('--lvl') !== '0', KEY);
  if (phase === 'busy') await key.click();
}
const counted = (on, name) => on.evaluate(n => window[n] ?? 0, name);
// A promise that keeps something waiting till its release()
function held() {
  let release;
  return Object.assign(new Promise(r => (release = r)), { release: () => release() });
}
