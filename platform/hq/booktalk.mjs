// book-check.mjs's steps for HQ's Talk key, which records for the post-it's mic in HQ's viewer (shell/framemic.js): only
// its tap records, the words come into the post-it, and the ask goes with the page that asked. HQ records the
// microphone voiceServed plays (bookvoice.mjs).
import assert from 'node:assert/strict';
import { until } from './bookkit.mjs';
import { piecesAfresh, transcriber } from './bookvoice.mjs';

// The post-it's mic in HQ's viewer, whose frame has no microphone: the page's own code asking HQ records nothing, nor
// does the mic's tap, which only brings up HQ's Talk key; that key's tap records, shows it's listening, and the words
// come into the post-it piece by piece as they're said; tapped again it stops
export async function talkedInViewer({ page, shot, named }, frame, sheet) {
  const key = page.locator('#viewer .bar .talk'),
    mic = sheet.locator('.mic'),
    asked = () => counted(page, 'micsAsked'),
    said = () => sheet.locator('textarea').inputValue(),
    heard = (re, what) => until(async () => re.test(await said()), what),
    from = await asked();
  piecesAfresh();
  await ownAsk(frame);
  await key.waitFor({ state: 'visible' });
  await page.waitForTimeout(800); // (past the key's first half second, when a tap isn't taken)
  assert.equal(await asked(), from, "the page's own ask records nothing: only HQ's key does");
  await frame.evaluate(() => window.__ask.postMessage({ mic: 'stop' }));
  await key.waitFor({ state: 'hidden' });
  await mic.click();
  await key.waitFor({ state: 'visible' });
  assert.equal(await asked(), from, "the post-it's mic only brings up HQ's key");
  await page.waitForTimeout(800);
  await key.click();
  assert.equal(await key.getAttribute('data-phase'), 'live', "HQ's key shows it's listening");
  await until(async () => (await asked()) === from + 1, "HQ's key recording");
  await shot(named('viewer-talk'), page);
  await heard(/^Make this$/, 'the words coming into the post-it as they’re said');
  await heard(/^Make this headline shorter$/, '...and the rest as it’s said');
  await key.click();
  await key.waitFor({ state: 'hidden' });
  await until(async () => /^Check the words/.test(await sheet.locator('.msg').innerText()), 'the words to check');
  assert.equal(await said(), 'Make this headline shorter', 'stopped at the key, the words stay');
  assert.equal(await counted(frame, '__micHeard'), 0, "HQ answers on the ask's line alone, never the window");
}
// The page's own code asking HQ for the mic, as review mode does: with a line for the answers (window.__ask, its end)
const ownAsk = frame =>
  frame.evaluate(() => {
    const line = new MessageChannel();
    window.__ask = line.port1;
    parent.postMessage({ hq: 'review', mic: 'start', doc: 1 }, '*', [line.port2]);
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
// A page's ask left behind: the frame goes to another page, the asking page's goodbye never comes (Chromium drops it as
// a page unloads) and the next page's load event is held back (a slow picture). As that page says hello, HQ's Talk key
// goes with the page that asked, waiting for the board's tap, listening (its recording ends unheard) or writing its
// words, before the load event (framemic.js). pagesWatched first, and bookvoice.mjs's voiceServed: its transcriber
// keeps the busy phase's words waiting. One route holds each phase's picture (picture.held): a page route spent
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
  for (const phase of ['asked', 'live', 'busy']) await leftAt(page, frame, phase, picture);
  await page.unroute('**/held.png', pictured); // (no picture asked for any more)
  assert.equal(await counted(page, '__byes'), 0, 'the pages left without their goodbyes');
  await page.waitForSelector('#viewer .bar .pin:not([hidden])'); // (the new page's review mode.)
}
// The page's ask in one phase (asked: waiting for the tap, live, or busy: its words being written, transcriber.held
// keeping them), and the frame gone to a page held from its load event
async function leftAt(page, frame, phase, picture) {
  const key = page.locator('#viewer .bar .talk');
  picture.held = held();
  await ownAsk(frame);
  await key.waitFor({ state: 'visible' });
  if (phase !== 'asked') await recording(page, key, phase);
  assert.equal(await key.getAttribute('data-phase'), phase);
  const stops = await counted(page, '__stops');
  await frame.evaluate(() => {
    window.__noBye = true;
    setTimeout(() => (location.href = '/basket?held'));
  });
  await key.waitFor({ state: 'hidden' });
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
// HQ's key tapped and listening, its level read (the microphone live); for busy, a piece of the words sent off and kept
// waiting (transcriber.held), and the key tapped again: it's writing them
async function recording(page, key, phase) {
  await page.waitForTimeout(800); // (past the key's first half second, when a tap isn't taken)
  if (phase === 'busy') transcriber.held = held();
  const sent = transcriber.sent;
  await key.click();
  await page.waitForFunction(
    () => document.querySelector('#viewer .bar .talk').style.getPropertyValue('--lvl') !== '0',
  );
  if (phase !== 'busy') return;
  await until(() => transcriber.sent > sent, 'a piece of the words sent off');
  await key.click();
}
const counted = (on, name) => on.evaluate(n => window[n] ?? 0, name);
// A promise that keeps something waiting till its release()
function held() {
  let release;
  return Object.assign(new Promise(r => (release = r)), { release: () => release() });
}
