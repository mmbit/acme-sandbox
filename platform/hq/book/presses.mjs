// book-check.mjs's story of the book's sounds (shell/ink/booksounds.js), on
// journal.mjs's My journal, on an iPad mini with touch and on a desktop: every press answers at once with a sound
// (a tab, the page arrow, the page count and a page in its list, All pages, a page's tile, the dots), and a page
// archived from its dots menu is heard crumpled at once and landing below once it has fallen, within two seconds.
import assert from 'node:assert/strict';
import { DESKTOP, LOADED_MS, MINI, OVERVIEW, until } from './kit.mjs';
import { CALLS, landed, onJournal } from './journal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function pressesStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    'every press in the book is heard at once, and a page archived is heard crumpled and fallen, on an iPad mini':
      browser => heard(browser, c, MINI, 'mini', touch),
    'every press in the book is heard at once, and a page archived is heard crumpled and fallen, on a desktop':
      browser => heard(browser, c, DESKTOP, 'desktop', mouse),
  };
}

// a press is heard this soon (ms), and the fallen ball lands within this (ms after the press)
const AT_ONCE_MS = 250,
  FALLEN_MS = [500, 2000];

// What the page hears: each press's time, as it goes down (a finger's tap on the page's arrows is answered on its lift,
// before its click: bookcontrols.js onEveryTap), or a click made by the story's script, and when each sound the sound
// kit plays is heard (a stereo buffer started: audio.js sample(); the rain's noise is mono)
function listen() {
  window.presses = [];
  window.heard = [];
  addEventListener('pointerdown', () => window.presses.push(performance.now()), { capture: true });
  addEventListener('click', e => e.isTrusted || window.presses.push(performance.now()), { capture: true });
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    if (this.buffer?.numberOfChannels === 2)
      window.heard.push(performance.now() + Math.max(0, when - this.context.currentTime) * 1000);
    return start.call(this, when, ...rest);
  };
}
// The sounds heard after the last press, in ms from it, once there are n of them
async function afterPress(p, n, what) {
  const after = () =>
    p.evaluate(() => {
      const at = window.presses.at(-1);
      return at == null ? [] : window.heard.filter(h => h >= at - 1).map(h => Math.round(h - at));
    });
  await until(async () => (await after()).length >= n, `${what}: heard`);
  return after();
}

const heard = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'presses', init: listen }, async (p, { press }) => {
    const pressed = async (loc, what) => {
      await press(loc);
      const [first] = await afterPress(p, 1, `${name}: ${what}`);
      assert.ok(first < AT_ONCE_MS, `${name}: ${what}: heard at once (${first} ms)`);
    };
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
    await pressed(p.locator('#book .bk-marks [data-chapter=sketch]'), 'the Sketch tab');
    await landed(p, 'sketch', 'Ideas', '1 / 2', `${name}: Sketch`);
    await pressed(p.locator('#book .bk-btn[aria-label="The page after"]'), 'the page after');
    await landed(p, 'sketch', 'Shop page', '2 / 2', `${name}: Sketch's page 2`);
    await pressed(p.locator('#book .bk-where'), 'the page count');
    await pressed(p.locator('#book .bk-pages-menu [role=menuitem]').filter({ hasText: /^1Ideas$/ }), 'a page listed');
    await landed(p, 'sketch', 'Ideas', '1 / 2', `${name}: Ideas chosen from the list`);
    // (All pages may be folded into More: pressed as a click on it)
    await p.locator(`#book .bk-bar .bk-btn[aria-label="${OVERVIEW}"]`).dispatchEvent('click');
    const [shown] = await afterPress(p, 1, `${name}: All pages`);
    assert.ok(shown < AT_ONCE_MS, `${name}: All pages: heard at once (${shown} ms)`);
    const tile = p.getByRole('list', { name: 'The overview' }).locator('.bk-far-chapter .bk-tile').first();
    await tile.waitFor({ timeout: LOADED_MS });
    await until(async () => (await p.locator('#book .bk-turn-leaf').count()) === 0, `${name}: the leaf landed`);
    await pressed(tile.locator('.bk-tile-open'), "a page's tile");
    await landed(p, 'sketch', 'Ideas', '1 / 2', `${name}: Ideas opened from All pages`);
    await pressed(p.locator('#book .bk-more'), 'the dots');
    await pressed(
      p.locator('#book .bk-more-card').getByRole('menuitem', { name: 'Archive this page', exact: true }),
      'Archive this page',
    );
    // (the press and the crunch at once, then the ball landing out of sight below)
    const sounds = await afterPress(p, 3, `${name}: the page archived`);
    assert.ok(sounds.filter(s => s < AT_ONCE_MS).length >= 2, `${name}: pressed and crumpled at once (${sounds})`);
    assert.ok(
      sounds.some(s => s >= FALLEN_MS[0] && s <= FALLEN_MS[1]),
      `${name}: the fallen ball heard landing within two seconds (${sounds})`,
    );
    await c.shot(`presses-${name}`, p);
  });
