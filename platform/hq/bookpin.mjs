// book-check.mjs's pin story (shared/review/dock.js, postit.js; shell/desk.js, pinsetting.js), held like an iPad mini in
// landscape, on book-check's played store, and its setting on a desktop the board's size and on a phone. On HQ the pin
// is away as HQ loads, the book open or folded, and opening or folding the book never brings it: Settings' Pin on HQ
// does, for this device, and turned off puts it away (nothing left to tap where it was); after a reload it is still on.
// An artifact's own page shows its pin at once. A ring's post-it saved, its note is a scrap in My journal whose owner
// is one truth: a ring on HQ's own page (nothing there names an owner, as on the desk phone's card in the board's
// picture) is Juno's, a ring on something an agent owns theirs. Carried and let go, the pin stays exactly where it's
// dropped, the same button while it's held (pincheck.mjs). (the setting)
import assert from 'node:assert/strict';
import { carried } from '../../shared/review/pincheck.mjs';
import { shutBook } from './bookchrome.mjs';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { savedScrap } from './bookscrap.mjs';
import { DESKTOP, pinOn, pressAlong } from './bookkit.mjs';
import { frameInkStory } from './bookframeink.mjs';

// c: book-check's { browser, hqIn, base, MINI, settled, shot, posts, pages, org, ring, noErrorsIn }, and look
// ('&renderer=wire' for Wire)
export async function pinStory(c) {
  const context = await c.hqIn(c.browser, c.MINI);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    const load = async () => {
      await page.goto(`${c.base}/?intro=0${c.look}`);
      await page.waitForSelector('#loading.gone');
      await page.waitForSelector('review-mode .fab', { state: 'attached' });
      await c.settled(page, 'open');
    };
    await load();
    assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), !c.look, 'the look');
    await switched(c, page, load);
    const ceo = nameOf(c, c.org.company.ceo);
    await noted(c, page, { ring: [300, 300], owner: c.org.company.ceo, name: ceo, look: 'pin-ceo' });
    // something an agent owns on HQ's page, as a deliverable's tile names it
    const agent = c.org.departments.flatMap(d => d.agents).find(a => a.id !== c.org.company.ceo);
    await page.evaluate(id => {
      const tile = Object.assign(document.createElement('button'), { textContent: 'A deliverable of theirs' });
      tile.dataset.owner = id;
      tile.style.cssText = 'position:fixed;left:120px;top:440px;width:200px;height:90px;z-index:5';
      document.body.append(tile);
    }, agent.id);
    await noted(c, page, { ring: [220, 485], owner: agent.id, name: agent.name, look: 'pin-agent' });
    // carried up and left with a mouse and let go, it stays exactly there; held, the same button, a grab hand over it
    assert.deepEqual(await carried(page, [-160, -220]), [], 'the pin carried and let go');
    await c.shot('pin-dropped', page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

const nameOf = (c, id) => c.org.departments.flatMap(d => d.agents).find(a => a.id === id)?.name ?? id;

// The pin as the board sees it: shown, and what a tap there lands on, review mode or HQ's page
const pinSeen = page =>
  page.evaluate(() => {
    const fab = document.querySelector('review-mode').shadowRoot.querySelector('.fab'),
      b = fab.getBoundingClientRect(),
      at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { shows: fab.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }), tapped: at?.localName };
  });

// Loaded with the book open, no pin; folded, none, and opened again still none; Settings' Pin on HQ brings it,
// quickly, and turned off puts it away; turned on, it is still there after a reload (this device's)
async function switched(c, page, load) {
  await showing(page, false, 'HQ loads with the book open and no pin');
  await c.shot('pin-loaded', page);
  await shutBook(page);
  await c.settled(page, 'folded');
  await showing(page, false, 'folded, no pin');
  await page.click('#book .bk-lip');
  await c.settled(page, 'open');
  await showing(page, false, 'the book opened, still no pin');
  await pinSetting(page, true);
  await showing(page, true, "Settings' Pin on HQ brings it");
  await c.shot('pin-open', page);
  await pinSetting(page, false);
  await showing(page, false, '...and turned off puts it away');
  await pinSetting(page, true);
  await load();
  await showing(page, true, 'reloaded, the pin is still on');
}

// Settings › This device › Pin on HQ switched on or off as the board taps it, and Settings closed again
async function pinSetting(page, on) {
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('settings')));
  const pin = page.locator(PIN_SWITCH);
  if ((await pin.getAttribute('aria-checked')) !== String(on)) await pin.click();
  await page.waitForSelector(`${PIN_SWITCH}[aria-checked="${on}"]`);
  await page.click('#tool [data-close]');
}
const PIN_SWITCH = '#tool [data-switch="sys:pin"]';
// The pin shown or away, within its pop or its shrink (0.35 and 0.2 s; headless frames under load come late): and a tap
// where it was is the page's once it's gone
async function showing(page, shows, what) {
  const as = seen => [seen.shows, seen.tapped === 'review-mode'];
  let seen;
  for (let i = 0; i < 15 && as((seen = await pinSeen(page))).some(b => b !== shows); i++)
    await page.waitForTimeout(100);
  assert.deepEqual(as(seen), [shows, shows], what);
}

// On a desktop the board's size (a mouse, the book open beside HQ as it starts) and on a phone (the book folded,
// opening as the spread over HQ): no pin at load, nor with the book opened or folded; Settings' Pin on HQ brings it and
// puts it away. An artifact's own page: its pin at once. Each from a fresh load.
// c: book-check's { browser, hqIn, base, settled, shot, noErrorsIn, reviewJs }
export async function pinScreensStory(c) {
  // (a call's first, each from its own load: a step failing below never hides them.)
  await callPin(c);
  await frameInkStory(c);
  await onScreen(c, DESKTOP_SCREEN, async page => {
    await c.settled(page, 'open');
    await showing(page, false, 'a desktop: HQ loads with the book open and no pin');
    await shutBook(page);
    await c.settled(page, 'folded');
    await showing(page, false, 'a desktop: folded, no pin');
    await page.click('#book .bk-lip');
    await c.settled(page, 'open');
    await showing(page, false, 'a desktop: the book opened, still no pin');
    await pinSetting(page, true);
    await showing(page, true, "a desktop: Settings' Pin on HQ brings it");
    await c.shot('pin-desktop', page);
    await pinSetting(page, false);
    await showing(page, false, 'a desktop: turned off, it goes');
  });
  await onScreen(c, PHONE_SCREEN, async page => {
    await c.settled(page, 'folded');
    await showing(page, false, 'a phone: HQ loads with no pin');
    await page.click('#book .bk-lip');
    await c.settled(page, 'spread');
    await c.shot('pin-phone-book', page);
    await shutBook(page);
    await c.settled(page, 'folded');
    await showing(page, false, 'a phone: the book opened and folded, still no pin');
    await pinSetting(page, true);
    await showing(page, true, "a phone: Settings' Pin on HQ brings it");
    await c.shot('pin-phone', page);
    await pinSetting(page, false);
    await showing(page, false, 'a phone: turned off, it goes');
  });
  await artifactPin(c);
}
const DESKTOP_SCREEN = { viewport: DESKTOP, more: { deviceScaleFactor: 1, hasTouch: false } },
  PHONE_SCREEN = { viewport: { width: 390, height: 844 }, more: {} };
async function onScreen(c, { viewport, more }, story) {
  const context = await c.hqIn(c.browser, viewport, more),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#loading.gone');
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await story(page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}
// An artifact's page with review mode, as the coordinator serves a preview: its pin shows from the start
const ARTIFACT = 'https://hello.preview.test';
const routeArtifact = (c, context) =>
  context.route(`${ARTIFACT}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, c.reviewJs)) return;
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Basket</title><h1>Your basket</h1><script src="/__review/review.js"></script>',
    });
  });
async function artifactPin(c) {
  const context = await c.hqIn(c.browser, DESKTOP_SCREEN.viewport, DESKTOP_SCREEN.more);
  try {
    await routeArtifact(c, context);
    const page = await context.newPage();
    await page.goto(`${ARTIFACT}/basket`);
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await showing(page, true, 'an artifact keeps its pin');
  } finally {
    await context.close();
  }
}

// On a call no pin and no Note: HQ's pin goes, an artifact opened in the viewer during it shows no
// pin and the bar no Note, as one already open hears of a call; hung up, all are back (the board, call 161.)
async function callPin(c) {
  const context = await c.hqIn(c.browser, DESKTOP_SCREEN.viewport, DESKTOP_SCREEN.more);
  try {
    await routeArtifact(c, context);
    await context.route(`${c.base}/api/preview/link`, r =>
      r.fulfill({ json: { url: r.request().postDataJSON().url } }),
    );
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#loading.gone');
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await c.settled(page, 'open');
    await pinOn(page);
    await showing(page, true, 'before the call: the pin on');
    const call = on => calling(page, on),
      note = () => page.locator('#viewer .bar .pin').isVisible();
    await call(true);
    await showing(page, false, 'on a call: no pin on HQ');
    await page.evaluate(url => import('/shell/desk.js').then(m => m.openLink(url)), `${ARTIFACT}/basket`);
    await page.waitForFunction(() => document.querySelector('#viewer iframe')?.src.includes('/basket'));
    const frame = await (await page.$('#viewer iframe')).contentFrame();
    await frame.waitForSelector('review-mode .fab', { state: 'attached' });
    await page.waitForTimeout(1500); // (its hello answered, and the bar's ask after a load: desk.js ASK_MS)
    await showing(frame, false, 'on a call: an artifact opened shows no pin');
    assert.equal(await note(), false, '...and the bar no Note');
    await c.shot('pin-call-artifact', page);
    await call(false);
    await showing(frame, true, 'hung up: the artifact has its pin');
    await page.waitForSelector('#viewer .bar .pin:not([hidden])');
    await call(true);
    await showing(frame, false, 'a call with the artifact open: its pin goes');
    assert.equal(await note(), false, '...and the Note');
    await call(false);
    await showing(frame, true, 'hung up again: its pin is back');
    assert.equal(await note(), true, '...and the Note');
    await page.click('#viewer [data-close]');
    await showing(page, true, "the viewer closed: HQ's pin as the board left it");
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}
// A call on or off, as calldraw.js tells the page
const calling = (page, on) =>
  page.evaluate(
    ([on, call]) => document.dispatchEvent(new CustomEvent(on ? 'call:on' : 'call:off', { detail: on ? call : {} })),
    [on, { call: 5, agent: 'juno', name: 'Juno', color: '#7b5ea7' }],
  );

// A ring with the pen, its post-it saved: the scrap that owner's
async function noted(c, page, { ring, owner, name, look }) {
  const from = c.posts.length;
  await pressAlong(page, c.ring(ring[0], ring[1], 70, 40));
  const sent = await savedScrap({ page, posts: c.posts }, from, look);
  await c.shot(look, page);
  assert.equal(sent.owner ?? c.org.company.ceo, owner, `the scrap is ${name}'s`);
  assert.ok(!c.posts.slice(from).some(p => p.path === '/api/book/note'), '...on no sheet');
  await page.waitForTimeout(800); // (its lift into the book)
}
