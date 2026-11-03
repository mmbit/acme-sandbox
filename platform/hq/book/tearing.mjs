// How book-check.mjs's stories tear a page off at its spine (shell/ink/booktear.js) with a mouse, a finger or the
// Pencil, and open its targets from the bar's dots; and the story of the presses at the spine that aren't a tear.
// (the blur)
import assert from 'node:assert/strict';
import { inputs } from './hands.mjs';
import { QUIET_MS, UPRIGHT } from './kit.mjs';
import { blurred } from './islands.mjs';
import { restsOpen, watchedPage } from './start.mjs';
import { en } from '../shell/ink/notebookwordsen.js';

// a home-screen app's blurred band at the top (style.css's standalone --sat)
const SAT_PX = 48;

// On the board's iPad held upright, the book spread over HQ and a home-screen app's blur at the top: the Pencil and a
// finger moved down the spine, and a finger pressed at the spine under the blur or on a tool and drawn to the left,
// tear nothing; drawn to the left from the spine below them, the page comes off
export async function notATearStory(browser, c) {
  const context = await c.hqIn(browser, UPRIGHT, { hasTouch: true });
  await blurred(context, { sat: SAT_PX });
  const { page, errors } = await watchedPage(context);
  try {
    await page.goto(`${c.base}/?intro=0`);
    await restsOpen(page, c, UPRIGHT);
    const hand = await inputs(browser, page),
      [x, y] = await spineOf(page);
    await watchTears(page);
    await hand.stroke('pen', [
      [x, y],
      [x - 3, y + 50],
      [x - 6, y + 120],
    ]);
    await hand.stroke('touch', [
      [x, y + 130],
      [x - 4, y + 260],
    ]);
    await hand.stroke('touch', [
      [x, SAT_PX / 2],
      [x - 160, SAT_PX / 2 + 10],
    ]);
    const key = await page.evaluate(() => {
      const tools = [...document.querySelectorAll('#book .bk-strip .bk-island button')],
        r = tools.find(b => b.offsetParent).getBoundingClientRect();
      return [r.right - 4, r.top + r.height / 2];
    });
    await hand.stroke('touch', [key, [key[0] - 160, key[1] + 10]]);
    await page.waitForTimeout(QUIET_MS);
    assert.equal(await page.evaluate(() => window.__tore), false, 'nothing torn off');
    await c.shot('share-not-a-tear', page);
    await dragTo(page, 'touch', null);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

// The page torn off at its spine and let go on a target ('submit' | 'pdf' | 'png', or a place by its selector: the
// call's window), or off them all (null): with 'mouse', or a 'touch' finger or the 'pen' (hands.mjs: the browser's
// own in Chromium). held: done while the page is in hand over its target.
export async function dragTo(page, how, kind, held = async () => {}) {
  const from = await spineOf(page),
    peeled = [from[0] - 60, from[1] + 12],
    hand = await handOf(page, how, from);
  await hand.move(peeled);
  await page.locator('#book .bk-share[data-mode=carrying]').waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('#book > .bk-held').count(), 1, 'the page in hand');
  // (the targets come in moving: aimed at where they stay)
  await page
    .locator('#book .bk-share')
    .evaluate(row => Promise.all(row.getAnimations({ subtree: true }).map(a => a.finished)));
  const shareKind = ['submit', 'pdf', 'png'].includes(kind),
    target = kind && (await page.locator(shareKind ? `#book .bk-share [data-share=${kind}]` : kind).boundingBox()),
    to = target ? [target.x + target.width / 2, target.y + target.height / 2] : [peeled[0] - 300, peeled[1] + 400];
  await hand.move(to);
  // (lit under it: a finger's last moves reach the page a frame later)
  if (shareKind) await page.locator(`#book .bk-share [data-share=${kind}][data-over]`).waitFor({ timeout: 5000 });
  await held();
  await hand.up(to);
}
// A hand pressed at a point: the mouse, or a finger or the Pencil held across awaits
async function handOf(page, how, at) {
  if (how !== 'mouse') return (await inputs(page.context().browser(), page)).hold(how, at);
  await page.mouse.move(...at);
  await page.mouse.down();
  return { move: to => page.mouse.move(...to, { steps: 10 }), up: () => page.mouse.up() };
}
// A point at the page's right edge, where the spine is, as near the top of the page as a hand would press there: below
// the status bar's blur, on the page and not on a control or anything over it. Once nothing's turning (a turn's picture
// of the page is over it), and the page can be torn (booktear.js mounted after the first page: its row in the dots'
// menu, there for a page not yet sent).
export async function spineOf(page) {
  await page.waitForFunction(
    () =>
      document.querySelector('#book .bk-tear') &&
      [...document.querySelectorAll('#book .bk-turn-picture')].every(p => p.closest('.bk-held')),
    null,
    { timeout: 10_000 },
  );
  const at = await page.evaluate(() => {
    const paper = document.querySelector('#book .bk-paper').getBoundingClientRect(),
      desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
      x = Math.min(paper.right, innerWidth) - 8;
    for (let y = desk.top + 40; y < desk.bottom; y += 8) {
      const under = document.elementFromPoint(x, y);
      if (under?.closest('#book .bk-leaf') && !under.closest('.bk-controls > *, button, a, input, [contenteditable]'))
        return [x, y];
    }
    return null;
  });
  assert.ok(at, 'a place to press at the spine');
  return at;
}
// The targets while the page is carried: whether they lie over the paper in view, and the islands still showing
export const targetsShown = page =>
  page.evaluate(() => {
    const box = el => el.getBoundingClientRect(),
      targets = box(document.querySelector('#book .bk-share')),
      paper = box(document.querySelector('#book .bk-pages'));
    return {
      overPaper:
        targets.left >= Math.max(0, paper.left) &&
        targets.right <= Math.min(innerWidth, paper.right) &&
        targets.top >= Math.max(0, paper.top) &&
        targets.bottom <= Math.min(innerHeight, paper.bottom),
      islands: [...document.querySelectorAll('#book .bk-island')]
        .filter(el => box(el).width && el.checkVisibility({ visibilityProperty: true }))
        .map(el => el.dataset.island),
    };
  });
// Whether a page comes off from now on: window.__tore once the page is in hand or the targets show
const watchTears = page =>
  page.evaluate(() => {
    window.__tore = false;
    const torn = () => !!document.querySelector('#book > .bk-held, #book .bk-controls[data-targets]');
    new MutationObserver(() => (window.__tore ||= torn())).observe(document.getElementById('book'), {
      childList: true,
      subtree: true,
      attributeFilter: ['data-targets'],
    });
  });
// The bar's dots opened and their Tear off and send pressed (press: 'click', or 'tap' with a finger): the targets as a
// menu
export async function tearOffMenu(page, press = 'click') {
  await page.locator('#book .bk-more')[press]();
  await page.locator('#book .bk-more-card').getByRole('menuitem', { name: en.tearOff })[press]();
  const menu = page.getByRole('menu', { name: 'Where this page goes' });
  await menu.waitFor({ timeout: 10_000 });
  return menu;
}
