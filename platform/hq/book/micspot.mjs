// node platform/hq/book-check.mjs --stories 'mic, then a spot held' [--webkit] [--shots dir]
// book-check.mjs's stories of the mic's voice note at a spot (shell/ink/bookvoice.js, bookheard.js; the board, call
// 192), on the board's iPhone, an iPad on its side and an iPad mini upright, by finger (pointer events as Safari hands a
// finger's over, on what's under them, the same in Chromium and WebKit) over the stand-in voice line (voice.mjs)
// and the microphone's stand-in (kit.mjs heard), on a new scrap opened by a finger's tap on the grid's bare paper (the
// mic is on an opened scrap's tools). The mic tapped only lights: nothing records, and the paper is left as it is. A
// spot then pressed and held records there: the words write themselves at the spot while it's held, in the page's own
// type, an ink loader after them, nothing floating beside the mic and nothing drawn. Let go, the mic is out at once and
// no Listening stays; the words land where they showed as the page's own box, on the scrap, kept in the store, and the
// loader goes. The mic tapped twice lets go: the next press records nothing.
import assert from 'node:assert/strict';
import { freePage, paperBox, savedWhere } from './mouse.mjs';
import { stored } from './strip.mjs';
import { SAID } from './voice.mjs';
import { MINI, UPRIGHT, QUIET_MS, heard, middleOf, openScrap, until, wordsHeard } from './kit.mjs';

const PHONE = { width: 390, height: 844 };

// c: book-check.mjs's played store and helpers ({ hqIn, base, settled, shot, notebook, pages })
export function micSpotStories(c) {
  return Object.fromEntries(
    [PHONE, MINI, UPRIGHT].map(viewport => [
      `the mic, then a spot held: the words write themselves there as they're said, the mic out the moment it's let go, by finger at ${viewport.width} × ${viewport.height}`,
      browser => story(browser, c, viewport),
    ]),
  );
}

async function story(browser, c, viewport) {
  const free = freePage(c),
    size = `${viewport.width} × ${viewport.height}`;
  const context = await c.hqIn(browser, viewport, { hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await page.waitForSelector('#loading.gone', { state: 'attached' });
    await opened(page, c, viewport);
    const paper = await paperBox(page),
      { sheet } = await openScrap(page, fingerTap(page), undefined, middleOf(paper));
    await spot(page, c, free, [sheet.x + sheet.width * 0.25, sheet.y + sheet.height * 0.45], viewport);
    await letGo(page, c, free, [sheet.x + sheet.width * 0.5, sheet.y + sheet.height * 0.75], size);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// The mic tapped twice: lit, then out; the next press records nothing
async function letGo(page, c, free, at, size) {
  const mic = page.locator('#book .bk-mic'),
    texts = stored(c, free).texts.length;
  await mic.tap();
  assert.equal(await mic.getAttribute('aria-pressed'), 'true', `at ${size}, the mic tapped lights`);
  await mic.tap();
  assert.equal(await mic.getAttribute('aria-pressed'), 'false', `at ${size}, tapped again it's out`);
  await fingerTap(page).tap(at);
  await page.waitForTimeout(QUIET_MS);
  assert.equal(await page.locator('#book .bk-heard').count(), 0, `at ${size}, the tap recorded nothing`);
  assert.equal(await mic.getAttribute('data-listening'), null, `at ${size}, nor shows it recording`);
  assert.equal(stored(c, free).texts.length, texts, `at ${size}, no words kept by it`);
}

// The mic tapped, then a spot held: what the board sees while it talks, as it lets go, and once the words are in
async function spot(page, c, free, at, viewport) {
  const size = `${viewport.width} × ${viewport.height}`,
    mic = page.locator('#book .bk-mic'),
    words = page.locator('#book .bk-heard'),
    ink = stored(c, free).ink.length;
  await mic.tap();
  await page.waitForTimeout(QUIET_MS);
  assert.equal(await words.count(), 0, `at ${size}, the mic tapped records nothing till a spot is held`);
  assert.equal(await mic.getAttribute('data-listening'), null, `at ${size}, nor shows it recording`);
  await finger(page, 'pointerdown', at);
  await words.waitFor({ timeout: 5000 });
  assert.equal(await mic.getAttribute('data-listening'), '', `at ${size}, held, the mic records`);
  await wordsHeard(page);
  const live = await words.evaluate(el => {
    const r = el.getBoundingClientRect(),
      bars = el.querySelector('.bk-bars'),
      under = getComputedStyle(el, '::before');
    return {
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
      font: getComputedStyle(el.querySelector('.bk-typed-words')).fontFamily,
      bars: !!bars && bars.getBoundingClientRect().width > 0,
      // (a paper of its own under the words: painted, and round them)
      slip: under.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(under.width) > el.offsetWidth,
    };
  });
  assert.ok(live.bars, `at ${size}, the voice's bars after the words while they come`);
  assert.ok(live.slip, `at ${size}, the words on a slip of paper as they come`);
  // (across from the spot, or nearer its left where the spot leaves too little room before the scrap's edge)
  assert.ok(
    at[0] >= live.box.x - 4 && at[0] <= live.box.x + live.box.w,
    `at ${size}, the words across from the spot held: ${JSON.stringify({ at, live })}`,
  );
  assert.equal(await page.locator('#book .bk-voice').count(), 0, `at ${size}, nothing floating beside the mic`);
  await c.shot(`book-mic-spot-held-${viewport.width}`, page);
  await finger(page, 'pointerup', at);
  await landed(page, c, free, { live, ink, viewport });
}
// Let go: the mic out at once, no Listening anywhere, and the words landed where they showed (live: their box and type
// as they came; ink: the page's lines before the spot was held)
async function landed(page, c, free, { live, ink, viewport }) {
  const size = `${viewport.width} × ${viewport.height}`,
    words = page.locator('#book .bk-heard');
  const out = await page.evaluate(() => {
    const m = document.querySelector('#book .bk-mic');
    return { pressed: m.getAttribute('aria-pressed'), listening: m.hasAttribute('data-listening') };
  });
  assert.deepEqual(out, { pressed: 'false', listening: false }, `at ${size}, let go, the mic is out at once`);
  assert.ok(
    !/Listening/.test(await page.locator('#book').innerText()),
    `at ${size}, nothing says Listening once it's let go`,
  );
  const kept = await savedWhere(c, free.id, p => p.texts.length === 1);
  assert.equal(kept.texts[0].text, SAID, `at ${size}, the words said`);
  assert.equal(kept.ink.length, ink, `at ${size}, nothing drawn by the held spot`);
  await until(async () => (await words.count()) === 0, `at ${size}, the words as heard give way to the page's own`);
  const box = await page.locator('#book .bk-typed').boundingBox();
  assert.ok(
    Math.abs(box.x - live.box.x) <= 2 && Math.abs(box.y - live.box.y) <= 2,
    `at ${size}, the words land where they showed: ${JSON.stringify({ box, live })}`,
  );
  const sheet = await page.locator('#book .bk-sheet').boundingBox(),
    { x, y, w, h } = live.box;
  assert.ok(
    x >= sheet.x && x + w <= sheet.x + sheet.width && y >= sheet.y && y + h <= sheet.y + sheet.height,
    `at ${size}, the words on the opened scrap: ${JSON.stringify({ sheet, live })}`,
  );
  assert.equal(
    await page.locator('#book .bk-typed .bk-typed-words').evaluate(el => getComputedStyle(el).fontFamily),
    live.font,
    `at ${size}, in the page's own type as they came`,
  );
  await c.shot(`book-mic-spot-landed-${viewport.width}`, page);
}

// The book open: beside HQ on its side, the whole screen upright (its lip tapped)
async function opened(page, c, viewport) {
  if (viewport.width > viewport.height) {
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    return c.settled(page, 'open');
  }
  await c.settled(page, 'folded');
  await page.evaluate(() => document.querySelector('#book .bk-lip').click());
  await c.settled(page, 'spread');
}

// Pointer events as Safari hands over a finger's (pointerId 3), each on what's at its point, one after another in the
// page: steps [type, [x, y]]
const fingerSteps = (page, steps) =>
  page.evaluate(steps => {
    for (const [type, [x, y]] of steps)
      (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
        new PointerEvent(type, {
          ...{ pointerId: 3, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y },
          ...{ pressure: type === 'pointerup' ? 0 : 0.5, buttons: type === 'pointerup' ? 0 : 1 },
          ...{ bubbles: true, composed: true, cancelable: true },
        }),
      );
  }, steps);
const finger = (page, type, at) => fingerSteps(page, [[type, at]]);
// A finger's tap as the touch screen makes one, for kit.mjs openScrap
const fingerTap = page => ({ tap: ([x, y]) => page.touchscreen.tap(x, y) });
