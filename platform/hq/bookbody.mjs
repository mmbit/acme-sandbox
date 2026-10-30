// book-check.mjs's stories of the book's body (shell/ink/book.js, booklayout.js, bookhandle.js, bookflip.js; Ink's
// folder): the shut book's pull tab, nudging no one, pulled in with the book on
// it at its own width, tapped open and shut, and a mark landing in it showing its snip; the cover's edge let go
// anywhere staying there, with HQ at a phone's width beside it, and never closing the book; the table where the book
// moves off it in HQ's own ground; the book opening straight onto its page, HQ's page fading into its room; on
// a phone the book over HQ, its tab in reach; a page turned forward and back by one turn played either way. Each
// asserts what the board sees: boxes, frames, words. (the hardcover's tab and edge)
import assert from 'node:assert/strict';
import { MINI, pixelsIn } from './bookkit.mjs';

// (longer than a flick's reading of the last moves, booklayout.js: let go where it is)
const HOLD_MS = 200;

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode), settle }
export function bodyStories(c) {
  return {
    "the book's body: pulled by its tab, the book comes with it at its own width and opens at that width": browser =>
      pulledIn(browser, c),
    "the book's body: the pull tab's tap shuts the open book and opens it again": browser => tapped(browser, c),
    "the book's body: a mark landing in the shut book shows its snip on the tab, and the tap opens the book": browser =>
      landing(browser, c),
    "the book's body: the cover's edge let go stays there, HQ a phone's width beside it; it never closes the book":
      browser => letGo(browser, c),
    "the book's body: the table where the book moves off it is HQ's own ground, the screen's whole height": browser =>
      table(browser, c),
    "the book's body: the book opens straight onto its page, no cover, and HQ fades into its room as it lands":
      browser => opening(browser, c),
    "the book's body: on a phone the open book lies over HQ, its black board round the page and its tab in reach":
      browser => phone(browser, c),
    "the book's body: a page turned forward and back is the one 3D turn, played either way": browser =>
      turning(browser, c),
  };
}

// ---- the stories

async function pulledIn(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    const open = await bookWidth(page);
    await putAway(page, c);
    const tab = page.locator('#book .bk-lip');
    await c.shot('book-body-handle', page);
    // drawn left a little more than half the book's width: the tab goes with the pointer, the cover's edge just behind
    // it, and the book comes in at its own width, never stretched
    const from = await tab.boundingBox(),
      x = from.x + from.width / 2,
      y = from.y + from.height / 2,
      dx = -open * 0.55;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 12 });
    await page.waitForTimeout(HOLD_MS);
    const held = await tab.boundingBox(),
      edge = await page.locator('#book .bk-edge').boundingBox();
    assert.ok(Math.abs(held.x - (from.x + dx)) <= 2, `the tab at ${held.x}, the pointer moved it ${dx} from ${from.x}`);
    assert.ok(
      Math.abs(edge.x - (held.x + held.width)) <= 2,
      `the edge at ${edge.x}, the tab ends at ${held.x + held.width}`,
    );
    assert.equal(await bookWidth(page), open, 'the book comes in at its own width');
    await c.shot('book-body-pulled', page);
    await page.mouse.up();
    await c.settled(page, 'open');
    assert.equal(await bookWidth(page), open, 'let go, it opens at the width it had');
    noErrors(errors);
  } finally {
    await done();
  }
}

async function tapped(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    const tab = page.locator('#book .bk-lip'),
      box = await tab.boundingBox(),
      edge = await page.locator('#book .bk-edge').boundingBox();
    // open, the tab hangs off the cover's outer edge over HQ's page, in sight
    assert.ok(box.x >= 0 && Math.abs(box.x + box.width - edge.x) <= 2, `the open book's tab at ${JSON.stringify(box)}`);
    assert.match(await tab.getAttribute('aria-label'), /close/);
    await tab.click();
    await c.settled(page, 'folded');
    assert.equal(await hqWidth(page), MINI.width);
    const shut = await tab.boundingBox();
    assert.ok(Math.abs(shut.x + shut.width - MINI.width) <= 2, `the shut book's tab at the screen's edge: ${shut.x}`);
    assert.match(await tab.getAttribute('aria-label'), /open/);
    await tab.click();
    await c.settled(page, 'open');
    noErrors(errors);
  } finally {
    await done();
  }
}

async function landing(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    await putAway(page, c);
    // (as booklanding.js tells it once the ink has flown into the handle)
    await page.evaluate(snip => {
      const id = 1;
      document.dispatchEvent(new CustomEvent('book:landed', { detail: { id, page: null, snip } }));
    }, SNIP);
    const snip = page.locator('#book .bk-lip .bk-snip');
    await snip.waitFor({ timeout: 2000 });
    await page.waitForTimeout(400);
    const box = await snip.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= MINI.width,
      `the snip beside the handle: ${JSON.stringify(box)}`,
    );
    await c.shot('book-body-landed', page);
    await snip.waitFor({ state: 'detached', timeout: 5000 });
    await page.locator('#book .bk-lip').click();
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'open');
    noErrors(errors);
  } finally {
    await done();
  }
}

async function letGo(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    // to 360 px of HQ, past the middle of the screen: it stays
    await dragEdge(page, 360);
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'open');
    assert.ok(Math.abs((await hqWidth(page)) - 360) <= 2, `HQ is ${await hqWidth(page)} px, let go at 360`);
    await c.shot('book-body-phone-hq', page);
    // right to the screen's edge: the book stops at its narrowest and stays open
    await dragEdge(page, MINI.width - 20);
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'open');
    assert.equal(await bookWidth(page), 320);
    noErrors(errors);
  } finally {
    await done();
  }
}

async function table(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    const hq = await hqWidth(page),
      x = await edgeX(page),
      y = 500;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 160, y, { steps: 12 });
    await page.waitForTimeout(HOLD_MS);
    // mid-drag, between HQ's page and the book, top to bottom: HQ's ground, one flat fill
    const tones = await lightsIn(page, { x: hq + 20, y: 0, width: 100, height: MINI.height });
    await c.shot('book-body-table', page);
    await page.mouse.up();
    assert.equal(tones.size, 1, `the table's tones: ${JSON.stringify(tones)}`);
    noErrors(errors);
  } finally {
    await done();
  }
}

async function opening(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    await putAway(page, c);
    const seen = framesFrom(page);
    await page.locator('#book .bk-lip').click();
    const frames = await seen,
      coming = frames.filter(f => f.edge < MINI.width && !f.open),
      landed = frames.findIndex(f => f.open),
      narrowed = frames.findIndex(f => f.hq < MINI.width);
    assert.ok(coming.length >= 2, `the book coming in: ${JSON.stringify(frames.slice(0, 12))}`);
    assert.equal(await page.locator('#book .bk-cover').count(), 0, 'no cover: the book opens straight onto its page');
    // HQ keeps its whole width till the book has landed, takes its new room while it's gone, then fades back in, slowly
    // enough to be seen
    assert.ok(landed >= 0 && narrowed >= landed, `HQ narrowed at frame ${narrowed}, the book landed at ${landed}`);
    assert.ok(frames[narrowed].shown < 0.05, `HQ narrowed while showing: ${JSON.stringify(frames[narrowed])}`);
    assert.ok(
      frames.slice(landed).some(f => f.shown < 0.7),
      `HQ's page didn't fade: ${JSON.stringify(frames.slice(landed, landed + 12))}`,
    );
    // (within a couple of seconds; headless frames under a busy machine come late)
    const back = frames.slice(narrowed).find(f => f.shown > 0.9);
    assert.ok(
      back && back.t - frames[landed].t < 2500,
      `HQ's page back in at ${back?.t}, the book landed at ${frames[landed].t}: ${JSON.stringify(frames.slice(landed))}`,
    );
    noErrors(errors);
  } finally {
    await done();
  }
}

// Every frame for 4 s from now: where the book's edge is, whether it's laid out open, and HQ's page's room and opacity
const framesFrom = page =>
  page.evaluate(
    () =>
      new Promise(resolve => {
        const start = performance.now(),
          frames = [],
          edge = document.querySelector('#book .bk-edge'),
          frame = () => {
            frames.push({
              t: Math.round(performance.now() - start),
              edge: Math.round(edge.getBoundingClientRect().left),
              open: document.documentElement.dataset.book === 'open',
              hq: Math.round(document.body.getBoundingClientRect().width),
              shown: Number(getComputedStyle(document.body).opacity),
            });
            if (performance.now() - start < 4000) requestAnimationFrame(frame);
            else resolve(frames);
          };
        requestAnimationFrame(frame);
      }),
  );

async function phone(browser, c) {
  const PHONE = { width: 390, height: 844 };
  const { page, errors, done } = await c.hq(browser, PHONE, { hasTouch: true, isMobile: true });
  try {
    await c.settled(page, 'folded');
    const tab = page.locator('#book .bk-lip');
    await tab.tap();
    await c.settled(page, 'spread');
    const paper = await page.locator('#book .bk-paper').boundingBox(),
      box = await tab.boundingBox();
    // the board shows round the page: at its head, its foot and its outer edge, the spine at the right
    assert.ok(
      paper.y >= 6 && paper.x >= 10 && paper.x + paper.width <= PHONE.width - 4,
      `the paper at ${JSON.stringify(paper)}`,
    );
    assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, `the tab in reach: ${JSON.stringify(box)}`);
    await c.shot('book-body-phone', page);
    await tab.tap();
    await c.settled(page, 'folded');
    noErrors(errors);
  } finally {
    await done();
  }
}

async function turning(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    const back = await turn(page, 'The page before'),
      forward = await turn(page, 'The page after');
    for (const [way, t] of Object.entries({ back, forward }))
      assert.ok(t.frames >= 3, `turning ${way}, the leaf showed in ${t.frames} frames`);
    // one turn: the same frames, the same timing, played forward one way and backwards the other
    assert.deepEqual(back.keyframes, forward.keyframes);
    assert.deepEqual(
      { ...back.timing, direction: 'reverse' },
      { ...forward.timing, direction: 'reverse' },
      'the same timing both ways',
    );
    assert.deepEqual([forward.timing.direction, back.timing.direction], ['normal', 'reverse']);
    noErrors(errors);
  } finally {
    await done();
  }
}
// A page turned by the foot's arrow: the turning leaf's transforms as they're drawn, frame by frame, and its turn's
// keyframes and timing
async function turn(page, name) {
  const watched = page.evaluate(
    () =>
      new Promise(resolve => {
        const start = performance.now(),
          drawn = [];
        let turn = null;
        const frame = () => {
          const leaf = document.querySelector('#book .bk-turn-leaf'),
            spin = leaf?.getAnimations().find(a => a.effect.getKeyframes().some(k => k.transform));
          if (spin) {
            turn ??= {
              keyframes: spin.effect.getKeyframes().map(k => ({ offset: k.offset, transform: k.transform })),
              timing: (({ duration, easing, direction }) => ({ duration, easing, direction }))(spin.effect.getTiming()),
            };
            drawn.push(getComputedStyle(leaf).transform);
          }
          if (performance.now() - start < 1500) requestAnimationFrame(frame);
          else resolve({ ...turn, frames: new Set(drawn).size });
        };
        requestAnimationFrame(frame);
      }),
  );
  await page.locator('#book').getByRole('button', { name, exact: true }).click();
  const seen = await watched;
  assert.ok(seen.keyframes, `${name}: no leaf turned`);
  return seen;
}

// ---- helpers

// HQ on an iPad mini's landscape with a mouse, the book open
async function atMini(browser, c) {
  const opened = await c.hq(browser, MINI, { hasTouch: false, deviceScaleFactor: 1 });
  await c.settled(opened.page, 'open');
  return opened;
}
const edgeX = async page => {
  const r = await page.locator('#book .bk-edge').boundingBox();
  return r.x + r.width / 2;
};
const hqWidth = page => page.evaluate(() => document.body.getBoundingClientRect().width);
// (its laid width, as bookopen.mjs reads it: mid-swing its box on the screen is the turned board's)
const bookWidth = page => page.evaluate(() => document.querySelector('#book .bk-leaf').offsetWidth);
// The cover's edge dragged to x (its left edge), held there a moment and let go
async function dragEdge(page, x) {
  const from = await edgeX(page);
  await page.mouse.move(from, 400);
  await page.mouse.down();
  await page.mouse.move(x + 6, 400, { steps: 12 });
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.up();
}
// The book put away: its pull tab tapped
async function putAway(page, c) {
  await page.locator('#book .bk-lip').click();
  await c.settled(page, 'folded');
}
// The lightnesses (0-255, rounded to 2) in a box on the screen: how many there are, and how far apart
async function lightsIn(page, clip) {
  const seen = new Set((await pixelsIn(page, clip)).map(([r, g, b]) => Math.round((r + g + b) / 6) * 2));
  return { size: seen.size, spread: Math.max(...seen) - Math.min(...seen) };
}
const noErrors = errors => assert.deepEqual(errors, []);
// A snip: a small picture of HQ with a ring of red ink on it
const SNIP = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#e9e3f7"/><rect x="20" y="30" width="80" height="14" fill="#3a3148"/><ellipse cx="60" cy="37" rx="52" ry="22" fill="none" stroke="#ff5a5f" stroke-width="4"/></svg>',
)}`;
