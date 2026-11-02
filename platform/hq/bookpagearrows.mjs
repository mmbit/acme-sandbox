// book-check.mjs's story of the page arrows staying within the tab (shell/ink/bookcontrols.js), on bookjournal.mjs's
// My journal (two sketch pages, its Asks page, twenty calls): on an iPad mini with touch, on its side and upright, and on
// a desktop, the book opens on Calls 20/20, where the page after is off and a press on it stays there; the page before
// turns to Call 19; on Asks 1/1 both are off; on Sketch 1/2 the page before is off, the page after turns to 2/2, and
// there it's off and a press stays on Sketch 2/2, never turning on into Asks or Calls (board, call 178). An arrow that's
// off looks it.
import assert from 'node:assert/strict';
import { DESKTOP, MINI, UPRIGHT, until } from './bookkit.mjs';
import { CALLS, landed, onJournal } from './bookjournal.mjs';

// c: book-check.mjs's hqIn, base, shot, noErrorsIn
export function pageArrowsStories(c) {
  const touch = { hasTouch: true },
    mouse = { hasTouch: false, isMobile: false, deviceScaleFactor: 1 };
  return {
    'the page arrows stay within the tab, on an iPad mini on its side: off at Sketch 2/2, Asks and Calls 20/20':
      browser => within(browser, c, MINI, 'mini', touch),
    'the page arrows stay within the tab, on an iPad mini upright: off at Sketch 2/2, Asks and Calls 20/20': browser =>
      within(browser, c, UPRIGHT, 'mini-upright', touch),
    'the page arrows stay within the tab, on a desktop: off at Sketch 2/2, Asks and Calls 20/20': browser =>
      within(browser, c, DESKTOP, 'desktop', mouse),
  };
}

const within = (browser, c, viewport, name, options) =>
  onJournal(browser, c, { viewport, name, options, story: 'pagearrows' }, (p, { press }) =>
    walk(p, c, name, { press, touch: options.hasTouch }),
  );

// Calls 20/20, back to 19, Asks, then Sketch 1/2 on to 2/2: at each, which arrows are off, and a press on one that's
// off turning nothing
async function walk(p, c, name, { press, touch }) {
  const arrows = { before: arrow(p, 'The page before'), after: arrow(p, 'The page after') };
  const tab = async (chapter, title, where) => {
    await press(p.locator(`#book .bk-marks [data-chapter=${chapter}]`));
    await landed(p, chapter, title, where, `${name}: ${chapter} on ${title}`);
  };
  await landed(p, 'calls', `Call ${CALLS}`, `${CALLS}/${CALLS}`, `${name}: the book opens on Calls' last page`);
  await off(arrows, { before: false, after: true }, `${name}: Calls ${CALLS}/${CALLS}`);
  await pressedOff(p, arrows.after, touch, ['calls', `Call ${CALLS}`, `${CALLS}/${CALLS}`], `${name}: Calls' last`);
  await press(arrows.before);
  await landed(p, 'calls', `Call ${CALLS - 1}`, `${CALLS - 1}/${CALLS}`, `${name}: Calls turned back a page`);
  await tab('asks', 'Asks', '1/1');
  await off(arrows, { before: true, after: true }, `${name}: Asks 1/1`);
  await tab('sketch', 'Ideas', '1/2');
  await off(arrows, { before: true, after: false }, `${name}: Sketch 1/2`);
  await press(arrows.after);
  await landed(p, 'sketch', 'Shop page', '2/2', `${name}: Sketch turned on to its page 2`);
  await off(arrows, { before: false, after: true }, `${name}: Sketch 2/2`);
  await c.shot(`pagearrows-${name}-sketch-last`, p);
  await pressedOff(p, arrows.after, touch, ['sketch', 'Shop page', '2/2'], `${name}: Sketch's last`);
}
const arrow = (p, label) => p.locator(`#book .bk-btn[aria-label="${label}"]`);
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
  assert.ok(box, `${what}: the page after on the rail`);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await (touch ? p.touchscreen.tap(x, y) : p.mouse.click(x, y));
  await p.waitForTimeout(1500);
  await landed(p, chapter, title, where, `${what}: a press on the page after there, still on ${title}`);
}
