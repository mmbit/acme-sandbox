// book-check.mjs's story of the pull tab under the finger: grabbed on the iPad mini (on its side, after the book was
// last pulled out wider, and upright), shut and open, the tab never shows ahead of the finger, from the first frame.
// The state is read as every move's handlers end, where the engine may paint before any frame's callbacks run
// (WebKit's), and at every frame: a flash would be a frame or two near the screen's middle, where the book last lay
// open. Run it in WebKit too (--webkit).
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, middleOf, touchOf } from './bookkit.mjs';
import { HOLD } from './shell/ink/bookswingmath.js';

// How far past the finger the tab's far side may be (px): the finger holds it about its middle
const AHEAD = 12;

// c: book-check.mjs's played store and helpers
export function grabStories(c) {
  return {
    'the pull tab under the finger: grabbed shut or open, on its side or upright, it never shows ahead of the finger':
      browser => grabbed(browser, c),
  };
}

async function grabbed(browser, c) {
  for (const viewport of [MINI, UPRIGHT]) {
    const size = `${viewport.width}x${viewport.height}`,
      context = await c.hqIn(browser, viewport, { deviceScaleFactor: 1 }),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`${c.base}/?intro=0`);
      const sideways = viewport === MINI;
      await c.settled(page, sideways ? 'open' : 'folded');
      if (sideways) {
        // (pulled out wider by its edge, then shut: the book remembers how far it was last pulled out)
        const edge = middleOf(await page.locator('#book .bk-edge').boundingBox());
        await page.mouse.move(...edge);
        await page.mouse.down();
        await page.mouse.move(edge[0] - 140, edge[1], { steps: 6 });
        await page.mouse.up();
        await c.settled(page, 'open');
        await page.click('#book .bk-lip');
        await c.settled(page, 'folded');
      }
      // shut, pulled in by the finger: lowered past halfway and let go, it opens
      const shut = await pull(page, -1, 0.75);
      assert.equal(show(ahead(shut, -1)), '', `the shut tab showed ahead of the finger (${size}), all: ${show(shut)}`);
      await c.settled(page, sideways ? 'open' : 'spread');
      // open (beside HQ or lying over it), pulled right: no frame elsewhere either
      const open = await pull(page, 1, 0.25);
      assert.equal(show(ahead(open, 1)), '', `the open tab showed ahead of the finger (${size}), all: ${show(open)}`);
      // (headless WebKit draws about a frame a second: its swing takes a while to end)
      await page.waitForFunction(() => !document.querySelector('#book.bk-swinging'), null, { timeout: 60_000 });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}

// The tab pulled by a finger across share of the screen's width, left (dir -1) or right (dir 1), a move a frame, then
// let go. Gives what was seen till the lift: at each move's end and at each frame, the finger's x and the tab's left
// and right.
async function pull(page, dir, share) {
  await page.evaluate(() => {
    const lip = document.querySelector('#book .bk-lip'),
      seen = (window.__grab = []),
      box = () => {
        const r = lip.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.right)];
      };
    let finger = null;
    // (each move read as its handlers end, the tab's drag's among them: added on the press, after the drag's own)
    window.__grabMove = e => {
      finger = e.clientX;
      seen.push({ at: 'move', finger, lip: box() });
    };
    addEventListener('pointerdown', () => addEventListener('pointermove', window.__grabMove), { once: true });
    const frame = () => {
      if (finger !== null) seen.push({ at: 'frame', finger, lip: box() });
      if (window.__grab === seen) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const [x, y] = middleOf(await page.locator('#book .bk-lip').boundingBox()),
    width = page.viewportSize().width,
    steps = 24,
    at = i => [Math.round(x + (dir * share * width * i) / steps), Math.round(y)],
    finger = await fingerOf(page);
  await finger.down(at(0));
  for (let i = 1; i <= steps; i++) {
    await finger.move(at(i));
    await page.waitForTimeout(16);
  }
  // (still for less than HOLD: longer, the pull-in from shut would turn into a resize)
  await page.waitForTimeout(HOLD / 2);
  const seen = await page.evaluate(() => {
    removeEventListener('pointermove', window.__grabMove);
    const seen = window.__grab;
    window.__grab = null;
    return seen;
  });
  await finger.up();
  return seen;
}
// A finger at [x, y]: Chromium's own touch events; WebKit has none to play, so its mouse, the same pointer events to
// the tab
async function fingerOf(page) {
  if (page.context().browser().browserType().name() !== 'chromium')
    return {
      down: at => page.mouse.move(...at).then(() => page.mouse.down()),
      move: at => page.mouse.move(...at),
      up: () => page.mouse.up(),
    };
  const cdp = await page.context().newCDPSession(page),
    touch = touchOf(cdp);
  return {
    down: at => touch.down([at]),
    move: at => touch.move([at], 1),
    up: () => touch.up().then(() => cdp.detach()),
  };
}
// Where the tab showed ahead of the finger pulling it dir: it trails the hand (the board's weight lags it), it never
// leads it
const ahead = (seen, dir) =>
  seen.filter(({ finger, lip: [left, right] }) => (dir < 0 ? right < finger - AHEAD : left > finger + AHEAD));
const show = seen => seen.map(s => `${s.at} ${s.finger}: ${s.lip.join('-')}`).join(', ');
