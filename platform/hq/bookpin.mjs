// book-check.mjs's pin story (shared/review/dock.js, menu.js, postit.js; shell/desk.js, pinsummon.js), held like an
// iPad mini in landscape, on book-check's played store, and its summon on a desktop the board's size and on a phone.
// On HQ the pin is away as HQ loads, whatever the book's state, until the board summons it: beside the book by opening
// it, or with the pin among the book's controls; folded, or that control again, it goes (nothing left to tap where it
// was). On a phone the control folds the book and leaves HQ with the pin on it, and the book opened again puts it away.
// An artifact's own page shows its pin at once. A ring's post-it saved, its note is a scrap in My Notebook whose owner
// is one truth: a ring on HQ's own page (nothing there names an owner, as on the desk phone's card in the board's
// picture) is Juno's, a ring on something an agent owns theirs; the menu offers the Notebook (the pin flow). Carried and let go, the pin stays exactly where
// it's dropped, the same button while it's held (pincheck.mjs). (the summon)
import assert from 'node:assert/strict';
import { carried } from '../../shared/review/pincheck.mjs';
import { shutBook } from './bookchrome.mjs';
import { fulfilPart } from '../../shared/review/parts.mjs';
import { savedScrap } from './bookscrap.mjs';

const ui = s => `review-mode >> css=${s}`;

// c: book-check's { browser, hqIn, base, MINI, settled, shot, posts, pages, org, penOn, ring, noErrorsIn }, and look
// ('&renderer=wire' for Wire)
export async function pinStory(c) {
  const context = await c.hqIn(c.browser, c.MINI);
  // (review mode's menu reads whose sheet from the coordinator: the stand-in answers for the owner the menu asks for,
  // the page's own being the CEO's, as feedback.test.ts holds the real one to)
  await context.route(/\/__review\/mine(\?.*)?$/, r => {
    const owner = new URL(r.request().url()).searchParams.get('owner') ?? c.org.company.ceo;
    r.fulfill({ json: { book: { owner, name: nameOf(c, owner) }, notes: 1 } });
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`${c.base}/?intro=0${c.look}`);
    await page.waitForSelector('#loading.gone');
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.body.classList.contains('brownstone')), !c.look, 'the look');
    await summoned(c, page);
    const ceo = nameOf(c, c.org.company.ceo);
    await noted(c, page, { ring: [300, 300], owner: c.org.company.ceo, name: ceo, look: 'pin-ceo' });
    // something an agent owns on HQ's page, as a thread's tile names it
    const agent = c.org.departments.flatMap(d => d.agents).find(a => a.id !== c.org.company.ceo);
    await page.evaluate(id => {
      const tile = Object.assign(document.createElement('button'), { textContent: 'A thread of theirs' });
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

// Loaded with the book open, no pin; folded, none; opened by the board, it comes, quickly; the book's pin control puts
// it away and brings it back
async function summoned(c, page) {
  await showing(page, false, 'HQ loads with the book open and no pin');
  await c.shot('pin-loaded', page);
  await shutBook(page);
  await c.settled(page, 'folded');
  assert.equal((await pinSeen(page)).shows, false, 'folded, no pin');
  await page.click('#book .bk-lip');
  await c.settled(page, 'open');
  await showing(page, true, 'the book opened, the pin comes');
  await c.shot('pin-open', page);
  await page.click(PIN_CONTROL);
  await showing(page, false, "the book's pin control puts it away");
  await page.click(PIN_CONTROL);
  await showing(page, true, "the book's pin control brings it back");
}

// The book's pin control, in its island (pinsummon.js)
const PIN_CONTROL = '#book .bk-pin';
// The pin shown or away, within its pop or its shrink (0.35 and 0.2 s; headless frames under load come late): and a tap
// where it was is the page's once it's gone
async function showing(page, shows, what) {
  const as = seen => [seen.shows, seen.tapped === 'review-mode'];
  let seen;
  for (let i = 0; i < 15 && as((seen = await pinSeen(page))).some(b => b !== shows); i++)
    await page.waitForTimeout(100);
  assert.deepEqual(as(seen), [shows, shows], what);
}

// On a desktop the board's size (a mouse, the book open beside HQ as it starts): no pin at load; the control brings it,
// folding puts it away, and opening the book brings it again, a resize during its slide too. On a phone (the book
// folded, opening as the spread over HQ): no pin at load nor in the open book; the control folds the book onto HQ with
// the pin, opening the book puts it away, and folded again HQ has none. An artifact's own page: its pin at once. Each
// from a fresh load.
// c: book-check's { browser, hqIn, base, settled, shot, noErrorsIn, reviewJs }
export async function pinScreensStory(c) {
  await onScreen(c, DESKTOP, async page => {
    await c.settled(page, 'open');
    await showing(page, false, 'a desktop: HQ loads with the book open and no pin');
    await page.click(PIN_CONTROL);
    await showing(page, true, "a desktop: the book's pin control summons it");
    await shutBook(page);
    await c.settled(page, 'folded');
    await showing(page, false, 'a desktop: folded, the pin goes');
    await page.click('#book .bk-lip');
    await c.settled(page, 'open');
    await showing(page, true, 'a desktop: opening the book summons it');
    await c.shot('pin-desktop', page);
    // the window resized while the book slides open (a dragged window): still the board's opening
    await shutBook(page);
    await c.settled(page, 'folded');
    await page.click('#book .bk-lip');
    assert.ok(await page.evaluate(() => document.querySelector('#book .bk-edge').getAnimations().length), 'sliding');
    await page.setViewportSize({ width: 1400, height: 900 });
    await c.settled(page, 'open');
    await showing(page, true, 'a desktop: resized as the book slides open, the pin still comes');
  });
  await onScreen(c, PHONE, async page => {
    await c.settled(page, 'folded');
    await showing(page, false, 'a phone: HQ loads with no pin');
    await page.click('#book .bk-lip');
    await c.settled(page, 'spread');
    await c.shot('pin-phone-book', page);
    await page.click(PIN_CONTROL);
    await c.settled(page, 'folded');
    await showing(page, true, "a phone: the book's pin control leaves HQ with the pin");
    await c.shot('pin-phone', page);
    await page.click('#book .bk-lip');
    await c.settled(page, 'spread');
    await shutBook(page);
    await c.settled(page, 'folded');
    await showing(page, false, 'a phone: the book opened again put it away');
  });
  await artifactPin(c);
}
const DESKTOP = { viewport: { width: 1440, height: 900 }, more: { deviceScaleFactor: 1, hasTouch: false } },
  PHONE = { viewport: { width: 390, height: 844 }, more: {} };
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
async function artifactPin(c) {
  const context = await c.hqIn(c.browser, DESKTOP.viewport, DESKTOP.more);
  try {
    await context.route(`${ARTIFACT}/**`, r => {
      const path = new URL(r.request().url()).pathname;
      if (fulfilPart(r, path, c.reviewJs)) return;
      if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
      return r.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Basket</title><h1>Your basket</h1><script src="/__review/review.js"></script>',
      });
    });
    const page = await context.newPage();
    await page.goto(`${ARTIFACT}/basket`);
    await page.waitForSelector('review-mode .fab', { state: 'attached' });
    await showing(page, true, 'an artifact keeps its pin');
  } finally {
    await context.close();
  }
}

// A ring with the pen, its post-it saved: the scrap that owner's, and the menu offering the Notebook it went to
async function noted(c, page, { ring, owner, name, look }) {
  const from = c.posts.length;
  await c.penOn(page)(c.ring(ring[0], ring[1], 70, 40));
  const sent = await savedScrap({ page, posts: c.posts }, from, look);
  await c.shot(look, page);
  assert.equal(sent.owner ?? c.org.company.ceo, owner, `the scrap is ${name}'s`);
  assert.ok(!c.posts.slice(from).some(p => p.path === '/api/book/note'), '...on no sheet');
  await page.waitForTimeout(800); // (its lift into the book)
  // the menu, as the board opens it
  await page.locator(ui('.more')).dispatchEvent('click');
  await page.waitForSelector(ui('.menu:not([hidden])'));
  await page.waitForFunction(
    () =>
      document
        .querySelector('review-mode')
        .shadowRoot.querySelector('[data-open-book]')
        .textContent.includes('Open the Notebook'),
    null,
    { timeout: 5000 },
  );
  await c.shot(`${look}-menu`, page);
  await page.keyboard.press('Escape');
}
