// book-check.mjs's story of the page arrows staying within the tab (shell/ink/bookcontrols.js), on journal.mjs's
// My journal (two sketch pages, its Asks page, twenty calls): on an iPad mini with touch, on its side and upright, and on
// a desktop, the book opens on the last call's page (20 / 20), where the page after is off and a press on it stays
// there; the page before turns to the 19th; on Asks 1 / 1 both are off; on Sketch 1 / 2 the page before is off, the page
// after turns to 2 / 2, and there it's off and a press stays on Sketch 2 / 2, never turning on into Asks or Calls. An
// arrow that's off looks it.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, OVERVIEW, UPRIGHT, pressAlong, until } from './kit.mjs';
import { CALLS, SEED, landed, onJournal } from './journal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function pageArrowsStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    'the page arrows stay within the tab, on an iPad mini on its side: off at Sketch 2 / 2, Asks and Calls 20 / 20':
      browser => within(browser, c, MINI, 'mini', touch),
    'the page arrows stay within the tab, on an iPad mini upright: off at Sketch 2 / 2, Asks and Calls 20 / 20':
      browser => within(browser, c, UPRIGHT, 'mini-upright', touch),
    'the page arrows stay within the tab, on a desktop: off at Sketch 2 / 2, Asks and Calls 20 / 20': browser =>
      within(browser, c, DESKTOP, 'desktop', mouse),
    "every tap on a page arrow turns a page, a finger's and a pen's quick ones too, the bar unmoved on a locked page and an open one, on an iPad mini on its side":
      browser => tapsTurn(browser, c, MINI, 'mini'),
    "every tap on a page arrow turns a page, a finger's and a pen's quick ones too, the bar unmoved on a locked page and an open one, on an iPad mini upright":
      browser => tapsTurn(browser, c, UPRIGHT, 'mini-upright'),
  };
}

// Quick taps on the page before from Calls' last page, a finger's then a pen's (a pen's tap is its press and lift
// alone: Safari makes no click of some taps), each a page; the bar's box where it was on each page turned
// to, on Sketch's open page as on a call's locked one (Undo and Redo on neither: an opened scrap's.
const FINGER_TAPS = 4,
  PEN_TAPS = 3;
// (Calls 14 to 16 sent on, read-only: the finger's taps end on one)
const LOCKED = [14, 16];
const tapsTurn = (browser, c, viewport, name) =>
  onJournal(browser, c, { viewport, name, options: lockedJournal(), story: 'pagearrows' }, async (p, { tab }) => {
    await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
    await p.waitForTimeout(1500); // (the book opened and still)
    const bars = [await barOf(p, `Call ${CALLS}`)],
      at = await arrow(p, 'The page before').boundingBox(),
      [x, y] = [at.x + at.width / 2, at.y + at.height / 2];
    for (let i = 0; i < FINGER_TAPS; i++) await p.touchscreen.tap(x, y);
    let n = CALLS - FINGER_TAPS;
    await landed(
      p,
      'calls',
      `Call ${n}`,
      `${n} / ${CALLS}`,
      `${name}: ${FINGER_TAPS} quick finger taps, as many pages`,
    );
    bars.push(await barOf(p, `Call ${n}`));
    await c.shot(`pagearrows-${name}-locked`, p);
    for (let i = 0; i < PEN_TAPS; i++) await pressAlong(p, [[x, y]], { type: 'pen' });
    n -= PEN_TAPS;
    await landed(p, 'calls', `Call ${n}`, `${n} / ${CALLS}`, `${name}: ${PEN_TAPS} quick pen taps, as many pages`);
    bars.push(await barOf(p, `Call ${n}`));
    await c.shot(`pagearrows-${name}-call`, p);
    await tab('sketch');
    await landed(p, 'sketch', 'Ideas', '1 / 2', `${name}: Sketch`);
    bars.push(await barOf(p, 'Ideas'));
    await c.shot(`pagearrows-${name}-sketch`, p);
    for (const b of bars) assert.deepEqual(b.box, bars[0].box, `${name}: the bar on ${b.page} where it was`);
    await overview(p, c, name);
  });
// The overview: all the pages already, no bar and no All pages on it; its page's tile opens the page
async function overview(p, c, name) {
  await p.locator(`#book .bk-bar .bk-btn[aria-label="${OVERVIEW}"]`).tap();
  await p.locator('#book[data-far]').waitFor({ state: 'attached', timeout: 5000 });
  const tile = p.locator('#book .bk-tile[aria-current="page"] .bk-tile-open').first();
  await tile.waitFor({ timeout: 10_000 });
  await p.waitForTimeout(800);
  await c.shot(`pagearrows-${name}-overview`, p);
  const keys = await p.evaluate(
    () => [...document.querySelectorAll('#book .bk-bar .bk-btn')].filter(b => b.checkVisibility()).length,
  );
  assert.equal(keys, 0, `${name}: the overview with no bar`);
  await tile.tap();
  await landed(p, 'sketch', 'Ideas', '1 / 2', `${name}: Ideas again from its tile`);
}
// My journal on a touch screen, Calls 14 to 16 locked
const lockedJournal = () => {
  const notebooks = structuredClone(SEED);
  for (const page of notebooks.pages.filter(pg => pg.kind === 'call').slice(LOCKED[0] - 1, LOCKED[1])) page.send_at = 1;
  return { hasTouch: true, notebooks };
};
// The bar's box on the screen (px), page named
const barOf = (p, page) =>
  p.evaluate(page => ({ page, box: document.querySelector('#book .bk-bar').getBoundingClientRect().toJSON() }), page);

const within = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'pagearrows' }, (p, { press, tab: pick }) =>
    walk(p, c, name, { press, pick, touch: options.hasTouch }),
  );

// The last call's page (20 / 20), back to 19, Asks, then Sketch 1 / 2 on to 2 / 2: at each, which arrows are off, and a
// press on one that's off turning nothing
async function walk(p, c, name, { press, pick, touch }) {
  const arrows = { before: arrow(p, 'The page before'), after: arrow(p, 'The page after') };
  const tab = async (chapter, title, where) => {
    await pick(chapter);
    await landed(p, chapter, title, where, `${name}: ${chapter} on ${title}`);
  };
  await landed(p, 'calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`, `${name}: the book opens on Calls' last page`);
  await off(arrows, { before: false, after: true }, `${name}: Calls ${CALLS}/${CALLS}`);
  await pressedOff(p, arrows.after, touch, ['calls', `Call ${CALLS}`, `${CALLS} / ${CALLS}`], `${name}: Calls' last`);
  await press(arrows.before);
  await landed(p, 'calls', `Call ${CALLS - 1}`, `${CALLS - 1} / ${CALLS}`, `${name}: Calls turned back a page`);
  await tab('asks', 'Asks', '1 / 1');
  await off(arrows, { before: true, after: true }, `${name}: Asks 1 / 1`);
  await tab('sketch', 'Ideas', '1 / 2');
  await off(arrows, { before: true, after: false }, `${name}: Sketch 1 / 2`);
  await press(arrows.after);
  await landed(p, 'sketch', 'Shop page', '2 / 2', `${name}: Sketch turned on to its page 2`);
  await off(arrows, { before: false, after: true }, `${name}: Sketch 2 / 2`);
  await c.shot(`pagearrows-${name}-sketch-last`, p);
  await pressedOff(p, arrows.after, touch, ['sketch', 'Shop page', '2 / 2'], `${name}: Sketch's last`);
}
// (on the bar along the foot, either side of the count)
const arrow = (p, label) => p.locator(`#book .bk-bar [data-island=pages] .bk-btn[aria-label="${label}"]`);
// Which arrows are off (want: { before, after }), each off one dimmed
async function off(arrows, want, what) {
  const word = way => (want[way] ? 'off' : 'on');
  await until(
    async () => (await arrows.before.isDisabled()) === want.before && (await arrows.after.isDisabled()) === want.after,
    `${what}: the page before ${word('before')}, the page after ${word('after')}`,
  );
  for (const [way, loc] of Object.entries(arrows))
    if (want[way]) {
      const opacity = await loc.evaluate(el => Number(getComputedStyle(el).opacity));
      assert.ok(opacity < 0.6, `${what}: the page ${way} looks off (opacity ${opacity})`);
    }
}
// A press where an arrow that's off is, as the board's finger or mouse would: nothing turns, still on [chapter, title,
// where]
async function pressedOff(p, loc, touch, [chapter, title, where], what) {
  const box = await loc.boundingBox();
  assert.ok(box, `${what}: the page after on the bar`);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await (touch ? p.touchscreen.tap(x, y) : p.mouse.click(x, y));
  await p.waitForTimeout(1500);
  await landed(p, chapter, title, where, `${what}: a press on the page after there, still on ${title}`);
}
