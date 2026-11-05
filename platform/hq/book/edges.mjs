// book-check.mjs's story of the page to every edge (the Ink README, "The book's frame"; shell/ink/bookdesk.css,
// bookview.js, bookrow.js), at realbook.mjs's sizes with their blur: an iPhone upright and an iPad on its side. On a
// sketch page:
//   - every point of the paper is the page's but where a control is;
//   - the page's corner is its top-left: on a fresh page, panned as far up and left as it goes, at any zoom, the
//     page's corner stays at the paper's left, set down just below the blur, where the view's title lies;
//   - the page is one surface: zoomed, the strip under the blur is the page whose dots zoom with it.
// (A page of scraps takes no ink of its own, so nothing is drawn under the blur, beside the tools or under the bar:
// ink is on an opened scrap, the Ink README's A page of scraps.)
// Recorded with --shots.
import assert from 'node:assert/strict';
import { middleOf, toChapter, until } from './kit.mjs';
import { SIZES, opened } from './realbook.mjs';

// how near (screen px) a place counts as there
const NEAR = 1.5;

// c: book-check.mjs's hqIn, base, settled, shot, noErrorsIn
export function edgeStories(c) {
  return {
    "the page to every edge on an iPhone: the paper the page's or a control's, its corner the top-left, one zooming surface":
      browser => edges(browser, c, 'iphone'),
    "the page to every edge on an iPad on its side: the paper the page's or a control's, its corner the top-left, one zooming surface":
      browser => edges(browser, c, 'ipad'),
  };
}

async function edges(browser, c, name) {
  const size = SIZES[name],
    { context, p, errors } = await opened(browser, c, name, size);
  try {
    await toChapter(p, 'sketch');
    await until(() => p.evaluate(cornerShown), `${name}: the sketch page`);
    await p.waitForFunction(() => !document.querySelector('#book .bk-turn-picture, #book .bk-turn-leaf'));
    const missed = await p.evaluate(notPage);
    assert.deepEqual(missed, [], `${name}: every point of the paper is the page's or a control's`);
    await corner(p, name, size);
    await c.shot(`edges-${name}-corner`, p);
    await oneSurface(p, name, size);
    await c.shot(`edges-${name}-zoomed`, p);
    c.noErrorsIn(errors);
  } catch (e) {
    await c.shot(`edges-${name}-failed`, p);
    throw e;
  } finally {
    await context.close();
  }
}

// Zoomed in about the page's middle (a trackpad's pinch), the strip under the blur is the page, its dots drawn to the
// zoom. (In: a page of scraps zooms out no further than its fit, an iPad's 1.)
async function oneSurface(p, name, { sat = 0 }) {
  await wheel(p, await middleOfPage(p), { deltaY: -240, ctrlKey: true });
  const seen = await p.evaluate(surfaceAt, Math.max(1, sat / 2));
  assert.ok(seen.page, `${name}: the strip under the blur is the page (${seen.under})`);
  assert.ok(seen.scale > 1.05, `${name}: the page zoomed in (${seen.scale})`);
  assert.ok(Math.abs(seen.dots - 22 * seen.scale) < 0.01, `${name}: the dots there zoom with it (${seen.dots} px)`);
}

// Panned as far up and left as it goes, zoomed out, then in: the page's corner at the paper's left, set down just below
// the blur, every time
async function corner(p, name, { sat = 0 }) {
  const middle = await middleOfPage(p);
  for (const [zoom, deltaY] of [
    ['as it is', 0],
    ['zoomed out', 400],
    ['zoomed in', -900],
  ]) {
    if (deltaY) await wheel(p, middle, { deltaY, ctrlKey: true });
    await wheel(p, middle, { deltaX: -3000, deltaY: -3000 });
    const { left, top, paper } = await p.evaluate(cornerShown);
    assert.ok(Math.abs(left - paper) <= NEAR, `${name}, ${zoom}: the corner at the paper's left (${left}, ${paper})`);
    assert.ok(Math.abs(top - sat) <= NEAR, `${name}, ${zoom}: the corner set down below the blur (${top}, ${sat})`);
  }
}

// The middle of the page shown (beside HQ's page on an iPad on its side)
const middleOfPage = async p => middleOf(await p.locator('#book .bk-desk').boundingBox());
// A wheel at a point on the screen (with ctrlKey: a trackpad's pinch), as the browser sends it to what's there
const wheel = (p, [x, y], more) =>
  p.evaluate(
    ({ x, y, more }) =>
      document
        .elementFromPoint(x, y)
        .dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, bubbles: true, cancelable: true, ...more })),
    { x, y, more },
  );

// (each function below runs in the page, with page.evaluate, so it names what it reads itself.)
// The shown page's corner, its 0,0: where it is on the screen, and the paper's left; null before it shows
function cornerShown() {
  const shown = document.querySelector('#book .bk-page:not([hidden])'),
    desk = document.querySelector('#book .bk-desk');
  if (!shown?.getBoundingClientRect().width) return null;
  const r = shown.getBoundingClientRect();
  return { left: r.left, top: r.top, paper: desk.getBoundingClientRect().left };
}
// Every 8 px of the book's paper that isn't the page or a control: an island, the Undo pill, a bookmark, the pull tab,
// the cover's edge, the open asks' counter (a few, for the message).
function notPage() {
  const paper = document.querySelector('#book .bk-paper').getBoundingClientRect(),
    missed = [];
  for (let y = 0; y < paper.bottom && missed.length < 6; y += 8)
    for (let x = Math.max(0, paper.left); x < Math.min(innerWidth, paper.right) && missed.length < 6; x += 8) {
      const el = document.elementFromPoint(x, y);
      if (
        !el?.closest(
          '#book :is(.bk-desk, .bk-strip, .bk-bar, .bk-undo-pill, .bk-marks, .bk-lip, .bk-edge, .bk-for-you-count)',
        )
      )
        missed.push(`${x},${y}: ${el?.className || el?.tagName}`);
    }
  return missed;
}
// What's a third of the way across the book's paper, y px down: whether it's the page, what it is, the page's zoom,
// and how far apart its dots are there
function surfaceAt(y) {
  const paper = document.querySelector('#book .bk-paper').getBoundingClientRect(),
    el = document.elementFromPoint(paper.left + paper.width / 3, y),
    desk = el?.closest('#book .bk-desk');
  return {
    page: !!desk,
    under: el?.className || el?.tagName,
    scale: parseFloat(desk?.style.getPropertyValue('--bk-scale')) || 1,
    dots: desk && parseFloat(getComputedStyle(desk).backgroundSize),
  };
}
